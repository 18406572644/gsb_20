import { randomUUID } from 'node:crypto'
import {
  apply,
  baseLength,
  isDelete,
  isInsert,
  isNoop,
  mapPosition,
  transform,
  type Op,
} from '../../shared/ot'
import type {
  Annotation,
  AnnotationDelta,
  ArchivedOp,
  LogEntry,
  Role,
  UserInfo,
  VersionChange,
  VersionInfo,
  VersionReason,
  VersionSnapshot,
} from '../../shared/protocol'
import { canAnnotate, canEdit, canManage } from '../../shared/protocol'

/** 服务端操作日志保留长度：超出后落后太多的客户端只能走全量快照回滚 */
export const LOG_LIMIT = 1000
/** 每接受多少个操作自动留存一个版本快照 */
export const AUTO_SNAPSHOT_OPS = Math.max(1, Number(process.env.AUTO_SNAPSHOT_OPS) || 100)
/** 版本时间线最多保留的快照数（FIFO 裁剪） */
export const MAX_VERSIONS = 100

const ZERO_DELTA: AnnotationDelta = { added: 0, removed: 0, resolved: 0, replies: 0 }

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

export interface ClientState {
  clientId: string
  name: string
  role: Role
  color: string
  cursor: { start: number; end: number } | null
  send: (msg: object) => void
}

export interface HistoryError {
  code: 'PERMISSION_DENIED' | 'NOT_FOUND' | 'BAD_MESSAGE'
  message: string
}

export interface RestoreResult {
  reset: Extract<import('../../shared/protocol').ServerMsg, { type: 'history:reset' }>
  version: VersionInfo
}

/** 深拷贝批注（快照持有的对象绝不能与活动 Map 共享引用） */
function cloneAnnotations(list: Iterable<Annotation>): Annotation[] {
  return JSON.parse(JSON.stringify([...list])) as Annotation[]
}

function cloneOp(op: Op): Op {
  return op.map((c) => ({ ...c })) as Op
}

export class DocSession {
  readonly docId: string
  doc: string
  revision = 0
  /** 版本纪元：每次恢复 +1。恢复后 revision 回退，epoch 用于区分新旧版本线 */
  epoch = 0
  /** 广播序号：客户端用它检测消息丢失（cursor/presence 等易失消息不计入） */
  seq = 0
  log: LogEntry[] = []
  annotations = new Map<string, Annotation>()
  clients = new Map<string, ClientState>()
  /** 版本快照时间线（旧 → 新），FIFO 裁剪到 MAX_VERSIONS */
  versions: VersionSnapshot[] = []
  /** 自上一版本快照以来接受的操作，供下一次快照归档统计 */
  private opsSinceSnapshot: ArchivedOp[] = []
  /** 已接受的 opId 集合（幂等去重：ack 丢失导致客户端重发时不重复应用） */
  private acceptedOpIds = new Set<string>()
  private acceptedOpIdQueue: string[] = []
  private colorIdx = 0
  /** 数据变更回调（用于持久化防抖；immediate=true 时立即落盘） */
  onDirty: ((immediate?: boolean) => void) | null = null

  constructor(docId: string, initialDoc = '') {
    this.docId = docId
    this.doc = initialDoc
    // 新文档（含 demo 默认正文）：留存初始版本。此时尚无客户端，广播自然为空
    this.versions = [this.takeSnapshot('init', { label: '初始版本' })]
  }

