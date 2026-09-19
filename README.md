# 多人协同批注编辑器

基于 **Vue3 + TypeScript + Pinia + Element Plus + WebSocket** 的多人轻量协同批注编辑器。
多人同时编辑 / 批注同一文档，使用 **OT（Operational Transformation）** 解决并发冲突，
支持只读 / 批注 / 编辑 / 管理四种权限，具备断网重连、消息丢失检测、状态回滚，以及
**版本历史（时间线、变更摘要、批注变化）与一键恢复（全员暂停 + 全量重同步）** 能力。

## 功能一览

- **实时协同编辑**：多人在线编辑同一文档，操作经 OT 变换后收敛一致
- **划词批注**：选中文字添加批注，支持回复、解决、删除；批注锚点随编辑自动移动
- **四级权限**：`admin`（管理+编辑+批注+历史恢复）/ `editor`（编辑+批注）/ `commenter`（仅批注）/ `viewer`（只读），服务端逐条校验
- **版本历史**：自动沉淀版本快照，管理员可查看版本时间线（时间、操作者、正文增删、批注变化）、预览任意历史版本的正文与批注
- **版本恢复**：恢复到指定版本时**创建新版本（版本号继续向前，不覆盖历史）**，通过「版本纪元 epoch」通知所有在线客户端暂停本地提交并执行全量重同步，杜绝旧客户端基于过期版本提交
- **操作日志归档**：全量操作日志 append-only 落盘，进程重启后从归档重建，断线增量补齐能力跨重启保留（修复了原「内存 OT 日志随重启丢失」的问题）
- **在线状态**：在线用户列表、远程光标与选区实时展示
- **异常链路**：断网自动重连（指数退避）、离线编辑暂存、消息序号空洞检测、ack 超时重同步、版本过旧/纪元过期时全量快照回滚
- **演示工具栏**：一键「模拟断线 / 重新连接」，直观展示离线编辑与重连同步

## 快速开始

```bash
# 1. 安装依赖（根目录 + server + client）
npm run setup          # 或分别 npm --prefix server install && npm --prefix client install
npm install            # 根目录 concurrently（仅 dev 需要）

# 2. 开发模式（server:8080 + vite:5173，ws 已配置代理）
npm run dev

# 3. 打开 http://localhost:5173 ，多开几个标签页选择不同身份加入同一文档
```

生产模式：

```bash
npm run build          # 构建客户端到 client/dist
npm start              # 服务端托管 API + 静态页面：http://localhost:8080
```

测试与类型检查：

```bash
npm test               # OT 单元测试（含随机 fuzz 收敛性）+ 服务端 e2e
                       # （并发/权限/重连/快照/版本历史/恢复）+ 真实 OTClient 集成
npm run typecheck      # server tsc + client vue-tsc
```

## 目录结构

```
├── shared/               # 前后端共享代码
│   ├── ot.ts             #   OT 核心：apply / transformPair / compose / invert / mapPosition / diffToOp
│   └── protocol.ts       #   协议类型：角色（含 admin）、批注、版本快照、全部 WS/REST 消息
├── server/
│   └── src/
│       ├── docSession.ts #   文档会话：版本日志+全量归档、OT 变换、批注、版本快照/恢复/epoch、重同步
│       └── index.ts      #   HTTP(历史/恢复 API + 静态托管) + WS 入口、归档/快照落盘、心跳
│   └── test/             #   ot.test.ts（性质 fuzz）/ e2e.test.ts（并发·权限·重连）
│                         #   history.e2e.ts（版本快照·时间线·恢复·epoch·落盘重建）
│                         #   otClient.e2e.ts（真实客户端 OTClient × 真实服务端，含恢复集成）
└── client/src/
    ├── collab/collab.ts  #   编排层：连接 × OT × store、历史请求、恢复冻结→全量重同步
    ├── ot/otClient.ts    #   OT 客户端状态机（未确认队列 / 发送节流 / ack 超时 / epoch / freeze）
    ├── ws/wsClient.ts    #   WS 封装（自动重连 / 发送队列 / 心跳）
    ├── stores/           #   Pinia：session（连接·用户·恢复态）/ doc / history（时间线·预览·恢复）
    └── components/       #   EditorView / AnnotationPanel / VersionHistory（历史抽屉）/ TopBar / LoginGate
```

## 核心设计

### OT 并发模型

文档为纯字符串，操作是 `retain(n) / insert(s) / delete(n)` 组件序列：

