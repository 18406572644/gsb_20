/**
 * 协同编排层：把 WSClient（连接）/ OTClient（并发控制）/ Pinia stores（状态）粘合起来。
 *
 * 异常链路：
 * - 断网：WSClient 指数退避重连 → 重连后带 lastRevision/epoch 重新 join → 服务端增量补发或全量快照；
 * - 消息丢失：广播消息携带 seq，客户端检测空洞主动 resync；ack 超时同样触发 resync；
 * - 状态回滚：服务端日志不足以下发增量时下发快照，客户端丢弃未确认修改并回滚到快照；
 * - 版本恢复：服务端广播 history:reset（epoch+1、清空 OT 日志），全员暂停提交并全量重同步；
 * - 权限/协议错误：服务端 error 消息 → 提示并按需 resync。
 */
import { nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { apply, diffToOp, isNoop, mapPosition, type Op } from '../../../shared/ot'
import type {
  Annotation,
  ClientMsg,
  ErrorMsg,
  HistoryListReply,
  HistoryResetMsg,
  HistoryVersionMsg,
  Role,
  ServerMsg,
  VersionInfo,
  VersionSnapshot,
  WelcomeMsg,
} from '../../../shared/protocol'
import { WSClient } from '@/ws/wsClient'
import { OTClient } from '@/ot/otClient'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'

type RemoteListener = (op: Op) => void
type HistoryListener = () => void

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface PendingHistory {
  resolve: (value: any) => void
  reject: (reason?: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const HISTORY_TIMEOUT = 10_000

class Collab {
  private ws = new WSClient()
  private ot: OTClient
  private lastSeq = 0
  private resyncing = false
  private remoteListeners: RemoteListener[] = []
  private historyListeners: HistoryListener[] = []
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private lastCursorSent = 0
  private joinedOnce = false
  /** 当前客户端所处的版本纪元（与服务端不一致时必须全量重同步） */
  private epoch = 0
  /** 未完成的历史请求：reqId → Promise 结算 */
  private historyReqs = new Map<string, PendingHistory>()
  private historyReqSeq = 0

  constructor() {
    this.ot = new OTClient({
      sendOp: (op, opId, revision) =>
        this.ws.send({ type: 'op', op, opId, revision, epoch: this.epoch }),
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
      // 连接建立后立即（重）加入文档，携带本地版本号/纪元用于增量补齐
      const session = useSessionStore()
      this.ws.send({
        type: 'join',
        docId: session.docId,
        name: session.name,
        role: session.role,
        lastRevision: this.joinedOnce ? this.ot.revision : undefined,
        epoch: this.joinedOnce ? this.epoch : undefined,
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

  /** 版本时间线变化监听（新版本产生、恢复后刷新面板） */
  onHistoryChanged(fn: HistoryListener) {
    this.historyListeners.push(fn)
    return () => {
      this.historyListeners = this.historyListeners.filter((f) => f !== fn)
    }
  }

  private emitHistoryChanged() {
    for (const fn of this.historyListeners) fn()
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
    this.epoch = 0
    this.rejectAllHistory(new Error('已离开文档'))
    useSessionStore().$reset()
    useDocStore().$reset()
    this.ot.rollback(0)
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
    if (doc.frozen) return
    const op = diffToOp(doc.text, newText)
    if (isNoop(op)) return
    doc.text = newText
    this.transformAnnotations(op)
    this.ot.localChange(op)
    doc.syncState = 'pending'
  }

  addAnnotation(start: number, end: number, quote: string, text: string) {
    if (useDocStore().frozen) return
    this.ws.send({ type: 'ann:add', annId: genId('ann'), start, end, quote, text })
  }

  replyAnnotation(annId: string, text: string) {
    this.ws.send({ type: 'ann:reply', annId, replyId: genId('r'), text })
  }

  resolveAnnotation(annId: string, resolved: boolean) {
    this.ws.send({ type: 'ann:resolve', annId, resolved })
  }

  deleteAnnotation(annId: string) {
    this.ws.send({ type: 'ann:delete', annId })
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

  /* ---------------- 版本历史（仅 owner，UI 已做入口控制，服务端二次鉴权） ---------------- */

  /** 发送历史类请求并等待按 reqId 匹配的应答 */
  private historyReq<T>(msg: ClientMsg): Promise<T> {
    if (!this.ws.isOpen) return Promise.reject(new Error('当前未连接，无法操作版本历史'))
    const reqId = `h-${Date.now().toString(36)}-${(this.historyReqSeq++).toString(36)}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.historyReqs.delete(reqId)
        reject(new Error('版本历史请求超时'))
      }, HISTORY_TIMEOUT)
      this.historyReqs.set(reqId, { resolve, reject, timer })
      this.ws.send({ ...msg, reqId })
    })
  }

  loadHistory() {
    return this.historyReq<HistoryListReply>({ type: 'history:list', reqId: '' })
  }

  getVersion(versionId: string) {
    return this.historyReq<HistoryVersionMsg>({ type: 'history:get', reqId: '', versionId })
  }

  async saveVersion(label?: string): Promise<VersionInfo> {
    const reply = await this.historyReq<{ type: 'history:added'; version: VersionInfo }>({
      type: 'history:save',
      reqId: '',
      label,
    })
    return reply.version
  }

  /**
   * 发起恢复：应答不通过单独消息返回——服务端广播 history:reset（全员含请求方），
   * reset 处理器中按 reqId 结算此 Promise。
   */
  restoreVersion(versionId: string) {
    return this.historyReq<HistoryResetMsg>({ type: 'history:restore', reqId: '', versionId })
  }

  private resolveHistory(reqId: string, value: unknown) {
    const p = this.historyReqs.get(reqId)
    if (!p) return false
    clearTimeout(p.timer)
    this.historyReqs.delete(reqId)
    p.resolve(value)
    return true
  }

  private rejectHistory(reqId: string, err: Error) {
    const p = this.historyReqs.get(reqId)
    if (!p) return false
    clearTimeout(p.timer)
    this.historyReqs.delete(reqId)
    p.reject(err)
    return true
  }

  private rejectAllHistory(err: Error) {
    for (const [, p] of this.historyReqs) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.historyReqs.clear()
  }

  /* ---------------- 服务端消息处理 ---------------- */

  private handle(msg: ServerMsg) {
    const session = useSessionStore()
    const doc = useDocStore()
    switch (msg.type) {
      case 'welcome':
        this.onWelcome(msg)
        break

      case 'ops': {
        // 迟到的旧纪元补发（恢复已先于本消息处理）：序号必然落后，直接丢弃
        if (msg.seq <= this.lastSeq) return
        // 增量补齐（重连 join 或空洞重同步）：按 opId 去重后重放，并以消息序号对齐。
        // 不做 seq 跳变拒绝——空洞重同步时服务端 seq 本就领先。
        this.lastSeq = msg.seq
        this.ot.resyncOps(msg.ops, msg.revision)
        doc.revision = this.ot.revision
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

      case 'presence':
        session.setUsers(msg.users)
        break

      case 'cursor':
        session.cursors[msg.clientId] = { start: msg.start, end: msg.end }
        break

      case 'history:list':
        this.resolveHistory(msg.reqId, msg)
        break

      case 'history:version':
        this.resolveHistory(msg.reqId, msg)
        break

      case 'history:added':
        if (msg.reqId) this.resolveHistory(msg.reqId, msg)
        this.emitHistoryChanged()
        break

      case 'history:reset':
        this.onReset(msg)
        break

      case 'error':
        this.onError(msg)
        break

      case 'pong':
        break
    }
  }

  private onWelcome(msg: WelcomeMsg) {
    // 迟到的旧纪元快照 welcome（恢复 reset 已先处理，旧 resync 响应才到达）：整体丢弃，
    // 其后紧跟的旧 ops 会由 ops 分支的序号守卫丢弃。
    if (msg.epoch < this.epoch) return
    const session = useSessionStore()
    const doc = useDocStore()
    const wasRejoin = this.joinedOnce
    const oldEpoch = this.epoch
    session.clientId = msg.clientId
    session.setUsers(msg.users)
    this.joinedOnce = true
    this.resyncing = true
    doc.syncState = 'resyncing'
    this.lastSeq = msg.seq

    if (msg.snapshot) {
      // 全量快照：回滚未确认的本地修改
      const hadUnsynced = this.ot.rollback(msg.revision)
      doc.text = msg.doc
      doc.revision = msg.revision
      doc.epoch = msg.epoch
      this.epoch = msg.epoch
      doc.annotations = msg.annotations
      this.ws.clearOutbox()
      this.finishResync()
      if (wasRejoin && oldEpoch !== msg.epoch) {
        ElMessage.info('文档已被管理者恢复到历史版本，本地已全量重新同步')
      } else if (hadUnsynced) {
        ElMessage.warning('连接已恢复，但部分未同步的本地修改已回滚（版本过旧）')
      } else if (wasRejoin) {
        ElMessage.success('已重新连接并同步到最新版本')
      }
    } else {
      // 增量：保留本地文档与未确认操作，批注先以服务端为准，ops 到达后再重放本地未确认操作
      doc.epoch = msg.epoch
      this.epoch = msg.epoch
      doc.annotations = msg.annotations
      if (wasRejoin) ElMessage.success('连接已恢复，正在增量同步')
    }
  }

  /**
   * 版本恢复广播：暂停提交（frozen）→ 丢弃全部未确认操作 → 全量替换
   * 正文/批注/版本号/纪元/seq → 解除冻结。旧纪元的后续提交会被 epoch 围栏拒绝。
   */
  private onReset(msg: HistoryResetMsg) {
    const session = useSessionStore()
    const doc = useDocStore()
    doc.frozen = true
    this.resyncing = false
    const hadUnsynced = this.ot.rollback(msg.revision)
    doc.text = msg.doc
    doc.revision = msg.revision
    doc.epoch = msg.epoch
    this.epoch = msg.epoch
    doc.annotations = msg.annotations
    this.lastSeq = msg.seq
    this.ws.clearOutbox()
    this.ot.setConnected(true)
    this.refreshSyncState()

    const isMe = msg.by.clientId === session.clientId
    const tail = hadUnsynced ? '（未同步的本地修改已丢弃）' : ''
    if (isMe) {
      ElMessage.success(`已恢复到版本 v${msg.restoredFrom.revision}${tail}`)
      this.resolveHistory(msg.reqId, msg)
    } else {
      ElMessage.info(`${msg.by.name} 已将文档恢复到版本 v${msg.restoredFrom.revision}${tail}`)
    }
    this.emitHistoryChanged()
    nextTick(() => {
      doc.frozen = false
    })
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
    this.ws.send({ type: 'resync', lastRevision: this.ot.revision, epoch: this.epoch })
  }

  private onError(msg: ErrorMsg) {
    // 历史请求的错误：交给对应 Promise，不走通用提示 / 重同步
    if (msg.reqId && this.rejectHistory(msg.reqId, new Error(msg.message))) return
    switch (msg.code) {
      case 'PERMISSION_DENIED':
        ElMessage.error(msg.message)
        break
      case 'RESYNC_REQUIRED':
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
