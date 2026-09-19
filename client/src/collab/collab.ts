/**
 * 协同编排层：把 WSClient（连接）/ OTClient（并发控制）/ Pinia stores（状态）粘合起来。
 *
 * 异常链路：
 * - 断网：WSClient 指数退避重连 → 重连后带 lastRevision 重新 join → 服务端增量补发或全量快照；
 * - 消息丢失：广播消息携带 seq，客户端检测空洞主动 resync；ack 超时同样触发 resync；
 * - 状态回滚：服务端日志不足以下发增量时下发快照，客户端丢弃未确认修改并回滚到快照；
 * - 权限/协议错误：服务端 error 消息 → 提示并按需 resync。
 */
import { ElMessage } from 'element-plus'
import { apply, diffToOp, isNoop, mapPosition, type Op } from '../../../shared/ot'
import type {
  Annotation,
  ErrorMsg,
  HistoryGetRespMsg,
  HistoryListRespMsg,
  RestoreAckMsg,
  Role,
  ServerMsg,
  VersionMeta,
  VersionSnapshot,
  WelcomeMsg,
} from '../../../shared/protocol'
import { WSClient } from '@/ws/wsClient'
import { OTClient } from '@/ot/otClient'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'

type RemoteListener = (op: Op) => void

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

type ReqResolver = {
  resolve: (m: ServerMsg) => void
  timer: ReturnType<typeof setTimeout>
}

class Collab {
  private ws = new WSClient()
  private ot: OTClient
  private lastSeq = 0
  private resyncing = false
  private remoteListeners: RemoteListener[] = []
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private lastCursorSent = 0
  private joinedOnce = false
  /** history 请求的待应答表（reqId → resolve） */
  private pendingReqs = new Map<string, ReqResolver>()

  constructor() {
    this.ot = new OTClient({
      sendOp: (op, opId, revision, epoch) => this.ws.send({ type: 'op', op, opId, revision, epoch }),
      applyRemote: (op) => this.applyRemoteToDoc(op),
      requestResync: () => this.requestResync(),
    })
    this.ws.onStatus = (status, attempt) => {
      const session = useSessionStore()
      session.status = status
      session.reconnectAttempt = attempt
      if (status !== 'online') {
        this.ot.setConnected(false)
        const doc = useDocStore()
        if (doc.syncState !== 'resyncing') doc.syncState = this.ot.pendingCount > 0 ? 'pending' : 'synced'
      }
    }
    this.ws.onOpen = () => {
      // 连接建立后立即（重）加入文档，携带本地版本号与纪元用于增量补齐 / 恢复后强制全量
      const session = useSessionStore()
      this.ws.send({
        type: 'join',
        docId: session.docId,
        name: session.name,
        role: session.role,
        lastRevision: this.joinedOnce ? this.ot.revision : undefined,
        epoch: this.joinedOnce ? this.ot.epoch : undefined,
      })
    }
    this.ws.onMessage = (msg) => {
      this.ws.noteAlive()
      this.handle(msg as ServerMsg)
    }
  }

  /** 注册远程操作应用监听（编辑器用来重映射光标/选区） */
  onRemoteApplied(fn: RemoteListener) {
    this.remoteListeners.push(fn)
    return () => {
      this.remoteListeners = this.remoteListeners.filter((f) => f !== fn)
    }
  }

  join(docId: string, name: string, role: Role) {
    const session = useSessionStore()
    session.docId = docId
    session.name = name
    session.role = role
    session.joined = true
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws.connect(`${proto}://${location.host}/ws`)
  }

  leave() {
    this.ws.disconnect()
    this.ws.clearOutbox()
    this.joinedOnce = false
    this.pendingReqs.forEach((r) => {
      clearTimeout(r.timer)
      r.resolve({ type: 'history:error', reqId: '', code: 'INTERNAL', message: '已离开文档' })
    })
    this.pendingReqs.clear()
    useSessionStore().$reset()
    useDocStore().$reset()
    this.ot.rollback(0, 0)
    this.lastSeq = 0
  }

