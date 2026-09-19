/**
 * 版本历史与恢复 e2e：
 * - 自动版本快照（每 20 次编辑 / 批注活动防抖）
 * - 时间线、变更摘要、操作者
 * - 管理权限控制
 * - 恢复：广播 restore:begin → 全员全量重同步 → epoch 推进
 * - 旧 epoch 提交被拒、以新 epoch 重连后恢复编辑
 * - HTTP 历史 / 恢复接口
 * - 操作归档与版本快照落盘（重启不丢日志）
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { apply, transformPair, type Op } from '../../shared/ot'
import type {
  HistoryListRespMsg,
  ServerMsg,
  VersionMeta,
  VersionSnapshot,
  WelcomeMsg,
} from '../../shared/protocol'

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-history-'))
process.env.PORT = '18095'
process.env.DATA_DIR = DATA_DIR
const { server, shutdown } = await import('../src/index')

const BASE = 'ws://localhost:18095/ws'
const HTTP = 'http://localhost:18095'

class HistoryClient {
  ws: WebSocket
  name: string
  role: string
  docId: string
  clientId = ''
  doc = ''
  revision = 0
  epoch: number | undefined
  pending: { opId: string; op: Op } | null = null
  restoreBegins = 0
  restoredWelcomes = 0
  inbox: ServerMsg[] = []
  private reqCounter = 0
  private opCounter = 0
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []

  constructor(name: string, role: string, docId: string) {
    this.name = name
    this.role = role
    this.docId = docId
    this.ws = new WebSocket(BASE)
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg
      this.inbox.push(msg)
      this.handle(msg)
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg)
          return false
        }
        return true
      })
    })
    this.ws.on('error', () => {})
  }

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case 'welcome': {
        const w = msg as WelcomeMsg
        this.clientId = w.clientId
        this.epoch = w.epoch
        if (w.snapshot) {
          this.doc = w.doc
          this.revision = w.revision
          this.pending = null
          if (w.restored) this.restoredWelcomes++
        } else {
          this.revision = w.revision
        }
        break
      }
      case 'ops': {
        for (const e of msg.ops) {
          if (this.pending && this.pending.opId === e.opId) {
            this.pending = null
            continue
          }
          if (this.pending) {
            const [rP, pP] = transformPair(e.op, this.pending.op)
            this.doc = apply(this.doc, rP)
            this.pending.op = pP
          } else {
            this.doc = apply(this.doc, e.op)
          }
        }
        this.revision = msg.revision
        break
      }
      case 'ack':
        this.pending = null
        this.revision = msg.revision
        break
      case 'op': {
        if (this.pending) {
          const [rP, pP] = transformPair(msg.op, this.pending.op)
          this.doc = apply(this.doc, rP)
          this.pending.op = pP
        } else {
          this.doc = apply(this.doc, msg.op)
        }
        this.revision = msg.revision + 1
        break
      }
      case 'restore:begin':
        this.restoreBegins++
        break
    }
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
  }

  async join(lastRevision?: number, epoch?: number) {
    await this.open()
    this.send({
      type: 'join',
      docId: this.docId,
      name: this.name,
      role: this.role,
      ...(lastRevision === undefined ? {} : { lastRevision }),
      ...(epoch === undefined ? {} : { epoch }),
    })
    await this.waitFor((m) => m.type === 'welcome')
  }

  send(obj: object) {
    this.ws.send(JSON.stringify(obj))
  }

  /** 末尾追加文本，走乐观应用 + 等 ack */
  async edit(text: string) {
    const opId = `${this.name}-op-${this.opCounter++}`
    const op: Op = [{ retain: this.doc.length }, { insert: text }]
    this.doc = apply(this.doc, op)
    this.pending = { opId, op }
    this.send({ type: 'op', revision: this.revision, op, opId, epoch: this.epoch ?? 0 })
    await this.waitFor((m) => m.type === 'ack' && (m as { opId: string }).opId === opId)
  }

  /** 不经客户端状态机直接提交（用于构造过期 epoch 提交） */
  rawOp(op: Op, revision: number, epoch: number, opId: string) {
    this.send({ type: 'op', revision, op, opId, epoch })
  }

  addAnnotation(text: string) {
    this.send({ type: 'ann:add', annId: `ann-${this.reqCounter++}`, start: 0, end: 0, quote: '', text })
  }

  async listVersions(): Promise<HistoryListRespMsg> {
    const reqId = `r-${this.reqCounter++}`
    this.send({ type: 'history:list', reqId })
    return (await this.waitFor(
      (m) => (m.type === 'history:list:resp' || m.type === 'history:error') && (m as { reqId: string }).reqId === reqId,
    )) as HistoryListRespMsg
  }

  async getVersion(versionId: string): Promise<VersionSnapshot> {
    const reqId = `r-${this.reqCounter++}`
    this.send({ type: 'history:get', reqId, versionId })
    const m = (await this.waitFor(
      (x) =>
        (x.type === 'history:get:resp' || x.type === 'history:error') &&
        (x as { reqId: string }).reqId === reqId,
    )) as { type: string; version?: VersionSnapshot; code?: string }
    if (m.type !== 'history:get:resp') throw new Error(`getVersion 失败: ${m.code}`)
    return m.version!
  }

  async restore(versionId: string) {
    const reqId = `r-${this.reqCounter++}`
    this.send({ type: 'version:restore', reqId, versionId })
    return this.waitFor(
      (m) =>
        (m.type === 'restore:ack' || m.type === 'history:error') &&
        (m as { reqId?: string }).reqId === reqId,
    )
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 5000): Promise<ServerMsg> {
    const hit = this.inbox.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  close() {
    this.ws.close()
  }
}

