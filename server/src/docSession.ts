import {
  apply,
  baseLength,
  diffToOp,
  isNoop,
  mapPosition,
  transform,
  type Op,
} from '../../shared/ot'
import type {
  Annotation,
  AnnChangeSummary,
  LogEntry,
  Role,
  UserInfo,
  VersionMeta,
  VersionSnapshot,
  VersionSource,
} from '../../shared/protocol'
import { canAnnotate, canEdit, canManageHistory } from '../../shared/protocol'

/** 内存中近期操作日志保留长度：超出后落后太多的客户端只能走全量快照回滚 */
export const LOG_LIMIT = 1000
/** 内存中归档操作日志上限（归档文件不受此限制，仅约束常驻内存） */
const ARCHIVE_LIMIT = 10_000
/** 每累计多少次正文编辑自动落一个版本快照 */
export const AUTO_SNAPSHOT_INTERVAL = 20
/** 批注活动（增/回/解决/删除）后防抖落快照的时间 */
const ANN_SNAPSHOT_DEBOUNCE_MS = 2000
/** 版本历史保留上限（最旧的版本会被修剪；初始基线版本始终保留） */
export const MAX_VERSIONS = 200

const COLORS = [
  '#f56c6c',
  '#e6a23c',
  '#67c23a',
  '#409eff',
  '#9b59b6',
  '#16a085',
  '#d35400',
  '#2c3e50',
]

function emptyAnnCounters(): AnnChangeSummary {
  return { added: 0, replied: 0, resolved: 0, reopened: 0, deleted: 0 }
}

function hasAnnChanges(c: AnnChangeSummary): boolean {
  return c.added + c.replied + c.resolved + c.reopened + c.deleted > 0
}

export interface ClientState {
  clientId: string
  name: string
  role: Role
  color: string
  cursor: { start: number; end: number } | null
  send: (msg: object) => void
}

export class DocSession {
  readonly docId: string
  doc: string
  revision = 0
  /** 广播序号：客户端用它检测消息丢失（cursor/presence 等易失消息不计入） */
  seq = 0
  /**
   * 近期操作日志（环形窗口，供断线增量补齐）。
   * 与 archive 的区别：log 只留最近 LOG_LIMIT 条且常驻内存；archive 全量持久化。
   */
  log: LogEntry[] = []
  /** 全量操作归档（内存视图，重启后从归档文件重建；同时承载版本摘要统计） */
  archive: LogEntry[] = []
  annotations = new Map<string, Annotation>()
  clients = new Map<string, ClientState>()
  /**
   * 版本纪元：每次版本恢复 +1。客户端 join 时获得当前 epoch 并随 op 回传，
   * 纪元不匹配的提交一律拒绝，从根本上阻止旧客户端基于过期版本提交。
   */
  epoch = 0
  /** 版本快照元数据时间线（按 revision 升序，完整内容按需经 loader 读取） */
  versions: VersionMeta[] = []

  /** 已接受的 opId 集合（幂等去重：ack 丢失导致客户端重发时不重复应用） */
  private acceptedOpIds = new Set<string>()
  private acceptedOpIdQueue: string[] = []
  private colorIdx = 0
  /** 自上一版本快照以来的正文编辑条数与批注变化计数 */
  private editsSinceSnapshot = 0
  private annCounters = emptyAnnCounters()
  /** 上一版本快照落定时刻归档数组的长度（切片统计摘要的边界） */
  private archiveCountAtSnapshot = 0
  private annSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  /** 本进程内创建/读取过的快照内容缓存（历史版本不可变，缓存安全） */
  private snapshotCache = new Map<string, VersionSnapshot>()