- 服务端为每个文档维护 `revision` 与操作日志（上限 1000 条）。客户端操作携带基准版本号；
  若已落后，服务端将其对落后期间的全部已接受操作**逐个变换**后应用，再广播给其他人。
- 客户端本地乐观应用，未确认操作进入队列（`unacked[0]` 已发送待确认，其余为缓冲，
  连续输入经 `compose` 合并）。远程操作到达时与全部未确认操作做双侧变换。
- 同位置并发插入的先后由「先被服务端接受者优先」的全局约定打破，保证各端收敛。
- 正确性由 `server/test/ot.test.ts` 中的随机 fuzz 性质测试保障
  （`apply(apply(S,a),b') === apply(apply(S,b),a')`、compose 结合律、invert 往返、三方并发收敛）。

### 批注锚点

批注锚定 `[start, end)` 区间。服务端与客户端在每次应用操作时都用 `mapPosition`
移动锚点（起点 `after`、终点 `before`，边界输入不扩选）；锚点文本被完全删除时
批注转为「孤儿」状态（📌 标记，保留原文引用）。

### 断网重连与消息可靠性

| 异常 | 检测 | 恢复 |
| --- | --- | --- |
| 断网 / 假死 | WS close、应用层 ping/pong 心跳（10s/5s） | 指数退避重连（1s→2s→…→15s + 抖动），重连后带 `lastRevision` 重新 join |
| 离线编辑 | — | 编辑进入 OT 队列、批注进入 outbox，重连并重同步后自动补发 |
| 消息丢失（下行） | 广播消息携带单调 `seq`，客户端检测空洞 | 发送 `resync`，服务端按版本补发 `ops`（含按 opId 去重自己的操作） |
| 消息丢失（上行/ack） | ack 5s 超时 | 同上触发 resync |
| 版本过旧 | 服务端日志不足以覆盖客户端版本 | 下发全量快照，客户端**回滚**未确认修改并提示 |
| 权限/协议错误 | 服务端逐条校验返回 `error` | 前端提示，必要时自动 resync |

### 版本历史与恢复

围绕「当前快照之外，还要能回溯、能恢复，且恢复不允许旧客户端写花数据」设计：

**版本快照（VersionSnapshot / VersionMeta）**

- 每个文档维护一条按 revision 递增的版本时间线。快照在三类时机产生：
  - **初始基线**：文档首次加载（或旧数据首次升级）时落一个基线快照；
  - **自动快照**：每累计 `AUTO_SNAPSHOT_INTERVAL`（默认 20）次正文编辑落一个；
  - **批注快照**：批注新增/回复/解决/删除后 2s 防抖落一个（连续批注合并为同一版本）；
  - **恢复版本**：每次恢复显式落一个 `source=restore` 的新版本。
- 快照保存该 revision 上的**完整正文 + 批注集合**（不可变），元数据还含相对上一快照的
  变更摘要：插入/删除字数、编辑次数、操作者列表，以及批注的 新增/回复/解决/重开/删除 计数。
- 历史版本默认保留最近 200 个（`MAX_VERSIONS`），超出修剪最旧版本及其快照文件。

**操作日志归档（解决「内存日志随重启丢失」）**

- 每条被接受的操作在推进内存状态的同时**即时 append** 到 `DATA_DIR/<doc>.archive.jsonl`
  （JSON Lines，原子追加），不再只活在内存里。
- 进程重启后从归档文件重建全量 `archive`，近期日志取其尾部填充 `log`——
  因此断线增量补齐（`buildResync`）与版本摘要统计在重启后依然可用。
- 当前快照写盘仍是 1.5s 防抖；启动时若发现归档领先于快照（防抖未及落盘），
  会重放超前操作并同步移动批注锚点兜底。

**恢复流程（创建新版本，而非回退版本号）**

1. 管理员通过 WS `version:restore`（或 REST `POST /api/docs/:id/versions/:vid/restore`）发起；
2. 服务端校验权限与目标版本后，**版本纪元 `epoch` 先 +1**；
3. 以「当前正文 → 目标正文」的 `diffToOp` 合成一条 `kind=restore` 操作正常提交，
   **revision 继续向前**（历史可继续追溯，永不回退版本号）；批注整体替换为目标版本；
4. 落一个 `source=restore` 快照，记录 `restoredFromId / restoredBy`；
5. 广播 `restore:begin`（占用恢复操作的 seq 槽位，避免空洞），随后向**所有在线客户端**
   （含发起者）下发 `restored=true` 的全量 `welcome`。

