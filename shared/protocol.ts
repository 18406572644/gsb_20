/**
 * 客户端 / 服务端 WebSocket 协议定义。
 * 所有消息均为 JSON 文本帧，含 type 字段。
 */
import type { Op } from './ot'

/** 角色：viewer 只读 / commenter 可批注 / editor 可编辑+批注 / owner 管理者（可编辑+版本历史与恢复） */
export type Role = 'viewer' | 'commenter' | 'editor' | 'owner'

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '只读',
  commenter: '批注',
  editor: '编辑',
  owner: '管理者',
}

export function canEdit(role: Role): boolean {
  return role === 'editor' || role === 'owner'
}

export function canAnnotate(role: Role): boolean {
  return role === 'editor' || role === 'commenter' || role === 'owner'
}

/** 版本历史 / 恢复等管理能力，仅 owner */
export function canManage(role: Role): boolean {
  return role === 'owner'
}

export interface UserInfo {
  clientId: string
  name: string
  role: Role
  color: string
}

export interface Reply {
  id: string
  authorId: string
  authorName: string
  text: string
  createdAt: number
}

/** 批注锚定到文档的 [start, end) 区间，随编辑操作做位置映射 */
export interface Annotation {
  id: string
  start: number
  end: number
  /** 锚点文本被完全删除后为 true（孤儿批注，折叠到 start 处展示） */
  orphan: boolean
  quote: string
  authorId: string
  authorName: string
  text: string
  replies: Reply[]
  resolved: boolean
  createdAt: number
}

export interface LogEntry {
  revision: number
  /** 所属版本纪元：每次恢复 +1；恢复后 revision 会回退，epoch 用于区分 */
  epoch: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  /** 应用该操作前的文档长度（用于校验客户端操作的基准版本） */
  lenBefore: number
  /** 服务端接受该操作的时间戳 */
  timestamp: number
}

/* ---------------- 版本历史 ---------------- */

/** 版本快照的产生方式 */
export type VersionReason = 'init' | 'manual' | 'auto' | 'pre-restore' | 'restored'

/** 归档的单条操作（日志环形缓冲之外、随版本持久化保存） */
export interface ArchivedOp {
  revision: number
  epoch: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  timestamp: number
  lenBefore: number
}

/** 单个操作者在一个版本区间内的变更摘要 */
export interface VersionChange {
  clientId: string
  authorName: string
  /** 该操作者被接受的操作数 */
  ops: number
  /** 插入字符总数（按变换后实际应用的操作统计毛值） */
  inserted: number
  /** 删除字符总数 */
  deleted: number
}

/** 版本区间内批注集合的变化摘要（与上一个版本快照对比） */
export interface AnnotationDelta {
  added: number
  removed: number
  /** false → true 的解决数 */
  resolved: number
  /** 新增回复数（按回复总数差值，下限 0） */
  replies: number
}

/** 版本快照：某一时刻文档正文 + 批注的完整留存 */
export interface VersionSnapshot {
  id: string
  revision: number
  epoch: number
  doc: string
  annotations: Annotation[]
  createdAt: number
  /** 创建者 clientId（init/迁移快照为 null） */
  createdBy: string | null
  authorName: string
  reason: VersionReason
  label: string
  /** restored 类型：本次恢复的来源版本（冗余存储，来源版本可能已被裁剪） */
  restoredFrom?: { id: string; revision: number; label: string }
  /** 自上一版本快照以来归档的操作 */
  ops: ArchivedOp[]
  changes: VersionChange[]
  annotationDelta: AnnotationDelta
}

/** 时间线列表项：不含正文 / 批注 / 操作明细 */
export type VersionInfo = Omit<VersionSnapshot, 'doc' | 'annotations' | 'ops'> & {
  docLength: number
  annotationCount: number
  opCount: number
  /** 是否为当前最新版本 */
  head: boolean
}

/* ---------------- 客户端 → 服务端 ---------------- */

export interface JoinMsg {
  type: 'join'
  docId: string
  name: string
  role: Role
  /** 断线重连时携带本地已同步到的版本号，用于增量补齐 */
  lastRevision?: number
  /** 本地所处纪元，与服务端不一致时强制全量快照（恢复后） */
  epoch?: number
}

export interface OpMsg {
  type: 'op'
  revision: number
  /** 客户端操作时所处纪元，过期纪元的操作直接拒绝并要求重同步 */
  epoch: number
  op: Op
  opId: string
}

export interface CursorMsg {
  type: 'cursor'
  start: number
  end: number
}

export interface AnnAddMsg {
  type: 'ann:add'
  annId: string
  start: number
  end: number
  quote: string
  text: string
}

export interface AnnReplyMsg {
  type: 'ann:reply'
  annId: string
  replyId: string
  text: string
}