async function waitUntil<T>(
  fn: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  timeout = 5000,
  step = 100,
): Promise<T> {
  const t0 = Date.now()
  let v: T | false | null | undefined = await fn()
  while (!v) {
    if (Date.now() - t0 > timeout) throw new Error('waitUntil 超时')
    await new Promise((r) => setTimeout(r, step))
    v = await fn()
  }
  return v as T
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('版本: 初始基线 + 每 20 次编辑自动快照，摘要正确', async () => {
  const docId = 'hist-auto'
  const admin = new HistoryClient('管理员A', 'admin', docId)
  await admin.join()

  let list = await admin.listVersions()
  assert.equal(list.type, 'history:list:resp')
  assert.equal(list.currentRevision, 0)
  assert.equal(list.epoch, 0)
  // 新文档建立初始基线快照
  assert.equal(list.versions.length, 1)
  const baseline = list.versions[0]
  assert.equal(baseline.revision, 0)
  assert.equal(baseline.source, 'auto')

  // 连续 20 次编辑，每次插入 10 字符
  for (let i = 0; i < 20; i++) await admin.edit('abcdefghij')
  assert.equal(admin.doc.length, 200)

  list = await admin.listVersions()
  assert.equal(list.currentRevision, 20)
  const auto = list.versions.find((v) => v.revision === 20)!
  assert.ok(auto, '应在第 20 次编辑处生成自动快照')
  assert.equal(auto.summary.inserts, 200)
  assert.equal(auto.summary.deletes, 0)
  assert.equal(auto.summary.ops, 20)
  assert.equal(auto.summary.authors.length, 1)
  assert.equal(auto.summary.authors[0].name, '管理员A')
  // 时间线倒序：最新在前
  assert.ok(list.versions[0].revision >= list.versions[1].revision)

  admin.close()
})

test('版本: 批注活动防抖生成快照，记录批注变化', async () => {
  const docId = 'hist-ann'
  const admin = new HistoryClient('管理员M', 'admin', docId)
  await admin.join()
  await admin.edit('一段需要批注的正文内容示例')

  admin.addAnnotation('这是一条批注')
  // 等待 2s 防抖后的批注快照
  const v = await waitUntil(async () => {
    const l = await admin.listVersions()
    return l.versions.find((x) => x.annotationChanges.added > 0) || false
  })
  assert.ok(v.annotationChanges.added >= 1)
  admin.close()
})

test('版本: 权限 —— 非管理员不能查看时间线/恢复', async () => {
  const docId = 'hist-perm'
  const admin = new HistoryClient('root', 'admin', docId)
  const editor = new HistoryClient('ed', 'editor', docId)
  const commenter = new HistoryClient('cm', 'commenter', docId)
  const viewer = new HistoryClient('vw', 'viewer', docId)
  await admin.join()
  await editor.join()
  await commenter.join()
  await viewer.join()

  for (const c of [editor, commenter, viewer]) {
    const r = await c.listVersions()
    assert.equal(r.type, 'history:error')
    assert.equal((r as unknown as { code: string }).code, 'PERMISSION_DENIED')
    const rr = await c.restore('whatever')
    assert.equal(rr.type, 'history:error')
    assert.equal((rr as unknown as { code: string }).code, 'PERMISSION_DENIED')
  }

  // 管理员访问不存在的版本
  const reqId = 'missing-1'
  admin.send({ type: 'history:get', reqId, versionId: 'v-nope' })
  const err = await admin.waitFor(
    (m) => m.type === 'history:error' && (m as { reqId: string }).reqId === reqId,
  )
  assert.equal((err as unknown as { code: string }).code, 'VERSION_NOT_FOUND')

  admin.close()
  editor.close()
  commenter.close()
  viewer.close()
})

test('版本: 恢复到历史版本 —— 全员重同步、epoch 防护、版本继续前进', async () => {
  const docId = 'hist-restore'
  const admin = new HistoryClient('root', 'admin', docId)
  const editor = new HistoryClient('writer', 'editor', docId)
  await admin.join()
  await editor.join()

  const before = await admin.listVersions()
  const baseline: VersionMeta = before.versions.find((v) => v.revision === 0)!

  for (let i = 0; i < 20; i++) {
    await admin.edit('XYZ')
  }
  assert.equal(admin.doc.length, 60)
  // editor 追平
  await waitUntil(() => editor.doc.length === 60)

  // 恢复到初始空版本
  const ack = await admin.restore(baseline.id)
  assert.equal(ack.type, 'restore:ack')
  const ackBody = ack as unknown as { version: VersionMeta; revision: number; epoch: number }
  assert.equal(ackBody.version.source, 'restore')
  assert.equal(ackBody.version.restoredFromId, baseline.id)
  assert.equal(ackBody.epoch, 1)

  // 双方都收到 restore:begin 与 restored 全量快照，正文回到空
  await waitUntil(() => admin.restoreBegins > 0 && editor.restoreBegins > 0)
  await waitUntil(() => admin.restoredWelcomes > 0 && editor.restoredWelcomes > 0)
  assert.equal(admin.doc, '')
  assert.equal(editor.doc, '')
  assert.equal(admin.epoch, 1)
  assert.equal(editor.epoch, 1)
  // 版本号不回退：恢复合成 1 条操作，20 → 21
  assert.equal(admin.revision, 21)
  assert.equal(ackBody.revision, 21)

  // 时间线新增 restore 版本
  const after = await admin.listVersions()
  assert.equal(after.epoch, 1)
  assert.ok(after.versions.some((v) => v.source === 'restore'))
  const restoreSnap = await admin.getVersion(ackBody.version.id)
  assert.equal(restoreSnap.doc, '')

  // 旧 epoch（0）的在途提交被拒，并下发新 epoch
  editor.rawOp([{ retain: editor.doc.length }, { insert: '过期操作' }], editor.revision, 0, 'stale-1')
  const err = (await editor.waitFor((m) => m.type === 'error')) as unknown as {
    code: string
    epoch: number
  }
  assert.equal(err.code, 'RESYNC_REQUIRED')
  assert.equal(err.epoch, 1)

  // 客户端以新 epoch 重连（带当前 revision）→ 增量补齐通过，恢复正常编辑
  await editor.join(editor.revision, 1)
  await editor.edit('新内容')
  assert.equal(editor.doc, '新内容')
  assert.equal(editor.revision, 22)
  await waitUntil(() => admin.doc === '新内容')

  admin.close()
  editor.close()
})

test('版本: HTTP 接口 —— 时间线列表与恢复鉴权', async () => {
  const docId = 'hist-http'
  // 先通过 WS 产生文档与基线
  const admin = new HistoryClient('httpadmin', 'admin', docId)
  await admin.join()
  await admin.edit('hello history')
  admin.close()

  const listRes = await fetch(`${HTTP}/api/docs/${encodeURIComponent(docId)}/versions`)
  assert.equal(listRes.status, 200)
  const listBody = await listRes.json()
  assert.ok(Array.isArray(listBody.versions))
  assert.equal(listBody.currentRevision, 1)
  const baseline: VersionMeta = listBody.versions.find((v: VersionMeta) => v.revision === 0)

  // 非管理员恢复 → 403
  const denied = await fetch(`${HTTP}/api/docs/${encodeURIComponent(docId)}/versions/${baseline.id}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'editor', name: 'ed' }),
  })
  assert.equal(denied.status, 403)

  // 管理员恢复 → 200，正文回到基线（空）
  const ok = await fetch(`${HTTP}/api/docs/${encodeURIComponent(docId)}/versions/${baseline.id}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', name: '运维' }),
  })
  assert.equal(ok.status, 200)
  const okBody = await ok.json()
  assert.equal(okBody.ok, true)
  assert.equal(okBody.revision, 2)
  assert.equal(okBody.epoch, 1)
  assert.equal(okBody.version.source, 'restore')

  // 恢复不存在版本 → 404
  const nf = await fetch(`${HTTP}/api/docs/${encodeURIComponent(docId)}/versions/v-nope/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  })
  assert.equal(nf.status, 404)
})

test('版本: 操作日志与版本快照已落盘（重启不丢日志）', async () => {
  const docId = 'hist-disk'
  const enc = encodeURIComponent(docId)
  const admin = new HistoryClient('disker', 'admin', docId)
  await admin.join()
  for (let i = 0; i < 3; i++) await admin.edit('0123456789')
  admin.close()
  // 等待防抖当前快照写盘
  await new Promise((r) => setTimeout(r, 1700))

  const archivePath = join(DATA_DIR, `${enc}.archive.jsonl`)
  const historyPath = join(DATA_DIR, `${enc}.history.json`)
  const versionDirPath = join(DATA_DIR, `${enc}.versions`)
  assert.ok(existsSync(archivePath), '操作归档文件应存在')
  assert.ok(existsSync(historyPath), '版本索引文件应存在')
  assert.ok(existsSync(versionDirPath), '版本快照目录应存在')

  const lines = readFileSync(archivePath, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 3, '每条操作都应追加到归档')
  const first = JSON.parse(lines[0])
  assert.equal(first.revision, 0)
  assert.equal(first.kind, 'edit')
  assert.ok(typeof first.timestamp === 'number')

  const index = JSON.parse(readFileSync(historyPath, 'utf8'))
  assert.ok(Array.isArray(index.versions))
  assert.ok(index.versions.length >= 1)

  const files = readdirSync(versionDirPath).filter((f) => f.endsWith('.json'))
  assert.ok(files.length >= 1, '至少有基线快照文件')
  const snap = JSON.parse(readFileSync(join(versionDirPath, files[0]), 'utf8')) as VersionSnapshot
  assert.equal(typeof snap.doc, 'string')
  assert.ok(Array.isArray(snap.annotations))
})

test('版本: 模拟重启 —— 从当前快照+归档重建会话，日志/时间线/重放一致', async () => {
  const docId = 'hist-reload'
  const enc = encodeURIComponent(docId)
  const admin = new HistoryClient('reloader', 'admin', docId)
  await admin.join()
  for (let i = 0; i < 5; i++) await admin.edit('RELOAD')
  assert.equal(admin.doc.length, 30)
  admin.close()
  await new Promise((r) => setTimeout(r, 1700))

  // 模拟新进程：仅从磁盘读取当前快照、归档、版本索引来重建
  const { DocSession } = await import('../src/docSession')
  const current = JSON.parse(readFileSync(join(DATA_DIR, `${enc}.json`), 'utf8'))
  const archiveEntries = readFileSync(join(DATA_DIR, `${enc}.archive.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const restored = DocSession.deserialize(current, archiveEntries)
  restored.loadHistoryIndex(JSON.parse(readFileSync(join(DATA_DIR, `${enc}.history.json`), 'utf8')))

  assert.equal(restored.revision, 5)
  assert.equal(restored.doc.length, 30, '重放归档后正文应一致')
  // 近期日志来自归档尾部，断线增量补齐能力跨重启保留
  assert.equal(restored.log.length, 5)
  assert.equal(restored.log[0].revision, 0)
  assert.equal(restored.log[4].revision, 4)
  // 时间线保留（基线快照）
  assert.ok(restored.versions.some((v) => v.revision === 0))
  // 用归档日志能为落后客户端补齐到最新
  const resync = restored.buildResync(2, 0)
  assert.equal(resync.kind, 'ops')
  if (resync.kind === 'ops') assert.equal(resync.ops.length, 3)
})
