/**
 * 版本历史与恢复测试：
 * - DocSession 单元层：快照生成（init/手动/自动/恢复前/已恢复）、变更统计、
 *   批注隔离、恢复（epoch/版本号回退/日志清空/reset 广播）、纪元围栏、
 *   持久化往返与旧数据迁移；
 * - WS 端到端：owner 保存 / 恢复 → 全员收敛、旧纪元操作拒绝、权限控制、
 *   恢复后携带旧纪元重连强制全量快照。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, transformPair, type Op } from '../../shared/ot'
import type { Role, ServerMsg } from '../../shared/protocol'

process.env.PORT = '18093'
process.env.AUTO_SNAPSHOT_OPS = '3'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-hist-'))

const { DocSession, AUTO_SNAPSHOT_OPS } = await import('../src/docSession')
const { server, shutdown } = await import('../src/index')

assert.equal(AUTO_SNAPSHOT_OPS, 3)

const BASE = 'ws://localhost:18093/ws'

/* ---------------- 单元测试辅助 ---------------- */

function fakeClient(role: Role) {
  const sent: object[] = []
  return {
    state: {
      clientId: `c-${role}`,
      name: `用户${role}`,
      role,
      color: '#000000',
      cursor: null,
      send: (m: object) => sent.push(m),
    },
    sent,
  }
}

function opOk(
  s: InstanceType<typeof DocSession>,
  c: ReturnType<typeof fakeClient>,
  revision: number,
  op: Op,
  opId: string,
) {
  const err = s.receiveOp(c.state, revision, s.epoch, op, opId)
  assert.equal(err, null, `操作应被接受: ${JSON.stringify(err)}`)
}

/* ---------------- DocSession 单元测试 ---------------- */

test('unit: 新文档自动留存 init 快照', () => {
  const s = new DocSession('u-init', 'hello')
  const { versions, current } = s.listHistory()
  assert.equal(versions.length, 1)
  assert.equal(versions[0].reason, 'init')
  assert.equal(versions[0].revision, 0)
  assert.equal(versions[0].docLength, 5)
  assert.equal(versions[0].head, true)
  assert.equal(current.versionId, versions[0].id)
})

test('unit: 仅 owner 可保存 / 恢复版本', () => {
  const s = new DocSession('u-perm', '')
  for (const role of ['viewer', 'commenter', 'editor'] as Role[]) {
    const c = fakeClient(role)
    const save = s.saveVersion(c.state, 'x')
    assert.equal('code' in save && save.code, 'PERMISSION_DENIED')
    const restore = s.restoreVersion(c.state, 'whatever', 'r1')
    assert.equal('code' in restore && restore.code, 'PERMISSION_DENIED')
  }
})

test('unit: 手动快照记录操作者与插入/删除统计、批注增量', () => {
  const s = new DocSession('u-manual', '')
  const owner = fakeClient('owner')
  opOk(s, owner, 0, [{ insert: 'abcdef' }], 'op-1')
  const addErr = s.addAnnotation(owner.state, {
    annId: 'a1',
    start: 1,
    end: 3,
    quote: 'bc',
    text: '批注内容',
  })
  assert.equal(addErr, null)

  const saved = s.saveVersion(owner.state, '里程碑')
  assert.ok(!('code' in saved))
  if ('code' in saved) return
  assert.equal(saved.version.reason, 'manual')
  assert.equal(saved.version.label, '里程碑')
  assert.equal(saved.version.opCount, 1)
  assert.equal(saved.version.changes.length, 1)
  assert.deepEqual(
    { ...saved.version.changes[0], clientId: '' },
    { clientId: '', authorName: '用户owner', ops: 1, inserted: 6, deleted: 0 },
  )
  assert.equal(saved.version.annotationDelta.added, 1)
  assert.equal(saved.version.annotationCount, 1)

  // 删除操作统计
  opOk(s, owner, 1, [{ retain: 2 }, { delete: 2 }, { retain: 2 }], 'op-2')
  const v2 = s.saveVersion(owner.state)
  if ('code' in v2) throw new Error('保存失败')
  assert.equal(v2.version.changes[0].deleted, 2)
})

test('unit: 达到阈值自动快照', () => {
  const s = new DocSession('u-auto', '')
  const owner = fakeClient('owner')
  // 注册到会话，自动快照的 history:added 广播才能送达
  s.clients.set(owner.state.clientId, owner.state)
  opOk(s, owner, 0, [{ insert: 'a' }], 'a1')
  opOk(s, owner, 1, [{ retain: 1 }, { insert: 'b' }], 'a2')
  assert.equal(s.versions.length, 1)
  opOk(s, owner, 2, [{ retain: 2 }, { insert: 'c' }], 'a3')
  assert.equal(s.versions.length, 2)
  assert.equal(s.versions[1].reason, 'auto')
  assert.equal(s.versions[1].changes[0].inserted, 3)
  // 自动快照广播不携带 reqId（易失广播）
  const added = owner.sent.find((m) => (m as { type?: string }).type === 'history:added') as
    | { reqId?: string }
    | undefined
  assert.ok(added)
  assert.equal(added.reqId, undefined)
})