  /** 模拟断网（演示断线重连 / 离线编辑） */
  simulateDrop() {
    const session = useSessionStore()
    session.simulatedOffline = true
    this.ws.disconnect()
    ElMessage.warning('已模拟断网：本地编辑会暂存，重新连接后自动同步')
  }

  reconnectNow() {
    const session = useSessionStore()
    session.simulatedOffline = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws.connect(`${proto}://${location.host}/ws`)
  }

  /* ---------------- 本地动作 ---------------- */

  /** 本地编辑：与当前文档 diff 生成操作，乐观应用并进入 OT 队列 */
  localEdit(newText: string) {
    const doc = useDocStore()
    const session = useSessionStore()
    // 恢复冻结 / 重同步期间忽略本地变更（编辑器同时只读），等待全量快照
    if (session.restoring || this.ot.isFrozen) return
    const op = diffToOp(doc.text, newText)
    if (isNoop(op)) return
    doc.text = newText
    this.transformAnnotations(op)
    this.ot.localChange(op)
    doc.syncState = 'pending'
  }

  addAnnotation(start: number, end: number, quote: string, text: string) {
    if (this.frozenOrRestoring()) return
    this.ws.send({ type: 'ann:add', annId: genId('ann'), start, end, quote, text })
  }

  replyAnnotation(annId: string, text: string) {
    if (this.frozenOrRestoring()) return
    this.ws.send({ type: 'ann:reply', annId, replyId: genId('r'), text })
  }

  resolveAnnotation(annId: string, resolved: boolean) {
    if (this.frozenOrRestoring()) return
    this.ws.send({ type: 'ann:resolve', annId, resolved })
  }

  deleteAnnotation(annId: string) {
    if (this.frozenOrRestoring()) return
    this.ws.send({ type: 'ann:delete', annId })
  }

  /** 恢复冻结期间屏蔽一切会修改文档/批注的提交 */
  private frozenOrRestoring(): boolean {
    return this.ot.isFrozen || useSessionStore().restoring
  }

  /* ---------------- 版本历史 ---------------- */