export interface AnnResolveMsg {
  type: 'ann:resolve'
  annId: string
  resolved: boolean
}

export interface AnnDeleteMsg {
  type: 'ann:delete'
  annId: string
}

/** 主动请求重同步（检测到消息空洞 / ack 超时 / 收到 RESYNC 错误时） */
export interface ResyncMsg {
  type: 'resync'
  lastRevision: number
  epoch?: number
}

export interface PingMsg {
  type: 'ping'
  t: number
}

/* ---------------- 版本历史管理消息（仅 owner） ---------------- */

export interface HistoryListMsg {
  type: 'history:list'
  reqId: string
}

export interface HistoryGetMsg {
  type: 'history:get'
  reqId: string
  versionId: string
}

export interface HistorySaveMsg {
  type: 'history:save'
  reqId: string
  label?: string
}

export interface HistoryRestoreMsg {
  type: 'history:restore'
  reqId: string
  versionId: string
}

export type ClientMsg =
  | JoinMsg
  | OpMsg
  | CursorMsg
  | AnnAddMsg
  | AnnReplyMsg
  | AnnResolveMsg
  | AnnDeleteMsg
  | ResyncMsg
  | PingMsg
  | HistoryListMsg
  | HistoryGetMsg
  | HistorySaveMsg
  | HistoryRestoreMsg

/* ---------------- 服务端 → 客户端 ---------------- */

export interface WelcomeMsg {
  type: 'welcome'
  clientId: string
  docId: string
  revision: number
  epoch: number
  doc: string
  annotations: Annotation[]
  users: UserInfo[]
  role: Role
  /** 重连时若 true 表示服务端日志已不足以增量补齐，本消息为全量快照 */
  snapshot: boolean
  /** 当前文档广播序号，客户端据此检测后续消息空洞 */
  seq: number
}

/** 增量补齐：重连后补发错过的操作 */
export interface OpsMsg {
  type: 'ops'
  ops: {
    revision: number
    op: Op
    opId: string
    clientId: string
    authorName: string
    timestamp?: number
  }[]
  revision: number
  seq: number
}

export interface AckMsg {
  type: 'ack'
  opId: string
  revision: number
  /** 与他人收到的 op 广播使用同一序号，保证所有客户端的 seq 流一致 */
  seq: number
}

/** 他人操作广播（不发给操作发起者，发起者收 ack） */
export interface RemoteOpMsg {
  type: 'op'
  revision: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  timestamp: number
  seq: number
}

export interface PresenceMsg {
  type: 'presence'
  users: UserInfo[]
}

export interface RemoteCursorMsg {
  type: 'cursor'
  clientId: string
  start: number
  end: number
}

export interface AnnUpsertMsg {
  type: 'ann:upsert'
  ann: Annotation
  seq: number
}

export interface AnnDeletedMsg {
  type: 'ann:delete'
  annId: string
  seq: number
}

/** 版本时间线列表回复 */
export interface HistoryListReply {
  type: 'history:list'
  reqId: string
  versions: VersionInfo[]
  current: { revision: number; epoch: number; versionId: string }
}

/** 单个版本快照详情回复（预览用） */
export interface HistoryVersionMsg {
  type: 'history:version'
  reqId: string
  version: VersionSnapshot
}

/** 新版本快照产生时广播（易失，不占 seq；手动保存成功时对请求方额外携带 reqId 作为应答） */
export interface HistoryAddedMsg {
  type: 'history:added'
  version: VersionInfo
  reqId?: string
}

/** 版本恢复：要求所有在线客户端暂停提交、丢弃未确认操作并全量重同步 */
export interface HistoryResetMsg {
  type: 'history:reset'
  reqId: string
  epoch: number
  revision: number
  doc: string
  annotations: Annotation[]
  seq: number
  by: { clientId: string; name: string }
  restoredFrom: { id: string; revision: number; label: string }
  at: number
}

export type ServerErrorCode =
  | 'PERMISSION_DENIED'
  | 'BAD_REVISION'
  | 'RESYNC_REQUIRED'
  | 'BAD_MESSAGE'
  | 'NOT_FOUND'
  | 'INTERNAL'

export interface ErrorMsg {
  type: 'error'
  code: ServerErrorCode
  message: string
  opId?: string
  /** 对应 history:* 请求的 reqId（存在时由对应 Promise 接收，不走通用提示） */
  reqId?: string
}

export interface PongMsg {
  type: 'pong'
  t: number
}

export type ServerMsg =
  | WelcomeMsg
  | OpsMsg
  | AckMsg
  | RemoteOpMsg
  | PresenceMsg
  | RemoteCursorMsg
  | AnnUpsertMsg
  | AnnDeletedMsg
  | HistoryListReply
  | HistoryVersionMsg
  | HistoryAddedMsg
  | HistoryResetMsg
  | ErrorMsg
  | PongMsg