test('unit: 历史快照中的批注不被后续编辑篡改（深拷贝隔离）', () => {
  const s = new DocSession('u-isolate', '')
  const owner = fakeClient('owner')
  opOk(s, owner, 0, [{ insert: 'abcdef' }], 'i1')
  s.addAnnotation(owner.state, { annId: 'a1', start: 1, end: 3, quote: 'bc', text: 't' })
  const snap = s.saveVersion(owner.state)
  if ('code' in snap) throw new Error('保存失败')
  const before = s.getVersion(snap.version.id)!.annotations[0]
  assert.deepEqual({ start: before.start, end: before.end }, { start: 1, end: 3 })

  // 后续在开头插入 2 字符：活动批注移动到 [3,5)，快照批注必须仍是 [1,3)
  opOk(s, owner, 1, [{ insert: '>>' }, { retain: 6 }], 'i2')
  const after = s.getVersion(snap.version.id)!.annotations[0]
  assert.deepEqual({ start: after.start, end: after.end }, { start: 1, end: 3 })
})

test('unit: 恢复 —— 纪元+1、版本号回退、日志清空、pre/restored 快照与 reset 广播', () => {
  const s = new DocSession('u-restore', 'base')
  const owner = fakeClient('owner')
  opOk(s, owner, 0, [{ retain: 4 }, { insert: 'XXX' }], 'r1')
  assert.equal(s.doc, 'baseXXX')
  const target = s.versions[0] // init 快照（doc='base', revision=0）

  const result = s.restoreVersion(owner.state, target.id, 'req-restore')
  assert.ok(!('code' in result))
  if ('code' in result) return

  assert.equal(s.epoch, 1)
  assert.equal(s.revision, 0)
  assert.equal(s.doc, 'base')
  assert.equal(s.log.length, 0)

  // 时间线：init → pre-restore(rev=1,epoch=0) → restored(rev=0,epoch=1)
  const reasons = s.versions.map((v) => v.reason)
  assert.deepEqual(reasons, ['init', 'pre-restore', 'restored'])
  const pre = s.versions[1]
  assert.equal(pre.revision, 1)
  assert.equal(pre.epoch, 0)
  assert.equal(pre.doc, 'baseXXX')
  const restored = s.versions[2]
  assert.equal(restored.revision, 0)
  assert.equal(restored.epoch, 1)
  assert.deepEqual(restored.restoredFrom, { id: target.id, revision: 0, label: '初始版本' })
  // restored 快照不携带区间操作 / 统计归零
  assert.equal(restored.ops.length, 0)
  assert.equal(restored.changes.length, 0)

  // reset 广播到达管理者（全员广播的一员）
  assert.equal(result.reset.type, 'history:reset')
  assert.equal(result.reset.epoch, 1)
  assert.equal(result.reset.revision, 0)
  assert.equal(result.reset.reqId, 'req-restore')
  assert.deepEqual(result.reset.restoredFrom, { id: target.id, revision: 0, label: '初始版本' })

  // 恢复后新操作基于恢复后的文档正常接受，revision 从 0 继续
  opOk(s, owner, 0, [{ retain: 4 }, { insert: 'Y' }], 'r2')
  assert.equal(s.doc, 'baseY')
  assert.equal(s.revision, 1)
  assert.equal(s.log[0].epoch, 1)
})

test('unit: 旧纪元操作在恢复后被拒绝（即使 revision 对得上）', () => {
  const s = new DocSession('u-fence', 'base')
  const owner = fakeClient('owner')
  const target = s.versions[0]
  s.restoreVersion(owner.state, target.id, 'req')
  assert.equal(s.epoch, 1)
  // 恢复后 revision 为 0，客户端拿着 epoch=0/revision=0 提交
  const err = s.receiveOp(owner.state, 0, 0, [{ retain: 4 }, { insert: 'z' }], 'stale')
  assert.equal(err?.code, 'RESYNC_REQUIRED')
  // 当前纪元正常接受
  assert.equal(s.receiveOp(owner.state, 0, 1, [{ retain: 4 }, { insert: 'z' }], 'fresh'), null)
})