**防止旧客户端基于过期版本提交（epoch 纪元）**

- 客户端 `join` 时获得当前 `epoch`，之后每条 `op` 都回传；服务端对 epoch 不匹配的提交
  一律返回 `RESYNC_REQUIRED`（携带服务端 epoch），从根本上拒绝过期写入。
- 客户端收到 `restore:begin` 立即 `OTClient.freeze()`：编辑器只读、丢弃未确认操作、
  停止一切提交；待恢复触发的全量快照到达后 `rollback(revision, epoch)` 解冻。
- 即便某客户端恰好错过 `restore:begin`（恢复瞬间断线/丢包），其旧 epoch 提交会被拒，
  客户端据此进入冻结并主动全量重同步；重连 `join` / `resync` 也会因 epoch 不一致被服务端
  直接判为全量快照。三重路径保证恢复后所有端必然收敛到同一新版本。

> 说明：本演示的管理员角色在加入时选定（与既有角色模型一致，无独立账号体系）；
> 服务端已在每条历史/恢复消息与 REST 接口上做 `canManageHistory` 校验，接入真实鉴权后
> 只需把角色来源替换为登录态即可。

### 实时推送频率与性能权衡

- **编辑操作**：本地乐观应用零延迟；发送端做 **60ms 节流合并**（`minSendInterval`），
  连续打字合并为一条消息，ack 后立即发送缓冲批次 —— 用可忽略的延迟换取消息数量级下降。
- **光标/选区**：120ms 节流、易失消息（不计 seq、不持久化、断线即弃），不参与可靠性链路。
- **presence**：仅 join/leave 时广播。
- **持久化**：文档当前状态变更后 1.5s 防抖写盘（`server/data/*.json`）；**每条操作即时
  append 到 `*.archive.jsonl`**（不丢日志）；版本快照写入 `*.versions/<vid>.json`，时间线索引
  写入 `*.history.json`。重启后用「当前快照 + 归档重放 + 版本索引」完整重建。
- **渲染**：高亮层按「边界切分」一次计算 HTML，避免逐字 span；大文档下 diff 为
  公共前后缀算法，单点编辑 O(1) 生成操作。

### 已知取舍（轻量化的边界）

- 单文档模型为纯文本（非富文本），编辑器用 `textarea + 高亮背景层` 实现，
  避免 contenteditable 的选区/IME 复杂度；IME 组合输入期间不做 diff。
- 服务端为单进程内存状态 + 文件持久化；多实例部署需引入共享存储与消息总线。
- 角色在加入时选定（演示用），未实现管理员在线改权；服务端已按消息逐条鉴权，
  接入真实账号体系后可直接复用校验点。
- 批注锚点在「本地未确认操作 + 并发远程操作」的极端交错下可能与服务端有字符级偏差，
  任何重同步都会以服务端为准收敛。

## 协议摘要

客户端 → 服务端（WS）：`join`（含 lastRevision、epoch）/ `op`（含 opId+revision+epoch）/ `cursor` /
`ann:add|reply|resolve|delete` / `resync`（含 epoch）/ `history:list` / `history:get` /
`version:restore` / `ping`

服务端 → 客户端（WS）：`welcome`（snapshot/epoch/restored + seq）/ `ops`（增量补发）/ `ack` / `op` /
`presence` / `cursor` / `ann:upsert|delete` / `restore:begin`（恢复广播，全员冻结）/
`history:list:resp` / `history:get:resp` / `restore:ack` / `history:error` /
`error`（PERMISSION_DENIED、BAD_REVISION、RESYNC_REQUIRED、VERSION_NOT_FOUND…，可携带 epoch）/ `pong`

REST（生产模式，与 WS 同源）：

- `GET  /api/docs/:docId/versions` —— 版本时间线（VersionMeta[]、currentRevision、epoch）
- `POST /api/docs/:docId/versions/:versionId/restore` —— 管理员恢复（body：`{ role: 'admin', name? }`），
  成功后同样广播 `restore:begin` 并对在线客户端全量重同步；返回新版本与新 epoch。

> 磁盘布局（`DATA_DIR`，按 docId 隔离）：`<doc>.json`（当前快照）、
> `<doc>.archive.jsonl`（全量操作日志，append-only）、`<doc>.history.json`（版本时间线索引）、
> `<doc>.versions/<vid>.json`（不可变版本快照）。