  /** 发送带 reqId 的请求并等待匹配应答（成功或 history:error） */
  private requestOnce(
    msg: object,
    reqId: string,
    timeoutMs = 10_000,
  ): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(reqId)
        reject(new Error('请求超时，请稍后重试'))
      }, timeoutMs)
      this.pendingReqs.set(reqId, { resolve, timer })
      this.ws.send(msg)
    })
  }

  /** 拉取版本时间线（仅管理员） */
  async fetchHistory(): Promise<HistoryListRespMsg> {
    const reqId = genId('hreq')
    const m = await this.requestOnce({ type: 'history:list', reqId }, reqId)
    if (m.type === 'history:error') throw new Error(m.message)
    return m as HistoryListRespMsg
  }

  /** 获取某个历史版本完整快照用于预览（仅管理员） */
  async fetchVersion(versionId: string): Promise<VersionSnapshot> {
    const reqId = genId('hreq')
    const m = await this.requestOnce({ type: 'history:get', reqId, versionId }, reqId)
    if (m.type === 'history:error') throw new Error(m.message)
    return (m as HistoryGetRespMsg).version
  }

  /**
   * 发起恢复（仅管理员）。服务端会广播 restore:begin 并对全员下发全量快照，
   * 本端在收到快照前进入冻结只读态。
   */
  async restoreVersion(
    versionId: string,
  ): Promise<{ version: VersionMeta; revision: number; epoch: number }> {
    const reqId = genId('hreq')
    const m = await this.requestOnce({ type: 'version:restore', reqId, versionId }, reqId, 30_000)
    if (m.type === 'history:error') throw new Error(m.message)
    const ack = m as RestoreAckMsg
    return { version: ack.version, revision: ack.revision, epoch: ack.epoch }
  }

  /** 光标上报：120ms 节流，断线时直接丢弃（易失消息） */
  sendCursor(start: number, end: number) {
    const now = Date.now()
    const doSend = () => {
      this.lastCursorSent = Date.now()
      this.ws.send({ type: 'cursor', start, end })
    }
    if (now - this.lastCursorSent >= 120) {
      doSend()
    } else if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null
        doSend()
      }, 120 - (now - this.lastCursorSent))
    }
  }

  /* ---------------- 服务端消息处理 ---------------- */

  private handle(msg: ServerMsg) {
    const session = useSessionStore()
    const doc = useDocStore()

    // 历史 / 恢复请求应答：路由到对应的等待者
    if (
      msg.type === 'history:list:resp' ||
      msg.type === 'history:get:resp' ||
      msg.type === 'restore:ack' ||
      msg.type === 'history:error'
    ) {
      const reqId = (msg as { reqId: string }).reqId
      const waiter = this.pendingReqs.get(reqId)
      if (waiter) {
        this.pendingReqs.delete(reqId)
        clearTimeout(waiter.timer)
        waiter.resolve(msg)
      }
      // restore:ack 之后真正的状态收敛以随后的全量 welcome 为准，这里无需额外处理
      return
    }

    switch (msg.type) {
      case 'welcome':
        this.onWelcome(msg)
        break

      case 'ops': {
        // 增量补齐：重放错过的操作（含可能已收到的自己的操作，按 opId 去重）
        this.ot.resyncOps(msg.ops, msg.revision)
        doc.revision = this.ot.revision
        this.lastSeq = msg.seq
        this.finishResync()
        break
      }

      case 'op': {
        if (!this.checkSeq(msg.seq)) return
        this.ot.remoteChange(msg.op)
        doc.revision = this.ot.revision
        break
      }

      case 'ack': {
        if (!this.checkSeq(msg.seq)) return
        this.ot.ack(msg.opId, msg.revision)
        doc.revision = this.ot.revision
        this.refreshSyncState()
        break
      }

      case 'ann:upsert': {
        if (!this.checkSeq(msg.seq)) return
        doc.upsertAnnotation(msg.ann)
        break
      }

      case 'ann:delete': {
        if (!this.checkSeq(msg.seq)) return
        doc.removeAnnotation(msg.annId)
        break
      }

      case 'restore:begin': {
        // 恢复广播：无论是否正处于重同步、即便之前有丢包（其后必随全量快照），
        // 都进入冻结只读态并对齐序号，而不是触发增量重同步。
        if (msg.seq > this.lastSeq) this.lastSeq = msg.seq
        this.beginRestore(`文档正由 ${msg.by.name} 恢复到历史版本，正在全量同步…`)
        break
      }

      case 'presence':
        session.setUsers(msg.users)
        break

      case 'cursor':
        session.cursors[msg.clientId] = { start: msg.start, end: msg.end }
        break

      case 'error':
        this.onError(msg)
        break

      case 'pong':
        break
    }
  }

  /** 恢复开始：进入冻结只读态，OT 丢弃基于旧版本的未确认操作 */
  private beginRestore(notice: string) {
    const session = useSessionStore()
    const doc = useDocStore()
    if (!session.restoring) {
      session.restoring = true
      session.restoredNotice = notice
    }
    this.ot.freeze()
    doc.syncState = 'resyncing'
  }

  /** 全量快照（尤其恢复触发）到达后结束冻结态 */
  private endRestore(restored: boolean) {
    const session = useSessionStore()
    if (!session.restoring) return
    session.restoring = false
    session.restoredNotice = ''
    if (restored) ElMessage.success('文档已恢复到历史版本，当前为全量同步后的最新内容')
  }

  private onWelcome(msg: WelcomeMsg) {
    const session = useSessionStore()
    const doc = useDocStore()
    const wasRejoin = this.joinedOnce
    const wasRestoring = session.restoring
    session.clientId = msg.clientId
    session.setUsers(msg.users)
    this.joinedOnce = true
    this.resyncing = true
    doc.syncState = 'resyncing'
    this.lastSeq = msg.seq

    if (msg.snapshot) {
      // 全量快照：回滚未确认的本地修改，同步版本纪元并解除恢复冻结
      const hadUnsynced = this.ot.rollback(msg.revision, msg.epoch)
      doc.text = msg.doc
      doc.revision = msg.revision
      doc.annotations = msg.annotations
      this.ws.clearOutbox()
      this.finishResync()
      this.endRestore(!!msg.restored)
      if (msg.restored && wasRestoring) {
        // 恢复提示已在 endRestore 中给出
      } else if (hadUnsynced) {
        ElMessage.warning('连接已恢复，但部分未同步的本地修改已回滚（版本过旧）')
      } else if (wasRejoin) {
        ElMessage.success('已重新连接并同步到最新版本')
      }
    } else {
      // 增量：保留本地文档与未确认操作，同步纪元；批注先以服务端为准，ops 到达后再重放
      this.ot.epoch = msg.epoch
      doc.annotations = msg.annotations
      if (wasRejoin) ElMessage.success('连接已恢复，正在增量同步')
    }
  }

  /** 重同步完成：重放本地未确认操作对批注锚点的影响，补发离线队列，恢复状态 */
  private finishResync() {
    const doc = useDocStore()
    // 服务端批注锚点不含本地未确认操作的影响 → 在本地重放
    for (const op of this.ot.unackedOps) this.transformAnnotations(op)
    this.resyncing = false
    this.ot.setConnected(true)
    this.ws.flushOutbox()
    this.refreshSyncState()
  }

  /** seq 连续性检查：发现空洞（消息丢失）→ 主动重同步 */
  private checkSeq(seq: number): boolean {
    if (this.resyncing) return false
    if (seq <= this.lastSeq) return false // 重复/过期消息
    if (seq > this.lastSeq + 1) {
      console.warn(`[collab] 检测到消息空洞 lastSeq=${this.lastSeq} got=${seq}，请求重同步`)
      this.requestResync()
      return false
    }
    this.lastSeq = seq
    return true
  }

  private requestResync() {
    if (this.resyncing) return
    this.resyncing = true
    const doc = useDocStore()
    doc.syncState = 'resyncing'
    // 携带本地纪元：若断线期间发生过恢复（纪元落后），服务端会直接下发全量快照
    this.ws.send({ type: 'resync', lastRevision: this.ot.revision, epoch: this.ot.epoch })
  }

  /**
   * 收到「纪元过期」错误（错过了 restore:begin，常见于恢复瞬间连接抖动）：
   * 立即进入冻结只读态，丢弃基于旧版本的未确认操作，再请求全量重同步。
   */
  private handleEpochAdvance(serverEpoch: number) {
    if (serverEpoch === this.ot.epoch) {
      this.requestResync()
      return
    }
    this.beginRestore('文档已被恢复到历史版本，本地版本过期，正在全量同步…')
    // 携带旧纪元请求重同步，服务端据此判定过期并下发全量快照（快照携带新纪元）
    this.requestResync()
  }

  private onError(msg: ErrorMsg) {
    switch (msg.code) {
      case 'PERMISSION_DENIED':
        ElMessage.error(msg.message)
        break
      case 'RESYNC_REQUIRED':
        if (typeof msg.epoch === 'number') {
          ElMessage.warning(msg.message)
          this.handleEpochAdvance(msg.epoch)
        } else {
          ElMessage.warning(`${msg.message}，正在重新同步`)
          this.requestResync()
        }
        break
      case 'BAD_REVISION':
        ElMessage.warning(`${msg.message}，正在重新同步`)
        this.requestResync()
        break
      default:
        ElMessage.error(msg.message)
        this.requestResync()
    }
  }

  /** 远程操作（已完成 OT 变换）应用到本地文档 */
  private applyRemoteToDoc(op: Op) {
    const doc = useDocStore()
    doc.text = apply(doc.text, op)
    this.transformAnnotations(op)
    for (const fn of this.remoteListeners) fn(op)
  }

  /** 批注锚点随操作移动 */
  private transformAnnotations(op: Op) {
    const doc = useDocStore()
    for (const ann of doc.annotations) {
      ann.start = mapPosition(ann.start, op, 'after')
      ann.end = mapPosition(ann.end, op, 'before')
      if (ann.end < ann.start) ann.end = ann.start
      ann.orphan = ann.start === ann.end
    }
  }

  private refreshSyncState() {
    const doc = useDocStore()
    if (this.resyncing) doc.syncState = 'resyncing'
    else doc.syncState = this.ot.pendingCount > 0 ? 'pending' : 'synced'
  }
}

export const collab = new Collab()