test('unit: 序列化往返保留 epoch/版本时间线/日志并重建区间归档', () => {
  const s1 = new DocSession('u-persist', '')
  const owner = fakeClient('owner')
  opOk(s1, owner, 0, [{ insert: 'hello' }], 'p1')
  s1.saveVersion(owner.state, 'v1')
  // 最新快照之后又有一条操作：应从持久化日志重建到 opsSinceSnapshot
  opOk(s1, owner, 1, [{ retain: 5 }, { insert: '!' }], 'p2')

  const s2 = DocSession.deserialize(s1.serialize())
  assert.equal(s2.epoch, 0)
  assert.equal(s2.revision, 2)
  assert.equal(s2.versions.length, 2)
  assert.equal(s2.log.length, 2)

  const again = s2.saveVersion(fakeClient('owner').state, 'v2')
  if ('code' in again) throw new Error('保存失败')
  // v2 区间只包含重建出来的 1 条操作（p2）
  assert.equal(again.version.opCount, 1)
  assert.equal(again.version.changes[0].inserted, 1)
})

test('unit: 旧数据文件（无 versions/log）迁移出 init 快照', () => {
  const s = DocSession.deserialize({
    docId: 'u-legacy',
    doc: '旧文档',
    revision: 42,
    annotations: [],
  } as never)
  assert.equal(s.epoch, 0)
  assert.equal(s.revision, 42)
  assert.equal(s.versions.length, 1)
  assert.equal(s.versions[0].reason, 'init')
  assert.equal(s.versions[0].doc, '旧文档')
  assert.equal(s.log.length, 0)
})

/* ---------------- WS 端到端 ---------------- */

class HistClient {
  ws: WebSocket
  clientId = ''
  doc = ''
  revision = 0
  epoch = 0
  pending: { opId: string; op: Op } | null = null
  inbox: ServerMsg[] = []
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
  private opCounter = 0