  /** 数据变更回调（当前快照防抖写盘） */
  onDirty: (() => void) | null = null
  /** 新操作提交回调（追加写入归档 JSONL，使操作日志在重启后不丢失） */
  onArchiveEntries: ((entries: LogEntry[]) => void) | null = null
  /** 新版本快照创建回调（写不可变快照文件 + 版本索引） */
  onVersionCreated: ((snap: VersionSnapshot) => void) | null = null
  /** 旧版本被修剪回调（清理快照文件） */
  onVersionDeleted: ((versionId: string) => void) | null = null
  /** 快照内容惰性加载器（重启后读取历史快照文件） */
  snapshotLoader: ((versionId: string) => VersionSnapshot | null) | null = null

  constructor(docId: string, initialDoc = '') {
    this.docId = docId
    this.doc = initialDoc
  }

  private dirty() {
    this.onDirty?.()
  }

  addClient(clientId: string, name: string, role: Role, send: (msg: object) => void): ClientState {
    const state: ClientState = {
      clientId,
      name: name.slice(0, 24) || '匿名',
      role,
      color: COLORS[this.colorIdx++ % COLORS.length],
      cursor: null,
      send,
    }
    this.clients.set(clientId, state)
    return state
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId)
  }

  users(): UserInfo[] {
    return [...this.clients.values()].map((c) => ({
      clientId: c.clientId,
      name: c.name,
      role: c.role,
      color: c.color,
    }))
  }

  /** 向除 exclude 外的所有客户端广播 */
  broadcast(msg: object, exclude?: string) {
    for (const c of this.clients.values()) {
      if (c.clientId === exclude) continue
      c.send(msg)
    }
  }

  broadcastAll(msg: object) {
    this.broadcast(msg)
  }

  /**
   * 处理客户端提交的编辑操作。
   * 返回 null 表示成功；否则返回错误码与信息。
   */
  receiveOp(
    client: ClientState,
    revision: number,
    op: Op,
    opId: string,
    epoch: number,
  ): { code: 'PERMISSION_DENIED' | 'BAD_REVISION' | 'RESYNC_REQUIRED'; message: string; epoch?: number } | null {
    if (!canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无编辑权限' }
    }
    // 纪元防护：文档被恢复到历史版本后，基于旧纪元的提交一律拒绝
    if (epoch !== this.epoch) {
      return {
        code: 'RESYNC_REQUIRED',
        message: '文档刚被恢复到历史版本，本地版本已过期，请重新同步后再编辑',
        epoch: this.epoch,
      }
    }
    // 幂等：该操作已被接受过（ack 丢失后客户端重发）→ 直接重新确认，不重复应用
    if (this.acceptedOpIds.has(opId)) {
      client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
      return null
    }
    if (typeof revision !== 'number' || revision > this.revision || revision < 0) {
      return { code: 'RESYNC_REQUIRED', message: '版本号异常，请重新同步' }
    }
    const backlog = this.revision - revision
    if (backlog > this.log.length) {
      // 客户端落后太多，日志已不足以做变换，只能全量重同步
      return { code: 'RESYNC_REQUIRED', message: '本地版本过旧，需要全量重同步' }
    }
    // 校验操作基准长度与该版本文档长度一致
    const lenAt = backlog === 0 ? this.doc.length : this.log[this.log.length - backlog].lenBefore
    if (baseLength(op) !== lenAt) {
      return { code: 'BAD_REVISION', message: '操作与基准版本不匹配' }
    }

    // 针对客户端落后期间已被接受的并发操作逐个做 OT 变换
    let transformed = op
    for (let i = this.log.length - backlog; i < this.log.length; i++) {
      transformed = transform(transformed, this.log[i].op)
    }

    const entry = this.commitEntry(transformed, opId, client, 'edit')
    // 先确认发起者，再广播给其他人（ack 与广播共用同一 seq，保证序号流一致）
    client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
    this.broadcast(
      {
        type: 'op',
        revision: entry.revision,
        op: transformed,
        opId,
        clientId: client.clientId,
        authorName: client.name,
        seq: this.seq,
      },
      client.clientId,
    )
    return null
  }

  /** 将一个已定型的操作提交进文档：推进文档/版本/日志/归档/seq，并维护自动快照 */
  private commitEntry(
    transformed: Op,
    opId: string,
    author: { clientId: string; name: string },
    kind: 'edit' | 'restore',
    restoreFrom?: string,
  ): LogEntry {
    const entry: LogEntry = {
      revision: this.revision,
      op: transformed,
      opId,
      clientId: author.clientId,
      authorName: author.name,
      lenBefore: this.doc.length,
      kind,
      timestamp: Date.now(),
    }
    if (restoreFrom) entry.restoreFrom = restoreFrom
    if (!isNoop(transformed)) {
      this.doc = apply(this.doc, transformed)
      this.transformAnnotations(transformed)
    }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
    // 运行期保留完整归档（重启后仅从磁盘加载尾部 ARCHIVE_LIMIT 条）：
    // 版本摘要依赖稳定的数组下标切片，运行期截断会使历史窗口错位
    this.archive.push(entry)
    this.acceptedOpIds.add(opId)
    this.acceptedOpIdQueue.push(opId)
    if (this.acceptedOpIdQueue.length > LOG_LIMIT * 2) {
      this.acceptedOpIds.delete(this.acceptedOpIdQueue.shift()!)
    }
    this.revision++
    this.seq++
    this.onArchiveEntries?.([entry])

    if (kind === 'edit') {
      this.editsSinceSnapshot++
      if (this.editsSinceSnapshot >= AUTO_SNAPSHOT_INTERVAL) {
        this.createSnapshot('auto')
      }
    }
    this.dirty()
    return entry
  }

  /** 编辑操作后，批注锚点随文档做位置映射 */
  private transformAnnotations(op: Op) {
    for (const ann of this.annotations.values()) {
      ann.start = mapPosition(ann.start, op, 'after')
      ann.end = mapPosition(ann.end, op, 'before')
      if (ann.end < ann.start) ann.end = ann.start
      ann.orphan = ann.start === ann.end
    }
  }

  addAnnotation(
    client: ClientState,
    msg: { annId: string; start: number; end: number; quote: string; text: string },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const start = Math.max(0, Math.min(msg.start, this.doc.length))
    const end = Math.max(start, Math.min(msg.end, this.doc.length))
    if (!msg.text || !msg.text.trim()) {
      return { code: 'BAD_MESSAGE', message: '批注内容不能为空' }
    }
    const ann: Annotation = {
      id: msg.annId,
      start,
      end,
      orphan: start === end,
      quote: (msg.quote || this.doc.slice(start, end)).slice(0, 200),
      authorId: client.clientId,
      authorName: client.name,
      text: msg.text.trim().slice(0, 2000),
      replies: [],
      resolved: false,
      createdAt: Date.now(),
    }
    this.annotations.set(ann.id, ann)
    this.annCounters.added++
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.afterAnnotationChange()
    return null
  }

  replyAnnotation(
    client: ClientState,
    msg: { annId: string; replyId: string; text: string },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const ann = this.annotations.get(msg.annId)
    if (!ann || !msg.text?.trim()) {
      return { code: 'BAD_MESSAGE', message: '批注不存在或内容为空' }
    }
    ann.replies.push({
      id: msg.replyId,
      authorId: client.clientId,
      authorName: client.name,
      text: msg.text.trim().slice(0, 2000),
      createdAt: Date.now(),
    })
    this.annCounters.replied++
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.afterAnnotationChange()
    return null
  }

  resolveAnnotation(
    client: ClientState,
    msg: { annId: string; resolved: boolean },
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    if (!canAnnotate(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无批注权限' }
    }
    const ann = this.annotations.get(msg.annId)
    if (!ann) return { code: 'BAD_MESSAGE', message: '批注不存在' }
    ann.resolved = !!msg.resolved
    if (msg.resolved) this.annCounters.resolved++
    else this.annCounters.reopened++
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.afterAnnotationChange()
    return null
  }

  deleteAnnotation(
    client: ClientState,
    annId: string,
  ): { code: 'PERMISSION_DENIED' | 'BAD_MESSAGE'; message: string } | null {
    const ann = this.annotations.get(annId)
    if (!ann) return { code: 'BAD_MESSAGE', message: '批注不存在' }
    // 仅作者本人或编辑者可删除
    if (ann.authorId !== client.clientId && !canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '仅作者或编辑者可删除批注' }
    }
    this.annotations.delete(annId)
    this.annCounters.deleted++
    this.seq++
    this.broadcastAll({ type: 'ann:delete', annId, seq: this.seq })
    this.afterAnnotationChange()
    return null
  }

  /** 批注活动后防抖落一个版本快照（连续批注合并为同一版本，避免刷屏） */
  private afterAnnotationChange() {
    this.dirty()
    if (this.annSnapshotTimer) return
    this.annSnapshotTimer = setTimeout(() => {
      this.annSnapshotTimer = null
      if (hasAnnChanges(this.annCounters)) this.createSnapshot('auto')
    }, ANN_SNAPSHOT_DEBOUNCE_MS)
  }

  updateCursor(client: ClientState, start: number, end: number) {
    client.cursor = { start, end }
    // 光标消息易失：不计 seq、不持久化，直接转发
    this.broadcast({ type: 'cursor', clientId: client.clientId, start, end }, client.clientId)
  }

  /* ---------------- 版本历史 ---------------- */

  /** 时间线（按 revision/创建时间倒序，最新在前） */
  listVersions(): { versions: VersionMeta[]; currentRevision: number; epoch: number } {
    return {
      versions: [...this.versions].sort((a, b) => b.revision - a.revision || b.createdAt - a.createdAt),
      currentRevision: this.revision,
      epoch: this.epoch,
    }
  }

  /** 取某个版本的完整快照（优先内存缓存，未命中走 loader） */
  getVersion(versionId: string): VersionSnapshot | null {
    const cached = this.snapshotCache.get(versionId)
    if (cached) return cached
    const loaded = this.snapshotLoader?.(versionId) ?? null
    if (loaded) this.snapshotCache.set(versionId, loaded)
    return loaded
  }

  /**
   * 创建版本快照：固化当前正文 + 批注，并汇总相对上一快照的变更摘要。
   * 快照内容一经创建不可变。
   */
  createSnapshot(
    source: VersionSource,
    extra?: {
      restoredFromId?: string
      restoredBy?: { clientId: string; name: string }
      label?: string
    },
  ): VersionSnapshot {
    // 以上一快照落定时刻的归档长度为切片边界（entry.revision 是应用前版本号，
    // 与基线同 revision=0 的第一条编辑不能用 revision 比较区分）
    const windowEntries = this.archive.slice(this.archiveCountAtSnapshot)
    let inserts = 0
    let deletes = 0
    let ops = 0
    const authorMap = new Map<string, string>()
    // 恢复合成操作不计入编辑摘要（恢复版本由 source/restoredBy 单独表达）
    for (const e of windowEntries) {
      if (e.kind === 'restore') continue
      ops++
      for (const c of e.op) {
        if ('insert' in c) inserts += c.insert.length
        else if ('delete' in c) deletes += c.delete
      }
      if (!authorMap.has(e.clientId)) authorMap.set(e.clientId, e.authorName)
    }

    const now = Date.now()
    const meta: VersionMeta = {
      id: `v${this.revision}-${now.toString(36)}`,
      revision: this.revision,
      createdAt: now,
      summary: {
        inserts,
        deletes,
        ops,
        authors: [...authorMap.entries()].map(([clientId, name]) => ({ clientId, name })),
      },
      annotationChanges: { ...this.annCounters },
      source,
      restoredFromId: extra?.restoredFromId,
      restoredBy: extra?.restoredBy,
      label: extra?.label,
    }
    const snap: VersionSnapshot = {
      ...meta,
      doc: this.doc,
      annotations: [...this.annotations.values()].map((a) => structuredClone(a)),
    }

    this.versions.push(meta)
    this.snapshotCache.set(snap.id, snap)
    this.editsSinceSnapshot = 0
    this.annCounters = emptyAnnCounters()
    this.archiveCountAtSnapshot = this.archive.length
    this.onVersionCreated?.(snap)
    this.pruneVersions()
    return snap
  }

  private pruneVersions() {
    // 超出上限时从最旧版本开始修剪（最近 MAX_VERSIONS 个版本始终保留；
    // 最近一次快照不会被删，摘要窗口边界 archiveCountAtSnapshot 始终有效）
    while (this.versions.length > MAX_VERSIONS) {
      const oldest = this.versions.shift()
      if (!oldest) break
      this.snapshotCache.delete(oldest.id)
      this.onVersionDeleted?.(oldest.id)
    }
  }

  /**
   * 将文档恢复到指定历史版本：
   * 1. 校验管理权限与目标版本存在；
   * 2. 纪元 +1（旧客户端的在途提交随后会被拒绝）；
   * 3. 以「当前正文 → 目标正文」的 diff 合成一条 restore 操作并正常提交（版本号继续向前，不回退）；
   * 4. 批注整体替换为目标版本的批注；
   * 5. 落一个 source=restore 的新版本快照；
   * 6. 广播 restore:begin 并对所有在线客户端做全量重同步。
   * 返回新版本元数据；失败返回错误码。
   */
  restoreVersion(
    client: ClientState,
    versionId: string,
  ):
    | { ok: true; version: VersionMeta; beginSeq: number }
    | { ok: false; code: 'PERMISSION_DENIED' | 'VERSION_NOT_FOUND'; message: string } {
    if (!canManageHistory(client.role)) {
      return { ok: false, code: 'PERMISSION_DENIED', message: '仅管理员可恢复历史版本' }
    }
    const target = this.getVersion(versionId)
    if (!target) {
      return { ok: false, code: 'VERSION_NOT_FOUND', message: '目标版本不存在或已被清理' }
    }

    if (this.annSnapshotTimer) {
      clearTimeout(this.annSnapshotTimer)
      this.annSnapshotTimer = null
    }

    // 纪元推进必须先于任何提交：之后到达的旧纪元 op 一律拒绝
    this.epoch++

    // 正文：合成「当前 → 目标」的操作（不回退 revision，历史可继续向前追溯）
    const restoreOp = diffToOp(this.doc, target.doc)
    const opId = `restore-${this.epoch}-${this.revision}`
    this.commitEntry(
      restoreOp,
      opId,
      { clientId: client.clientId, name: client.name },
      'restore',
      versionId,
    )

    // 批注：整体回到目标版本（位置随目标正文天然自洽）
    this.annotations = new Map(target.annotations.map((a) => [a.id, structuredClone(a)]))
    // 批注被整体替换，挂起的增量计数不应计入恢复版本摘要
    this.annCounters = emptyAnnCounters()

    // 恢复产生的新版本（commitEntry 内部的自动快照判断只针对 edit，这里显式落快照）
    const snap = this.createSnapshot('restore', {
      restoredFromId: target.id,
      restoredBy: { clientId: client.clientId, name: client.name },
    })

    // 广播恢复开始。恢复合成操作在 commitEntry 中已推进一个 seq（该操作不单独广播），
    // restore:begin 正好占用该序号槽位；welcome 全量快照以同一 seq 为新基线，
    // 避免客户端在两条消息之间检测到序号空洞而误触发增量重同步。
    const beginSeq = this.seq
    this.broadcastAll({
      type: 'restore:begin',
      fromVersionId: target.id,
      by: { clientId: client.clientId, name: client.name },
      seq: beginSeq,
    })
    this.forceResyncAll()
    this.dirty()
    return { ok: true, version: snap, beginSeq }
  }

  /** 向所有在线客户端下发当前状态的全量快照（恢复后强制全量重同步） */
  forceResyncAll() {
    for (const c of this.clients.values()) {
      c.send({
        type: 'welcome',
        clientId: c.clientId,
        docId: this.docId,
        revision: this.revision,
        doc: this.doc,
        annotations: [...this.annotations.values()],
        users: this.users(),
        role: c.role,
        snapshot: true,
        seq: this.seq,
        epoch: this.epoch,
        restored: true,
      })
    }
    // 旧纪元的未确认操作已无意义，清空幂等表，避免误确认新客户端重发的操作
    this.acceptedOpIds.clear()
    this.acceptedOpIdQueue = []
  }

  /** 进程退出前调用：若有挂起的批注变化，补落快照 */
  flushPendingSnapshot() {
    if (this.annSnapshotTimer) {
      clearTimeout(this.annSnapshotTimer)
      this.annSnapshotTimer = null
      if (hasAnnChanges(this.annCounters)) this.createSnapshot('auto')
    }
  }

  /**
   * 断线重连：优先按版本号增量补齐错过的操作；日志不足时回退全量快照。
   */
  buildResync(lastRevision: number, clientEpoch?: number):
    | { kind: 'ops'; ops: LogEntry[] }
    | { kind: 'snapshot' } {
    // 客户端来自旧纪元（断线期间文档被恢复）→ 直接全量
    if (clientEpoch !== undefined && clientEpoch !== this.epoch) return { kind: 'snapshot' }
    const backlog = this.revision - lastRevision
    if (backlog >= 0 && backlog <= this.log.length) {
      return { kind: 'ops', ops: this.log.slice(this.log.length - backlog) }
    }
    return { kind: 'snapshot' }
  }

  /** 当前状态序列化（持久化用） */
  serialize() {
    return {
      docId: this.docId,
      doc: this.doc,
      revision: this.revision,
      annotations: [...this.annotations.values()],
      epoch: this.epoch,
    }
  }

  /** 版本索引序列化（轻量，不含快照正文） */
  serializeHistoryIndex() {
    return {
      docId: this.docId,
      epoch: this.epoch,
      editsSinceSnapshot: this.editsSinceSnapshot,
      annCounters: this.annCounters,
      archiveCountAtSnapshot: this.archiveCountAtSnapshot,
      versions: this.versions,
    }
  }

  /**
   * 反序列化当前状态。archive 为从归档文件重建的全量操作日志（重启后近期日志
   * 取其尾部，从而连「断线增量补齐」能力也能跨重启保留）。
   */
  static deserialize(data: {
    docId: string
    doc: string
    revision: number
    annotations: Annotation[]
    epoch?: number
  }, archive: LogEntry[] = []): DocSession {
    const s = new DocSession(data.docId, data.doc)
    s.revision = data.revision || 0
    for (const a of data.annotations || []) s.annotations.set(a.id, a)
    s.epoch = data.epoch || 0
    s.archive = archive.slice(-ARCHIVE_LIMIT)
    s.log = s.archive.slice(-LOG_LIMIT)
    return s
  }

  /** 载入版本索引（重启后恢复时间线） */
  loadHistoryIndex(data: {
    epoch?: number
    editsSinceSnapshot?: number
    annCounters?: AnnChangeSummary
    archiveCountAtSnapshot?: number
    versions?: VersionMeta[]
  }) {
    if (typeof data.epoch === 'number') this.epoch = data.epoch
    if (typeof data.editsSinceSnapshot === 'number') this.editsSinceSnapshot = data.editsSinceSnapshot
    if (data.annCounters) this.annCounters = { ...emptyAnnCounters(), ...data.annCounters }
    // 归档在内存中可能被 ARCHIVE_LIMIT 截断，边界索引夹取到已加载长度内
    this.archiveCountAtSnapshot = Math.min(data.archiveCountAtSnapshot ?? 0, this.archive.length)
    this.versions = data.versions || []
  }

  /**
   * 旧数据（无任何历史）引导：以当前状态建立初始基线快照。
   * 基线之前的归档操作没有可对比的上一快照，摘要窗口从归档末尾起算（基线摘要为空）。
   */
  bootstrapBaseline(): VersionSnapshot {
    this.archiveCountAtSnapshot = this.archive.length
    return this.createSnapshot('auto', { label: '初始版本' })
  }
}
