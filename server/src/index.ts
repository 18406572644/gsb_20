import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, normalize as normalizePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { apply, isNoop, mapPosition } from '../../shared/ot'
import { DocSession, type ClientState } from './docSession'
import { canManageHistory, type LogEntry, type VersionSnapshot } from '../../shared/protocol'
import type { ClientMsg, ServerMsg } from '../../shared/protocol'

const PORT = Number(process.env.PORT || 8080)
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data')
const CLIENT_DIST = join(ROOT, '..', 'client', 'dist')

const DEFAULT_DOC = `# 多人协同批注编辑器（演示文档）

本文档支持多人同时编辑与批注。你可以：

1. 以「编辑」身份直接修改正文，所有修改通过 OT 算法实时合并；
2. 以「批注」身份选中文字后添加批注，批注锚点会随编辑自动移动；
3. 以「只读」身份旁观整个协作过程；
4. 以「管理」身份打开版本历史，查看时间线、变更摘要并恢复到任意历史版本；
5. 点击工具栏「模拟断线」体验断网重连与状态回滚。

试着再开几个浏览器标签页，用不同身份加入同一文档吧。
`

/* ---------------- 文档会话管理 + 持久化 ---------------- */

/**
 * 磁盘布局（DATA_DIR 下，按 docId 隔离）：
 *   <doc>.json                 当前快照（正文 + 批注 + revision + epoch），防抖写
 *   <doc>.archive.jsonl        全量操作日志归档（每行一条 LogEntry，append-only）
 *   <doc>.history.json         版本时间线索引（VersionMeta[]，轻量）
 *   <doc>.versions/<vid>.json  不可变版本快照完整内容（正文 + 批注）
 */
const sessions = new Map<string, DocSession>()
const persistTimers = new Map<string, NodeJS.Timeout>()

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

function enc(docId: string) {
  return encodeURIComponent(docId)
}
function dataFile(docId: string) {
  return join(DATA_DIR, `${enc(docId)}.json`)
}
function archiveFile(docId: string) {
  return join(DATA_DIR, `${enc(docId)}.archive.jsonl`)
}
function historyFile(docId: string) {
  return join(DATA_DIR, `${enc(docId)}.history.json`)
}
function versionDir(docId: string) {
  return join(DATA_DIR, `${enc(docId)}.versions`)
}
function versionFile(docId: string, versionId: string) {
  // versionId 形如 v123-lr1x：只允许安全字符，杜绝路径穿越
  if (!/^[\w.-]+$/.test(versionId)) return null
  return join(versionDir(docId), `${versionId}.json`)
}

/** 原子写：先写临时文件再 rename，避免崩溃产生半截 JSON */
function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

function readArchive(docId: string): LogEntry[] {
  const file = archiveFile(docId)
  if (!existsSync(file)) return []
  const entries: LogEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      entries.push(JSON.parse(t))
    } catch {
      // 跳过损坏行（通常只有最后一行在崩溃时可能截断）
    }
  }
  return entries
}

function loadVersionSnapshot(docId: string, versionId: string): VersionSnapshot | null {
  const file = versionFile(docId, versionId)
  if (!file || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VersionSnapshot
  } catch {
    return null
  }
}

function persistCurrent(session: DocSession) {
  try {
    writeJsonAtomic(dataFile(session.docId), session.serialize())
  } catch (e) {
    console.error('[persist] 当前快照写入失败:', e)
  }
}

function persistHistoryIndex(session: DocSession) {
  try {
    writeJsonAtomic(historyFile(session.docId), session.serializeHistoryIndex())
  } catch (e) {
    console.error('[persist] 版本索引写入失败:', e)
  }
}

function schedulePersist(session: DocSession) {
  if (persistTimers.has(session.docId)) return
  persistTimers.set(
    session.docId,
    setTimeout(() => {
      persistTimers.delete(session.docId)
      persistCurrent(session)
    }, 1500),
  )
}

