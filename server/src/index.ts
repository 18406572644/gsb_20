import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize as normalizePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { DocSession, type ClientState } from './docSession'
import type { ClientMsg, LogEntry, ServerMsg } from '../../shared/protocol'
import { canManage } from '../../shared/protocol'

const PORT = Number(process.env.PORT || 8080)
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data')
const CLIENT_DIST = join(ROOT, '..', 'client', 'dist')

const DEFAULT_DOC = `# 多人协同批注编辑器（演示文档）

本文档支持多人同时编辑与批注。你可以：

1. 以「编辑」身份直接修改正文，所有修改通过 OT 算法实时合并；
2. 以「批注」身份选中文字后添加批注，批注锚点会随编辑自动移动；
3. 以「只读」身份旁观整个协作过程；
4. 点击工具栏「模拟断线」体验断网重连与状态回滚；
5. 以「管理者」身份打开版本历史，查看变更摘要并恢复到任意历史版本。

试着再开几个浏览器标签页，用不同身份加入同一文档吧。
`

/* ---------------- 文档会话管理 + 持久化 ---------------- */

const sessions = new Map<string, DocSession>()
const persistTimers = new Map<string, NodeJS.Timeout>()

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

function dataFile(docId: string) {
  return join(DATA_DIR, `${encodeURIComponent(docId)}.json`)
}

function persistNow(session: DocSession) {
  try {
    writeFileSync(dataFile(session.docId), JSON.stringify(session.serialize(), null, 2))
  } catch (e) {
    console.error('[persist] 写入失败:', e)
  }
}

/**
 * 调度持久化：默认 1500ms 防抖合并；immediate=true（手动保存 / 恢复）时
 * 取消待写定时器并立即同步落盘。
 */
function schedulePersist(session: DocSession, immediate = false) {
  const pending = persistTimers.get(session.docId)
  if (pending) {
    clearTimeout(pending)
    persistTimers.delete(session.docId)
  }
  if (immediate) {
    persistNow(session)
    return
  }
  persistTimers.set(
    session.docId,
    setTimeout(() => {
      persistTimers.delete(session.docId)
      persistNow(session)
    }, 1500),
  )
}

function getSession(docId: string): DocSession {
  let s = sessions.get(docId)
  if (s) return s
  const file = dataFile(docId)
  if (existsSync(file)) {
    try {
      s = DocSession.deserialize(JSON.parse(readFileSync(file, 'utf8')))
      console.log(`[doc] 从磁盘恢复文档 ${docId} (rev=${s.revision}, epoch=${s.epoch}, 版本=${s.versions.length})`)
    } catch (e) {
      console.error('[doc] 恢复失败，使用空文档:', e)
      s = new DocSession(docId, '')
    }
  } else {
    s = new DocSession(docId, docId === 'demo' ? DEFAULT_DOC : '')
  }
  s.onDirty = (immediate?: boolean) => schedulePersist(s!, immediate)
  sessions.set(docId, s)
  return s
}

/* ---------------- HTTP：健康检查 + 生产模式静态托管 ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, docs: sessions.size }))
    return
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

  /** 按 buildResync 结果下发：增量（join 时 welcome + ops；主动 resync 仅 ops）或全量快照 welcome */
  const sendResync = (
    resync: ReturnType<DocSession['buildResync']>,
    includeWelcome: boolean,
  ) => {
    if (!session || !client) return
    if (resync.kind === 'ops') {
      if (includeWelcome) {
        // 增量补齐：welcome 不带文档（客户端保留本地文档），随后补发错过的操作流
        send({
          type: 'welcome',
          clientId: connId,
          docId: session.docId,
          revision: session.revision,
          epoch: session.epoch,
          doc: '',
          annotations: [...session.annotations.values()],
          users: session.users(),
          role: client.role,
          snapshot: false,
          seq: session.seq,
        } satisfies ServerMsg)
      }
      session.seq++
      send({
        type: 'ops',
        ops: resync.ops.map((e: LogEntry) => ({
          revision: e.revision,
          op: e.op,
          opId: e.opId,
          clientId: e.clientId,
          authorName: e.authorName,
          timestamp: e.timestamp,
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
        epoch: session.epoch,
        doc: session.doc,
        annotations: [...session.annotations.values()],
        users: session.users(),
        role: client.role,
        snapshot: true,
        seq: session.seq,
      } satisfies ServerMsg)
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
          sendResync(session.buildResync(lastRevision, msg.epoch), true)
          session.broadcastAll({ type: 'presence', users: session.users() })
          console.log(`[join] ${client.name} (${client.role}) → ${session.docId}，在线 ${session.clients.size} 人`)
          break
        }

        case 'op': {
          if (!session || !client) return
          const err = session.receiveOp(client, msg.revision, msg.epoch, msg.op, msg.opId)
          if (err) send({ type: 'error', code: err.code, message: err.message, opId: msg.opId })
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
          sendResync(session.buildResync(msg.lastRevision, msg.epoch), false)
          break
        }

        /* ---------------- 版本历史（仅 owner） ---------------- */

        case 'history:list': {
          if (!session || !client) return
          if (!canManage(client.role)) {
            send({ type: 'error', code: 'PERMISSION_DENIED', message: '仅管理者可查看版本历史', reqId: msg.reqId })
            return
          }
          send({ type: 'history:list', reqId: msg.reqId, ...session.listHistory() } satisfies ServerMsg)
          break
        }

        case 'history:get': {
          if (!session || !client) return
          if (!canManage(client.role)) {
            send({ type: 'error', code: 'PERMISSION_DENIED', message: '仅管理者可查看版本历史', reqId: msg.reqId })
            return
          }
          const version = session.getVersion(msg.versionId)
          if (!version) {
            send({ type: 'error', code: 'NOT_FOUND', message: '版本不存在或已被裁剪', reqId: msg.reqId })
            return
          }
          send({ type: 'history:version', reqId: msg.reqId, version } satisfies ServerMsg)
          break
        }

        case 'history:save': {
          if (!session || !client) return
          const result = session.saveVersion(client, msg.label)
          if ('code' in result) {
            send({ type: 'error', code: result.code, message: result.message, reqId: msg.reqId })
            return
          }
          // buildSnapshot 已向全员广播 history:added；此处对请求方补带 reqId 的应答
          send({ type: 'history:added', version: result.version, reqId: msg.reqId } satisfies ServerMsg)
          break
        }

        case 'history:restore': {
          if (!session || !client) return
          // reset 已在 restoreVersion 内广播给所有人（含请求方），此处仅负责错误应答
          const result = session.restoreVersion(client, msg.versionId, msg.reqId)
          if ('code' in result) {
            send({ type: 'error', code: result.code, message: result.message, reqId: msg.reqId })
          }
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

export function shutdown() {
  clearInterval(heartbeat)
  // 关闭前把防抖窗口内未落盘的变更同步写盘（恢复 / 手动保存本身已立即落盘）
  for (const [docId, timer] of persistTimers) {
    clearTimeout(timer)
    const s = sessions.get(docId)
    if (s) persistNow(s)
  }
  persistTimers.clear()
  for (const ws of alive.values()) ws.terminate()
  alive.clear()
  wss.close()
  server.close()
}

export { server, getSession }