  private dirty(immediate = false) {
    this.onDirty?.(immediate)
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
    epoch: number,
    op: Op,
    opId: string,
  ): { code: 'PERMISSION_DENIED' | 'BAD_REVISION' | 'RESYNC_REQUIRED'; message: string } | null {
    if (!canEdit(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '当前角色无编辑权限' }
    }
    // 幂等：该操作已被接受过（ack 丢失后客户端重发）→ 直接重新确认，不重复应用
    if (this.acceptedOpIds.has(opId)) {
      client.send({ type: 'ack', opId, revision: this.revision, seq: this.seq })
      return null
    }
    // 纪元围栏：恢复后旧纪元客户端的操作一律拒绝（即使 revision 数字恰好对得上）
    if (typeof epoch !== 'number' || epoch !== this.epoch) {
      return { code: 'RESYNC_REQUIRED', message: '文档已恢复到其他版本分支，请重新同步' }
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

    const now = Date.now()
    const entry: LogEntry = {
      revision: this.revision,
      epoch: this.epoch,
      op: transformed,
      opId,
      clientId: client.clientId,
      authorName: client.name,
      lenBefore: this.doc.length,
      timestamp: now,
    }
    if (!isNoop(transformed)) {
      this.doc = apply(this.doc, transformed)
      this.transformAnnotations(transformed)
    }
    this.log.push(entry)
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
    // 归档（含 noop：接受即占用 revision，统计毛变化时贡献 0）
    this.opsSinceSnapshot.push({
      revision: entry.revision,
      epoch: entry.epoch,
      op: cloneOp(transformed),
      opId,
      clientId: client.clientId,
      authorName: client.name,
      timestamp: now,
      lenBefore: entry.lenBefore,
    })
    this.acceptedOpIds.add(opId)
    this.acceptedOpIdQueue.push(opId)
    if (this.acceptedOpIdQueue.length > LOG_LIMIT * 2) {
      this.acceptedOpIds.delete(this.acceptedOpIdQueue.shift()!)
    }
    this.revision++
    this.seq++

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
        timestamp: now,
        seq: this.seq,
      },
      client.clientId,
    )