function wireStorage(s: DocSession) {
  s.onDirty = () => schedulePersist(s)
  s.onArchiveEntries = (entries) => {
    // 操作产生即追加落盘：操作日志不再随进程重启丢失
    try {
      appendFileSync(archiveFile(s.docId), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    } catch (e) {
      console.error('[persist] 操作归档追加失败:', e)
    }
  }
  s.onVersionCreated = (snap) => {
    try {
      const dir = versionDir(s.docId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const file = versionFile(s.docId, snap.id)
      if (file) writeJsonAtomic(file, snap)
      persistHistoryIndex(s)
    } catch (e) {
      console.error('[persist] 版本快照写入失败:', e)
    }
  }
  s.onVersionDeleted = (versionId) => {
    const file = versionFile(s.docId, versionId)
    if (file && existsSync(file)) {
      try {
        rmSync(file)
      } catch {
        /* 忽略 */
      }
    }
    persistHistoryIndex(s)
  }
  s.snapshotLoader = (versionId) => loadVersionSnapshot(s.docId, versionId)
}

function getSession(docId: string): DocSession {
  let s = sessions.get(docId)
  if (s) return s
  const file = dataFile(docId)
  const archive = readArchive(docId)
  if (existsSync(file)) {
    try {
      s = DocSession.deserialize(JSON.parse(readFileSync(file, 'utf8')), archive)
      console.log(
        `[doc] 从磁盘恢复文档 ${docId} (rev=${s.revision}, 归档操作=${archive.length})`,
      )
    } catch (e) {
      console.error('[doc] 恢复失败，使用空文档:', e)
      s = new DocSession(docId, '')
    }
  } else {
    s = new DocSession(docId, docId === 'demo' ? DEFAULT_DOC : '')
  }
  wireStorage(s)

  // 崩溃恢复兜底：当前快照可能落后于归档（防抖写未触发），重放超前的操作，
  // 同时按与在线编辑一致的规则移动批注锚点
  for (const e of archive) {
    if (e.revision >= s.revision) {
      if (!isNoop(e.op)) {
        s.doc = apply(s.doc, e.op)
        for (const ann of s.annotations.values()) {
          ann.start = mapPosition(ann.start, e.op, 'after')
          ann.end = mapPosition(ann.end, e.op, 'before')
          if (ann.end < ann.start) ann.end = ann.start
          ann.orphan = ann.start === ann.end
        }
      }
      s.revision = e.revision + 1
    }
  }

  // 恢复版本时间线；旧数据（无历史）先建立初始基线快照
  if (existsSync(historyFile(docId))) {
    try {
      s.loadHistoryIndex(JSON.parse(readFileSync(historyFile(docId), 'utf8')))
    } catch (e) {
      console.error('[doc] 版本索引恢复失败，重建基线:', e)
      s.bootstrapBaseline()
    }
  } else {
    s.bootstrapBaseline()
  }
  persistCurrent(s)

  sessions.set(docId, s)
  return s
}

/* ---------------- HTTP：健康检查 / 版本 API / 静态托管 ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, docs: sessions.size }))
    return
  }

  // 版本历史 REST API：/api/docs/:docId/versions[/:versionId/restore]
  const apiMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/versions(?:\/([^/]+)\/restore)?\/?$/)
  if (apiMatch) {
    const docId = decodeURIComponent(apiMatch[1])
    const restoreId = apiMatch[2] ? decodeURIComponent(apiMatch[2]) : null
    const session = getSession(docId)
    if (req.method === 'GET' && !restoreId) {
      return json(res, 200, session.listVersions())
    }
    if (req.method === 'POST' && restoreId) {
      // 无独立账号体系：管理权限由调用方显式声明（role=admin），与 WS 角色模型一致
      let body: any = {}
      try {
        body = await readJsonBody(req)
      } catch {
        return json(res, 400, { error: 'BAD_MESSAGE', message: '请求体不是合法 JSON' })
      }
      if (!canManageHistory(body.role)) {
        return json(res, 403, { error: 'PERMISSION_DENIED', message: '仅管理员可恢复历史版本' })
      }
      const admin: ClientState = {
        clientId: `http-${randomUUID()}`,
        name: String(body.name || '管理员').slice(0, 24),
        role: 'admin',
        color: '#2c3e50',
        cursor: null,
        send: () => {},
      }
      const result = session.restoreVersion(admin, restoreId)
      if (!result.ok) {
        return json(res, result.code === 'PERMISSION_DENIED' ? 403 : 404, {
          error: result.code,
          message: result.message,
        })
      }
      persistCurrent(session)
      return json(res, 200, {
        ok: true,
        version: result.version,
        revision: session.revision,
        epoch: session.epoch,
      })
    }
    return json(res, 405, { error: 'BAD_MESSAGE', message: 'method not allowed' })
  }

  // 生产模式：托管 client/dist
  let path = normalizePath(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  if (path === '/' || path === '\\') path = '/index.html'
  const file = join(CLIENT_DIST, path)
  if (existsSync(file) && file.startsWith(CLIENT_DIST)) {
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
    return
  }
  // SPA 回退
  const index = join(CLIENT_DIST, 'index.html')
  if (existsSync(index)) {
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(readFileSync(index))
    return
  }
  res.writeHead(404)
  res.end('client 未构建：请先运行 npm --prefix client run build，或使用 vite dev 模式')
})

/* ---------------- WebSocket ---------------- */

const wss = new WebSocketServer({ server, path: '/ws' })

/** clientId → 连接，用于心跳清理 */
const alive = new Map<string, WebSocket>()

wss.on('connection', (ws: WebSocket) => {
  const connId = randomUUID()
  alive.set(connId, ws)

  let session: DocSession | null = null
  let client: ClientState | null = null

  const send = (msg: ServerMsg | object) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  ws.on('pong', () => alive.set(connId, ws))

  ws.on('message', (raw) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send({ type: 'error', code: 'BAD_MESSAGE', message: '消息不是合法 JSON' })
      return
    }

    try {
      switch (msg.type) {
        case 'join': {
          // 重复 join：先清理旧会话
          if (session && client) {
            session.removeClient(client.clientId)
            session.broadcastAll({ type: 'presence', users: session.users() })
          }
          session = getSession(msg.docId || 'demo')
          client = session.addClient(connId, msg.name, msg.role, send)
          const lastRevision = typeof msg.lastRevision === 'number' ? msg.lastRevision : -1
          const clientEpoch = typeof msg.epoch === 'number' ? msg.epoch : undefined
          const resync = session.buildResync(lastRevision, clientEpoch)
          if (resync.kind === 'ops') {
            // 增量补齐：welcome 不带文档（客户端保留本地文档），随后补发错过的操作流
            send({
              type: 'welcome',
              clientId: connId,
              docId: session.docId,
              revision: session.revision,
              doc: '',
              annotations: [...session.annotations.values()],
              users: session.users(),
              role: client.role,
              snapshot: false,
              seq: session.seq,
              epoch: session.epoch,
            } satisfies ServerMsg)
            session.seq++
            send({
              type: 'ops',
              ops: resync.ops.map((e) => ({
                revision: e.revision,
                op: e.op,
                opId: e.opId,
                clientId: e.clientId,
                authorName: e.authorName,
              })),
              revision: session.revision,
              seq: session.seq,
            } satisfies ServerMsg)
          } else {
            send({
              type: 'welcome',
              clientId: connId,
              docId: session.docId,
              revision: session.revision,
              doc: session.doc,
              annotations: [...session.annotations.values()],
              users: session.users(),
              role: client.role,
              snapshot: true,
              seq: session.seq,
              epoch: session.epoch,
              restored: clientEpoch !== undefined && clientEpoch !== session.epoch,
            } satisfies ServerMsg)
          }
          session.broadcastAll({ type: 'presence', users: session.users() })
          console.log(`[join] ${client.name} (${client.role}) → ${session.docId}，在线 ${session.clients.size} 人`)
          break
        }

        case 'op': {
          if (!session || !client) return
          const err = session.receiveOp(client, msg.revision, msg.op, msg.opId, msg.epoch ?? 0)
          if (err) {
            send({
              type: 'error',
              code: err.code,
              message: err.message,
              opId: msg.opId,
              ...(err.epoch !== undefined ? { epoch: err.epoch } : {}),
            })
          }
          break
        }

        case 'cursor': {
          if (!session || !client) return
          session.updateCursor(client, msg.start, msg.end)
          break
        }

        case 'ann:add': {
          if (!session || !client) return
          const err = session.addAnnotation(client, msg)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'ann:reply': {
          if (!session || !client) return
          const err = session.replyAnnotation(client, msg)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'ann:resolve': {
          if (!session || !client) return
          const err = session.resolveAnnotation(client, msg)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'ann:delete': {
          if (!session || !client) return
          const err = session.deleteAnnotation(client, msg.annId)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'resync': {
          if (!session || !client) return
          const clientEpoch = typeof msg.epoch === 'number' ? msg.epoch : undefined
          const resync = session.buildResync(msg.lastRevision, clientEpoch)
          if (resync.kind === 'ops') {
            session.seq++
            send({
              type: 'ops',
              ops: resync.ops.map((e) => ({
                revision: e.revision,
                op: e.op,
                opId: e.opId,
                clientId: e.clientId,
                authorName: e.authorName,
              })),
              revision: session.revision,
              seq: session.seq,
            } satisfies ServerMsg)
          } else {
            // 全量快照：客户端丢弃本地未确认修改并回滚
            send({
              type: 'welcome',
              clientId: connId,
              docId: session.docId,
              revision: session.revision,
              doc: session.doc,
              annotations: [...session.annotations.values()],
              users: session.users(),
              role: client.role,
              snapshot: true,
              seq: session.seq,
              epoch: session.epoch,
              restored: clientEpoch !== undefined && clientEpoch !== session.epoch,
            } satisfies ServerMsg)
          }
          break
        }

        case 'history:list': {
          if (!session || !client) return
          if (!canManageHistory(client.role)) {
            send({ type: 'history:error', reqId: msg.reqId, code: 'PERMISSION_DENIED', message: '仅管理员可查看版本历史' })
            break
          }
          const { versions, currentRevision, epoch } = session.listVersions()
          send({ type: 'history:list:resp', reqId: msg.reqId, currentRevision, epoch, versions })
          break
        }

        case 'history:get': {
          if (!session || !client) return
          if (!canManageHistory(client.role)) {
            send({ type: 'history:error', reqId: msg.reqId, code: 'PERMISSION_DENIED', message: '仅管理员可查看版本历史' })
            break
          }
          const snap = session.getVersion(msg.versionId)
          if (!snap) {
            send({ type: 'history:error', reqId: msg.reqId, code: 'VERSION_NOT_FOUND', message: '版本不存在或已被清理' })
            break
          }
          send({ type: 'history:get:resp', reqId: msg.reqId, version: snap })
          break
        }

        case 'version:restore': {
          if (!session || !client) return
          const result = session.restoreVersion(client, msg.versionId)
          if (!result.ok) {
            send({ type: 'history:error', reqId: msg.reqId, code: result.code, message: result.message })
            break
          }
          // restoreVersion 已向所有在线客户端（含发起者）广播 restore:begin + 全量 welcome
          persistCurrent(session)
          send({
            type: 'restore:ack',
            reqId: msg.reqId,
            version: result.version,
            revision: session.revision,
            epoch: session.epoch,
          })
          break
        }

        case 'ping': {
          send({ type: 'pong', t: msg.t })
          break
        }
      }
    } catch (e) {
      console.error('[ws] 处理消息异常:', e)
      send({ type: 'error', code: 'INTERNAL', message: '服务器内部错误，请重新同步' })
    }
  })

  ws.on('close', () => {
    alive.delete(connId)
    if (session && client) {
      session.removeClient(client.clientId)
      session.broadcastAll({ type: 'presence', users: session.users() })
      console.log(`[leave] ${client.name} 离开 ${session.docId}，在线 ${session.clients.size} 人`)
    }
  })

  ws.on('error', () => ws.close())
})

/** 心跳：30 秒未响应的连接判定死亡并断开（触发客户端重连逻辑） */
const heartbeat = setInterval(() => {
  for (const [id, ws] of alive) {
    if ((ws as unknown as { isAlive?: boolean }).isAlive === false) {
      alive.delete(id)
      ws.terminate()
      continue
    }
    ;(ws as unknown as { isAlive?: boolean }).isAlive = false
    ws.ping()
    ws.once('pong', () => {
      ;(ws as unknown as { isAlive?: boolean }).isAlive = true
    })
  }
}, 30_000)

wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, () => {
  console.log(`[server] HTTP + WebSocket 已启动: http://localhost:${PORT} (ws: /ws)`)
})

/** 优雅退出：落盘挂起快照、当前状态与所有文档 */
function flushAll() {
  for (const s of sessions.values()) {
    s.flushPendingSnapshot()
    persistCurrent(s)
    persistHistoryIndex(s)
  }
}

function shutdown() {
  clearInterval(heartbeat)
  flushAll()
  for (const ws of alive.values()) ws.terminate()
  alive.clear()
  for (const t of persistTimers.values()) clearTimeout(t)
  wss.close()
  server.close()
}

process.on('SIGTERM', () => {
  flushAll()
  process.exit(0)
})
process.on('SIGINT', () => {
  flushAll()
  process.exit(0)
})

export { server, getSession, shutdown }