  constructor(
    readonly name: string,
    readonly role: Role,
    readonly docId: string,
  ) {
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
      case 'welcome':
        this.clientId = msg.clientId
        this.epoch = msg.epoch
        if (msg.snapshot) {
          this.doc = msg.doc
          this.revision = msg.revision
          this.pending = null
        } else {
          this.revision = msg.revision
        }
        break
      case 'ops':
        for (const e of msg.ops) {
          if (this.pending?.opId === e.opId) {
            this.pending = null
            continue
          }
          if (this.pending) {
            const [r, p] = transformPair(e.op, this.pending.op)
            this.doc = apply(this.doc, r)
            this.pending.op = p
          } else {
            this.doc = apply(this.doc, e.op)
          }
        }
        this.revision = msg.revision
        break
      case 'ack':
        this.pending = null
        this.revision = msg.revision
        break
      case 'op':
        if (this.pending) {
          const [r, p] = transformPair(msg.op, this.pending.op)
          this.doc = apply(this.doc, r)
          this.pending.op = p
        } else {
          this.doc = apply(this.doc, msg.op)
        }
        this.revision = msg.revision + 1
        break
      case 'history:reset':
        this.doc = msg.doc
        this.revision = msg.revision
        this.epoch = msg.epoch
        this.pending = null
        break
    }
  }

  async open() {
    await new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.once('open', () => resolve())
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
      lastRevision,
      epoch: epoch ?? (typeof lastRevision === 'number' ? this.epoch : undefined),
    })
    await this.waitFor((m) => m.type === 'welcome')
  }

  send(obj: object) {
    this.ws.send(JSON.stringify(obj))
  }

  edit(text: string, forcedEpoch?: number) {
    const opId = `${this.name}-${this.opCounter++}`
    const op = [{ insert: text }] as Op
    this.doc = apply(this.doc, op)
    this.pending = { opId, op }
    this.send({ type: 'op', revision: this.revision, epoch: forcedEpoch ?? this.epoch, op, opId })
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
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

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('ws: owner 保存版本 → 全员收到 history:added，时间线含变更摘要', async () => {
  const docId = 'ws-history-save'
  const owner = new HistClient('管理员', 'owner', docId)
  const editor = new HistClient('编辑甲', 'editor', docId)
  await owner.join()
  await editor.join()

  editor.edit('正文内容')
  await owner.waitFor((m) => m.type === 'op')
  await new Promise((r) => setTimeout(r, 50))

  owner.send({ type: 'history:save', reqId: 'req-save', label: '发布稿' })
  const reply = (await owner.waitFor(
    (m) => m.type === 'history:added' && (m as { reqId?: string }).reqId === 'req-save',
  )) as { type: 'history:added'; version: { label: string; changes: { authorName: string; inserted: number }[] } }
  assert.equal(reply.version.label, '发布稿')
  assert.equal(reply.version.changes[0].inserted, 4)
  // 非请求方收到无 reqId 的广播
  await editor.waitFor((m) => m.type === 'history:added' && !(m as { reqId?: string }).reqId)

  // 列表
  owner.send({ type: 'history:list', reqId: 'req-list' })
  const list = (await owner.waitFor(
    (m) => m.type === 'history:list' && (m as { reqId?: string }).reqId === 'req-list',
  )) as { versions: { reason: string }[] }
  assert.ok(list.versions.some((v) => v.reason === 'manual'))

  owner.close()
  editor.close()
})

test('ws: 非 owner 访问历史被拒绝；不存在的版本返回 NOT_FOUND', async () => {
  const docId = 'ws-history-perm'
  const editor = new HistClient('编辑乙', 'editor', docId)
  const owner = new HistClient('管理员', 'owner', docId)
  await editor.join()
  await owner.join()

  editor.send({ type: 'history:list', reqId: 'bad-1' })
  const err1 = await editor.waitFor(
    (m) => m.type === 'error' && (m as { reqId?: string }).reqId === 'bad-1',
  )
  assert.equal((err1 as { code: string }).code, 'PERMISSION_DENIED')

  owner.send({ type: 'history:get', reqId: 'get-x', versionId: 'missing-id' })
  const err2 = await owner.waitFor(
    (m) => m.type === 'error' && (m as { reqId?: string }).reqId === 'get-x',
  )
  assert.equal((err2 as { code: string }).code, 'NOT_FOUND')

  editor.close()
  owner.close()
})

test('ws: owner 恢复初始版本 → 全员收敛、版本号/纪元更新、旧纪元操作被拒', async () => {
  const docId = 'ws-history-restore'
  const owner = new HistClient('管理员', 'owner', docId)
  const editor = new HistClient('编辑丙', 'editor', docId)
  await owner.join()
  await editor.join()

  editor.edit('后来添加的内容')
  await owner.waitFor((m) => m.type === 'op')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(owner.doc, editor.doc)

  // 找到 init 版本并恢复
  owner.send({ type: 'history:list', reqId: 'req-l2' })
  const list = (await owner.waitFor(
    (m) => m.type === 'history:list' && (m as { reqId?: string }).reqId === 'req-l2',
  )) as { versions: { id: string; reason: string }[] }
  const init = [...list.versions].reverse().find((v) => v.reason === 'init')!

  owner.send({ type: 'history:restore', reqId: 'req-restore', versionId: init.id })
  const reset = (await Promise.all([
    owner.waitFor((m) => m.type === 'history:reset'),
    editor.waitFor((m) => m.type === 'history:reset'),
  ]))[0] as { epoch: number; revision: number; doc: string; restoredFrom: { revision: number } }

  assert.equal(reset.epoch, 1)
  assert.equal(reset.revision, 0)
  assert.equal(reset.doc, '') // 新文档初始为空
  assert.equal(reset.restoredFrom.revision, 0)
  assert.equal(owner.doc, '')
  assert.equal(editor.doc, '')
  assert.equal(owner.epoch, 1)
  assert.equal(editor.epoch, 1)

  // 编辑端若仍持有旧纪元（epoch=0）提交 → 拒绝（裸发送：不做乐观应用，模拟请求被拒后等待重同步）
  editor.send({
    type: 'op',
    revision: editor.revision,
    epoch: 0,
    op: [{ insert: '旧纪元内容' }],
    opId: 'stale-epoch-op',
  })
  const err = await editor.waitFor(
    (m) => m.type === 'error' && (m as { code: string }).code === 'RESYNC_REQUIRED',
  )
  assert.ok(err)

  // 当前纪元的新编辑正常
  editor.edit('新纪元内容')
  await owner.waitFor((m) => m.type === 'op')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(owner.doc, editor.doc)
  assert.equal(owner.epoch, 1)

  owner.close()
  editor.close()
})

test('ws: 恢复后携带旧纪元重连 → 强制全量快照', async () => {
  const docId = 'ws-history-reconnect'
  const owner = new HistClient('管理员', 'owner', docId)
  await owner.join()
  owner.edit('待恢复内容')
  await owner.waitFor((m) => m.type === 'ack')

  owner.send({ type: 'history:list', reqId: 'req-l3' })
  const list = (await owner.waitFor(
    (m) => m.type === 'history:list' && (m as { reqId?: string }).reqId === 'req-l3',
  )) as { versions: { id: string; reason: string }[] }
  const init = [...list.versions].reverse().find((v) => v.reason === 'init')!
  owner.send({ type: 'history:restore', reqId: 'req-r3', versionId: init.id })
  await owner.waitFor((m) => m.type === 'history:reset')
  assert.equal(owner.epoch, 1)
  owner.close()

  // 旧标签页：本地仍以为自己在 epoch 0 / 旧 revision，重连必须拿到全量快照
  const stale = new HistClient('旧标签', 'editor', docId)
  await stale.join(1, 0)
  const welcome = stale.inbox.find((m) => m.type === 'welcome') as {
    snapshot: boolean
    epoch: number
    doc: string
  }
  assert.equal(welcome.snapshot, true)
  assert.equal(welcome.epoch, 1)
  assert.equal(welcome.doc, '')
  stale.close()
})
