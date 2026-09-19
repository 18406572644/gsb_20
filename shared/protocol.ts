/**
 * 客户端 / 服务端 WebSocket 协议定义。
 * 所有消息均为 JSON 文本帧，含 type 字段。
 */
import type { Op } from './ot'

/**
 * 角色：viewer 只读 / commenter 可批注 / editor 可编辑+批注 /
 * admin 具备 editor 全部能力，并可查看版本历史、预览历史版本、发起恢复。
 */
export type Role = 'viewer' | 'commenter' | 'editor' | 'admin'

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '只读',
  commenter: '批注',
  editor: '编辑',
  admin: '管理',
}

export function canEdit(role: Role): boolean {
  return role === 'editor' || role === 'admin'
}

export function canAnnotate(role: Role): boolean {
  return role === 'editor' || role === 'commenter' || role === 'admin'
}

/** 查看版本时间线 / 预览历史版本 / 发起恢复，仅管理员 */
export function canManageHistory(role: Role): boolean {
  return role === 'admin'
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
  op: Op
  opId: string
  clientId: string
  authorName: string
  /** 应用该操作前的文档长度（用于校验客户端操作的基准版本） */
  lenBefore: number
  /** 操作类别：普通编辑（默认）/ 版本恢复合成操作（归档与时间线展示用） */
  kind?: 'edit' | 'restore'
  /** kind === 'restore' 时，恢复来源的版本快照 id */
  restoreFrom?: string
  /** 服务端接受该操作的时间戳（ms），用于操作日志归档与时间线 */
  timestamp?: number
}

/* ---------------- 版本历史 ---------------- */

/** 一条批注自上一版本快照以来的变化计数（用于时间线变更摘要） */
export interface AnnChangeSummary {
  added: number
  replied: number
  resolved: number
  reopened: number
  deleted: number
}

/** 版本来源：自动快照 / 手动保存（预留）/ 恢复产生的新版本 */
export type VersionSource = 'auto' | 'manual' | 'restore'

/**
 * 版本快照元数据（时间线条目）。
 * 快照保存某一 revision 上的完整正文与批注集合；操作日志在相邻快照间连续归档，
 * 二者共同构成可回溯的版本历史。
 */
export interface VersionMeta {
  /** 快照唯一 id（基于 revision 与时间戳，稳定可引用） */
  id: string
  /** 该快照对应的文档版本号（单调递增，恢复不回退） */
  revision: number
  createdAt: number
  /** 该版本相对上一快照的正文变更摘要（由区间内操作日志汇总） */
  summary: {
    inserts: number
    deletes: number
    /** 区间内编辑操作条数 */
    ops: number
    /** 区间内贡献过编辑的操作者 */
    authors: { clientId: string; name: string }[]
  }
  /** 该版本相对上一快照的批注变化 */
  annotationChanges: AnnChangeSummary
  source: VersionSource
  /** source === 'restore' 时，恢复自哪个版本 id */
  restoredFromId?: string
  /** source === 'restore' 时的操作者 */
  restoredBy?: { clientId: string; name: string }
  /** 手动/自动保存时的备注（预留，目前为空） */
  label?: string
}

/** 版本快照完整内容（预览/恢复依据） */
export interface VersionSnapshot extends VersionMeta {
  doc: string
  annotations: Annotation[]
}

/* ---------------- 客户端 → 服务端 ---------------- */

export interface JoinMsg {
  type: 'join'
  docId: string
  name: string
  role: Role
  /** 断线重连时携带本地已同步到的版本号，用于增量补齐 */
  lastRevision?: number
  /** 本地当前版本纪元；与服务端不一致（断线期间发生过恢复）时强制全量快照 */
  epoch?: number
}

export interface OpMsg {
  type: 'op'
  revision: number
  op: Op
  opId: string
  /** 客户端加入时获得的版本纪元，恢复后过期的提交据此被拒绝 */
  epoch: number
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
  /** 本地版本纪元；与服务端不一致时强制全量快照 */
  epoch?: number
}

/** 管理员：拉取版本时间线（仅元数据，不含正文） */
export interface HistoryListMsg {
  type: 'history:list'
  reqId: string
}

/** 管理员：获取某个历史版本的完整快照（正文 + 批注）用于预览 */
export interface HistoryGetMsg {
  type: 'history:get'
  reqId: string
  versionId: string
}

/** 管理员：将文档恢复到指定版本（恢复会创建新版本，不覆盖历史） */
export interface VersionRestoreMsg {
  type: 'version:restore'
  reqId: string
  versionId: string
}

export interface PingMsg {
  type: 'ping'
  t: number
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
  | HistoryListMsg
  | HistoryGetMsg
  | VersionRestoreMsg
  | PingMsg

/* ---------------- 服务端 → 客户端 ---------------- */

export interface WelcomeMsg {
  type: 'welcome'
  clientId: string
  docId: string
  revision: number
  doc: string
  annotations: Annotation[]
  users: UserInfo[]
  role: Role
  /** 重连时若 true 表示服务端日志已不足以增量补齐，本消息为全量快照 */
  snapshot: boolean
  /** 当前文档广播序号，客户端据此检测后续消息空洞 */
  seq: number
  /**
   * 版本纪元：每次版本恢复 +1。客户端 join/重连后记录该值并在提交 op 时回传；
   * 纪元不匹配的提交会被拒绝（防止旧客户端基于恢复前的过期版本提交）。
   */
  epoch: number
  /** true 表示本次全量快照由一次版本恢复触发（客户端可提示「文档已被恢复」） */
  restored?: boolean
}

/** 增量补齐：重连后补发错过的操作 */
export interface OpsMsg {
  type: 'ops'
  ops: { revision: number; op: Op; opId: string; clientId: string; authorName: string }[]
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

/* ---------------- 版本历史 / 恢复 ---------------- */

export interface HistoryListRespMsg {
  type: 'history:list:resp'
  reqId: string
  currentRevision: number
  epoch: number
  versions: VersionMeta[]
}

export interface HistoryGetRespMsg {
  type: 'history:get:resp'
  reqId: string
  version: VersionSnapshot
}

export interface RestoreAckMsg {
  type: 'restore:ack'
  reqId: string
  version: VersionMeta
  revision: number
  epoch: number
}

/**
 * 恢复开始：广播给文档内所有在线客户端（含发起者）。
 * 客户端收到后必须立即暂停本地提交（OT 进入冻结态），等待随后的全量 welcome 快照；
 * 在此期间基于旧版本提交的操作会被服务端以 epoch 不匹配拒绝。
 */
export interface RestoreBeginMsg {
  type: 'restore:begin'
  fromVersionId: string
  by: { clientId: string; name: string }
  seq: number
}

export interface HistoryErrorMsg {
  type: 'history:error'
  reqId: string
  code: 'PERMISSION_DENIED' | 'VERSION_NOT_FOUND' | 'RESYNC_REQUIRED' | 'INTERNAL'
  message: string
}

export type ServerErrorCode =
  | 'PERMISSION_DENIED'
  | 'BAD_REVISION'
  | 'BAD_MESSAGE'
  | 'VERSION_NOT_FOUND'
  | 'RESYNC_REQUIRED'
  | 'INTERNAL'

export interface ErrorMsg {
  type: 'error'
  code: ServerErrorCode
  message: string
  opId?: string
  /** 版本纪元：收到该错误（尤其恢复导致的过期提交）时，客户端应同步到该 epoch */
  epoch?: number
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
  | HistoryListRespMsg
  | HistoryGetRespMsg
  | RestoreAckMsg
  | RestoreBeginMsg
  | HistoryErrorMsg
  | ErrorMsg
  | PongMsg