    // 达到自动快照阈值：在 dirty 前留存版本（广播 history:added，不占 seq）
    if (this.opsSinceSnapshot.length >= AUTO_SNAPSHOT_OPS) {
      this.buildSnapshot('auto', { label: `自动版本 v${this.revision}` })
    }
    this.dirty()
    return null
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
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
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
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
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
    this.seq++
    this.broadcastAll({ type: 'ann:upsert', ann, seq: this.seq })
    this.dirty()
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
    this.seq++
    this.broadcastAll({ type: 'ann:delete', annId, seq: this.seq })
    this.dirty()
    return null
  }

  updateCursor(client: ClientState, start: number, end: number) {
    client.cursor = { start, end }
    // 光标消息易失：不计 seq、不持久化，直接转发
    this.broadcast({ type: 'cursor', clientId: client.clientId, start, end }, client.clientId)
  }

  /* ---------------- 版本历史 ---------------- */

  /** 按操作者聚合版本区间内的插入/删除毛量 */
  private computeChanges(ops: ArchivedOp[]): VersionChange[] {
    const map = new Map<string, VersionChange>()
    for (const e of ops) {
      let c = map.get(e.clientId)
      if (!c) {
        c = { clientId: e.clientId, authorName: e.authorName, ops: 0, inserted: 0, deleted: 0 }
        map.set(e.clientId, c)
      }
      c.ops++
      for (const comp of e.op) {
        if (isInsert(comp)) c.inserted += comp.insert.length
        else if (isDelete(comp)) c.deleted += comp.delete
      }
    }
    return [...map.values()].sort((a, b) => b.inserted + b.deleted - (a.inserted + a.deleted))
  }

  /** 与上一版本快照的批注集合对比 */
  private computeAnnotationDelta(prev: VersionSnapshot | null): AnnotationDelta {
    if (!prev) return { ...ZERO_DELTA, added: this.annotations.size }
    let added = 0
    let removed = 0
    let resolved = 0
    let repliesNow = 0
    let repliesPrev = 0
    for (const a of this.annotations.values()) {
      repliesNow += a.replies.length
      const old = prev.annotations.find((p) => p.id === a.id)
      if (!old) added++
      else if (!old.resolved && a.resolved) resolved++
    }
    for (const a of prev.annotations) {
      repliesPrev += a.replies.length
      if (!this.annotations.has(a.id)) removed++
    }
    return { added, removed, resolved, replies: Math.max(0, repliesNow - repliesPrev) }
  }

  /** 从当前状态采集一个快照对象（不入时间线、不清计数、不广播） */
  private takeSnapshot(
    reason: VersionReason,
    opts: {
      label?: string
      client?: ClientState
      restoredFrom?: { id: string; revision: number; label: string }
    },
  ): VersionSnapshot {
    // restored 快照内容与来源版本天然一致：没有区间操作，统计归零
    const isRestored = reason === 'restored'
    const prev = this.versions[this.versions.length - 1] ?? null
    return {
      id: randomUUID(),
      revision: this.revision,
      epoch: this.epoch,
      doc: this.doc,
      annotations: cloneAnnotations(this.annotations.values()),
      createdAt: Date.now(),
      createdBy: opts.client?.clientId ?? null,
      authorName: opts.client?.name ?? '系统',
      reason,
      label: opts.label ?? '',
      restoredFrom: opts.restoredFrom,
      ops: isRestored ? [] : this.opsSinceSnapshot.map((e) => ({ ...e, op: cloneOp(e.op) })),
      changes: isRestored ? [] : this.computeChanges(this.opsSinceSnapshot),
      annotationDelta: isRestored ? ZERO_DELTA : this.computeAnnotationDelta(prev),
    }
  }

  /** 采集快照并入时间线：重置区间计数、FIFO 裁剪、广播 history:added */
  private buildSnapshot(
    reason: VersionReason,
    opts: {
      label?: string
      client?: ClientState
      restoredFrom?: { id: string; revision: number; label: string }
    },
  ): VersionSnapshot {
    const snap = this.takeSnapshot(reason, opts)
    this.opsSinceSnapshot = []
    this.versions.push(snap)
    if (this.versions.length > MAX_VERSIONS) {
      this.versions.splice(0, this.versions.length - MAX_VERSIONS)
    }
    this.broadcastAll({ type: 'history:added', version: this.toInfo(snap, true) })
    return snap
  }

  private toInfo(v: VersionSnapshot, head: boolean): VersionInfo {
    return {
      id: v.id,
      revision: v.revision,
      epoch: v.epoch,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      authorName: v.authorName,
      reason: v.reason,
      label: v.label,
      restoredFrom: v.restoredFrom,
      changes: v.changes,
      annotationDelta: v.annotationDelta,
      docLength: v.doc.length,
      annotationCount: v.annotations.length,
      opCount: v.ops.length,
      head,
    }
  }

  /** 版本时间线（新 → 旧）与当前版本指针 */
  listHistory(): {
    versions: VersionInfo[]
    current: { revision: number; epoch: number; versionId: string }
  } {
    const head = this.versions[this.versions.length - 1]
    return {
      versions: this.versions
        .map((v, i) => this.toInfo(v, i === this.versions.length - 1))
        .reverse(),
      current: { revision: this.revision, epoch: this.epoch, versionId: head.id },
    }
  }

  getVersion(id: string): VersionSnapshot | null {
    return this.versions.find((v) => v.id === id) ?? null
  }

  /** 管理者手动保存当前状态为版本 */
  saveVersion(
    client: ClientState,
    label?: string,
  ): HistoryError | { version: VersionInfo } {
    if (!canManage(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '仅管理者可保存版本' }
    }
    const text = label?.trim().slice(0, 80)
    const snap = this.buildSnapshot('manual', {
      label: text || `手动版本 v${this.revision}`,
      client,
    })
    this.dirty(true)
    return { version: this.toInfo(snap, true) }
  }

  /**
   * 恢复到指定版本（线性恢复点模型）：
   * 1. 先自动备份当前状态（pre-restore）；
   * 2. epoch+1、清空 OT 日志与幂等窗口、替换正文与批注、revision 回退；
   * 3. 留存 restored 快照并向所有在线客户端广播 history:reset 全量重同步。
   * 全程同步执行（Node 单线程），不会与其他操作交错。
   */
  restoreVersion(client: ClientState, id: string, reqId: string): HistoryError | RestoreResult {
    if (!canManage(client.role)) {
      return { code: 'PERMISSION_DENIED', message: '仅管理者可恢复版本' }
    }
    const target = this.versions.find((v) => v.id === id)
    if (!target) return { code: 'NOT_FOUND', message: '版本不存在或已被裁剪' }

    this.buildSnapshot('pre-restore', {
      label: `恢复前自动备份 v${this.revision}`,
      client,
    })

    this.epoch++
    this.log = []
    this.acceptedOpIds.clear()
    this.acceptedOpIdQueue = []
    this.opsSinceSnapshot = []
    this.doc = target.doc
    this.annotations = new Map(cloneAnnotations(target.annotations).map((a) => [a.id, a]))
    this.revision = target.revision

    // reset 占用一个 seq：错过它的客户端会检测到 seq 空洞 → resync → 纪元不一致 → 全量快照
    this.seq++
    const restored = this.buildSnapshot('restored', {
      label: `恢复自版本 v${target.revision}`,
      client,
      restoredFrom: { id: target.id, revision: target.revision, label: target.label },
    })

    const restoredFrom = { id: target.id, revision: target.revision, label: target.label }
    const reset = {
      type: 'history:reset',
      reqId,
      epoch: this.epoch,
      revision: this.revision,
      doc: this.doc,
      annotations: cloneAnnotations(this.annotations.values()),
      seq: this.seq,
      by: { clientId: client.clientId, name: client.name },
      restoredFrom,
      at: Date.now(),
    } as const
    this.broadcastAll(reset)
    this.dirty(true)
    return { reset, version: this.toInfo(restored, true) }
  }

  /**
   * 断线重连：优先按版本号增量补齐错过的操作；日志不足或纪元不一致时回退全量快照。
   * 注意：lastEpoch 缺省时保持旧行为（兼容未携带纪元的旧客户端）。
   */
  buildResync(lastRevision: number, lastEpoch?: number):
    | { kind: 'ops'; ops: LogEntry[] }
    | { kind: 'snapshot' } {
    if (typeof lastEpoch === 'number' && lastEpoch !== this.epoch) {
      return { kind: 'snapshot' }
    }
    const backlog = this.revision - lastRevision
    if (backlog >= 0 && backlog <= this.log.length) {
      return { kind: 'ops', ops: this.log.slice(this.log.length - backlog) }
    }
    return { kind: 'snapshot' }
  }

  /** 序列化快照（持久化用） */
  serialize() {
    return {
      docId: this.docId,
      doc: this.doc,
      revision: this.revision,
      epoch: this.epoch,
      annotations: [...this.annotations.values()],
      // OT 日志与版本时间线持久化：重启后仍可增量重放并查看完整历史
      log: this.log,
      versions: this.versions,
    }
  }

  static deserialize(data: {
    docId: string
    doc: string
    revision: number
    epoch?: number
    annotations: Annotation[]
    log?: LogEntry[]
    versions?: VersionSnapshot[]
  }): DocSession {
    const s = new DocSession(data.docId, data.doc)
    s.revision = data.revision || 0
    s.epoch = data.epoch || 0
    for (const a of data.annotations || []) s.annotations.set(a.id, JSON.parse(JSON.stringify(a)))
    // 兼容旧日志条目（无 timestamp/epoch 字段）
    s.log = (data.log || []).map((e) => ({
      ...e,
      epoch: typeof e.epoch === 'number' ? e.epoch : s.epoch,
      timestamp: typeof e.timestamp === 'number' ? e.timestamp : 0,
    }))
    if (Array.isArray(data.versions) && data.versions.length > 0) {
      s.versions = data.versions
      // 重建区间归档：仅当前纪元、revision 不早于最新快照的日志条目
      const head = s.versions[s.versions.length - 1]
      s.opsSinceSnapshot = s.log
        .filter((e) => e.epoch === s.epoch && e.revision >= head.revision)
        .map((e) => ({ ...e, op: cloneOp(e.op) }))
    } else {
      // 旧版本数据文件（无历史）：以当前状态合成初始版本，历史无法回溯
      s.versions = [s.takeSnapshot('init', { label: '初始版本' })]
      s.opsSinceSnapshot = []
    }
    return s
  }
}
