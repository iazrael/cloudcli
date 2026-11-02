# CloudCLI 多节点架构设计

> **状态:设计已定稿,尚未实施。** 本文件不是架构事实;落地后请将内容并入 `docs/core/`(涉及 `overview.md`、`providers.md`、`chat.md`、`frontend.md`),并删除本文件。

## 1. 目标

一个 hub 统管多台机器(本机 + 若干 Linux / macOS / Windows 节点)。执行留在各节点,UI 是窗口。新增机器无需公网 IP、无需入站端口、无需地址配置。

## 2. 不变量

1. hub 不触碰**工作区**文件系统、不 spawn **执行**进程;唯一例外是本地 node 守护进程的 supervisor。hub 自身持有 DB 与自身配置。
2. 本机与远端在**接口层**完全一致;生命周期与传输层不同(见 §3),这是部署事实。
3. 每一层都不无界缓冲,下游消费能力逐层映射为上游 `pause()`。
4. 运行实例归节点所有;hub 只持有视图与历史。
5. 能力矩阵按节点上报。
6. hub 生命周期与执行生命周期解耦。
7. 节点无对外端口;节点内部有 loopback 控制面,仅节点内可达、永不隧道出去。

## 3. 拓扑与职责

```
hub(常驻,可部署在任意机器)            node 守护进程 × N
──────────────────────────────      ──────────────────────────────
DB、UI、鉴权、项目/节点注册表    ◀──── 主动连接(心跳 + 退避重连)
chat timeline、聚合路由、推送   ────▶ 归一化 RPC / 通用流
插件配置与密钥、调度            node 内 loopback 控制面(不对外)
```

| node 位置 | 传输 | 生命周期 |
|---|---|---|
| 本机 | UDS(Linux / macOS)/ loopback TCP(Windows) | hub 作为父进程拉起并守护,detached 运行,hub 退出后继续 |
| 远端 | WSS over Tailscale(**唯一支持路径**) | systemd(Linux)/ launchd(macOS)/ Windows 服务 / PM2 |

远端 macOS 节点使用 **LaunchAgent(用户会话)**,以便访问用户 login keychain 与 provider 登录凭证。

**归属(按「谁拥有文件或进程」划线)**

| 归属 | 内容 |
|---|---|
| node | providers(runtime、sessions、mcp 注册)、shell PTY、file-tree、git(含 worktree 目录)、browser-use(含 MCP stdio 链与 Chromium)、插件(目录、manifest、安装/构建、子进程、loopback 端口、assets 文件)、session 文件扫描与 watcher、引擎安装探测与路径解析、taskmaster 的执行侧 |
| hub | DB、用户鉴权、项目与节点注册表、chat timeline 与视图、插件列表缓存与配置/密钥、scheduled-messages 调度、推送、前端、聚合与路由 |

分类标准是**消费者在哪一侧**:同节点进程间调用(provider → MCP → browser-use、插件 → git)完全留在节点内,不下沉协议;只有浏览器消费的资源才隧道过节点连接。

## 4. 通信协议

### 4.1 传输

- 单条全双工连接承载逻辑流多路复用;连接方向固定 node → hub;节点不监听对外端口。
- **两条连接**:连接 A = 控制面 + 可续流(REQ/RES/EVENT、chat-run、session-sync、fs、plugin-http、browser 控制);连接 B = 交互隧道(PTY、plugin-ws、browser 画面)。B 断线即 `RESET`,由 UI 重建。
- 保活:心跳 15s,45s 无响应判断开。重连指数退避,上限 30s。睡眠/唤醒按断线重连处理。
- 协议兼容 **N-1**;不匹配 → `GOAWAY`,节点标 degraded,由 `system.upgrade` 升级。

### 4.2 帧格式

二进制,8 字节头:`u8 type | u24 streamId | u32 length | payload`。

| type | 名称 | 载荷 |
|---|---|---|
| 1 / 2 | `HELLO` / `HELLO_ACK` | JSON:协议版本、nodeId、平台、守护进程版本、能力矩阵 |
| 3 / 4 | `REQ` / `RES` | JSON:`{id, method, params, idempotencyKey?}` / `{id, ok, result/error}` |
| 5 | `OPEN` | JSON:流元数据(含 `kind`、`initialWindow`、可选 `resume:{streamId,lastSeq}`) |
| 6 | `DATA` | 原始字节,单帧 ≤ 256KB |
| 7 | `WINDOW` | JSON:`{credit}` |
| 8 / 9 | `CLOSE` / `RESET` | JSON;RESET 含 `reason: cancelled \| unresumable \| error` |
| 10 | `EVENT` | JSON:节点主动上报(能力变更、插件状态、安装进度、待答审批) |
| 11 / 12 | `PING` / `PONG` | 空 |
| 13 | `GOAWAY` | JSON:优雅下线 / 版本不兼容 |
| 14 | `META` | JSON:`{status, headers}`;HTTP 类隧道的响应元数据,先于 `DATA` |

`HELLO`/`REQ`/`RES`/`EVENT`/`PING`/`PONG`/`GOAWAY` 使用 streamId 0;`OPEN`/`DATA`/`WINDOW`/`CLOSE`/`RESET`/`META` 使用所属流的 streamId。控制面 JSON,数据面裸字节。

`OPEN.kind` 取值:`chat-run`、`session-sync`、`fs-http`、`plugin-http`、`plugin-ws`、`browser-view`。

### 4.3 流控

每条流独立字节信用窗口,初始 256KB。发送方仅在 `sent - acked < window` 时发 `DATA`;接收方消费后回 `WINDOW{credit}`。端到端贯通:浏览器消费慢 → hub 依据浏览器 socket `bufferedAmount` 不补发 WINDOW → node 流挂起(`fs.createReadStream.pause()` / `pty.pause()` / `child.stdout.pause()`)。各层透传,不做出站缓冲堆积。

### 4.4 请求语义

- 每个 `REQ` 带唯一 `id`,连接重建后重置。
- 变更类操作(file write、git commit、rewind、mcp 写入、插件安装)带 `idempotencyKey`;node 维护有界 TTL 去重表。
- `RESET` 映射到 provider abort 与进程终止。

### 4.5 重连与续传

- 可续流每帧带单调 `seq`;重连后 hub 发 `OPEN{resume}`,node 从**内存有界环形缓冲**(每 session 5000 事件)回放后接续实时。
- 环形缓冲溢出:该 session 标「历史有缺口」,hub 走 `session.fetchHistory` 从 provider transcript 补齐(transcript 在节点上)。
- PTY 与交互隧道不可续:`RESET{reason:'unresumable'}`,UI 提示重建。
- 待答审批:node 维护 pending 注册表,重连后以 `EVENT` 重播全部未答请求。
- 守护进程重启:在飞 run 全部标 `interrupted`,UI 提供「rewind 后重跑」。

### 4.6 流类型语义

| kind | 方向 | 语义 |
|---|---|---|
| `chat-run` | node → hub | run 事件流,可续,写前在 hub DB 落盘后才向浏览器广播 |
| `session-sync` | node → hub | session 扫描结果,经 RPC upsert 进 hub DB |
| `fs-http` | hub → node | 文件读写等请求/响应 |
| `plugin-http` | hub → node | 浏览器请求转发:`META{status,headers}` + `DATA` 响应体 |
| `plugin-ws` | 双向 | 裸字节隧道 |
| `browser-view` | node → hub | 浏览器画面/控制流 |

**隧道目标只允许具名实体**(`{plugin: name}` 或 `{browser: sessionId}`),由 node 侧解析成 loopback 端口;**绝不接受 `host:port`**,防止 hub 失陷等于节点 loopback SSRF。

### 4.7 RPC 面

| 分组 | 方法 |
|---|---|
| `system` | `hello`、`capabilities`、`probe`、`restart`、`upgrade` |
| `engine` | `list`、`run`、`compact`、`abort`、`respond` |
| `session` | `fetchHistory`、`resolveEditAnchor`、`rewind`、`fork`、`cleanup`、`tokenUsage`、`list` |
| `fs` | `browseFilesystem`、`list`、`read`、`write`、`create`、`rename`、`delete`、`externalFile` |
| `git` | status/diff/stage/commit/branches/push/worktree 等类型化操作 |
| `pty` | `open`、`resize`、`close` |
| `mcp` | `list`、`upsert`、`remove`(在节点执行,配置在节点) |
| `plugin` | `list`、`manifest`、`install`、`update`、`uninstall`、`setEnabled`、`start`、`stop`、`status` |
| `browser` | `list`、`create`、`close`、`snapshot`、`navigate`、`click`、`type`、`fillForm`、`pressKey`、`selectOption`、`waitFor`、`tabs` |

## 5. hub 路由层

```ts
await nodes.for(nodeId).engine.run(...)
await nodes.for(nodeId).fs.read(...)
await nodes.for(nodeId).git.commit(...)
await nodes.for(nodeId).plugin.install(...)
```

本机 client 与远端 client 实现**同一接口**,共用同一套分帧与流控,差异只在底层 stream。所有调用点统一走 `nodes.for(nodeId)`,不存在按节点分支的调用。接口从第一天就是流式(async iterator / 事件帧)。

## 6. 插件

- **归属**:node 拥有插件目录、manifest 扫描、安装/构建(`git clone`、`npm install --ignore-scripts`、`npm run build`)、子进程、loopback 端口、assets 文件;hub 拥有列表缓存、配置与密钥、浏览器入口。
- **浏览器三条路径全部隧道**:

| 浏览器(hub 源) | node 动作 |
|---|---|
| `GET /api/nodes/:nodeId/plugins/:name/assets/*` | 校验路径在插件目录内 → `fs.createReadStream` → `plugin-http` 流 |
| `ALL /api/nodes/:nodeId/plugins/:name/rpc/*` | 解析插件名 → loopback 端口,本地 HTTP,回 `META` + body |
| `WS /plugin-ws/:nodeId/:name` | 连 `127.0.0.1:<plugin port>`,裸字节双向 |

- **密钥不落 node 盘**:secrets 存 hub 配置,按 `(node_id, name)` 分键;每次转发请求时由 hub 附 `x-plugin-secret-*`,node 只透传。
- manifest 列表在 hub 缓存(节点离线也能渲染侧栏,标离线);安装/更新进度、进程崩溃经 `EVENT` 上报。
- 前端:`PluginContext` 增加 `nodeId`;旧路径 `/api/plugins/...`、`/plugin-ws/:name` 作为 `local` 节点别名保留。
- 插件 UI 维持 hub 同源全权(可调 hub API),记为已知信任边界。
- 节点离线:插件标不可用,RPC/WS 返回 503,不阻塞其他插件。

## 7. browser-use

- **MCP 路径(同节点消费,不经 hub)**:provider CLI 在 node 上 spawn `browser-use-mcp.js` stdio 桥,桥回调**节点内部 loopback 控制面**;token 由 node 守护进程启动时生成,注册 MCP 时写入 provider 配置,守护进程重启即轮换并重新注册。MCP 注册经 `mcp.upsert` 在节点执行(provider 配置在节点)。
- **UI 路径(浏览器消费)**:画面走连接 B 的 `browser-view` 流,会话控制走 `browser.*` RPC。
- runtime 留在 node 守护进程内,与 run/PTY 同生命周期;守护进程重启 → 浏览器会话结束,UI 重建。
- 就绪状态(playwright / chromium / 系统依赖)进能力矩阵,缺依赖节点标不可用;macOS 支持 darwin x64 / arm64。

## 8. 节点内部 loopback 控制面

- 形态:loopback HTTP + 进程级 token(供 MCP stdio 桥等节点内子进程回连)。只在节点内可达,**永不隧道出去**,不监听对外地址。
- 与插件端口一样,是节点内部实现细节,hub 不感知。

## 9. 数据模型

```sql
nodes(
  id, name, platform, agent_version, status,
  capabilities json, token_hash, last_seen_at, created_at,
  approval_timeout_overrides json
)
projects + node_id          -- 默认 'local'
sessions + node_id
plugin_config(node_id, name, secrets)
session_history_cache(node_id, session_id)
plugin_manifest_cache(node_id, manifests)
```

- 路径按节点解释:`resolvePathInsideProject` / `validateWorkspacePath` / 插件 assets 路径校验全部在 node 侧;hub 不做路径推断。
- 项目以 `(node_id, path)` 为身份,按「节点 → 项目」展示。
- 能力矩阵按节点缓存(带 TTL);前端 `useProviderCapabilities(nodeId)`。
- `local` 为本地节点保留 id,与 `projects.node_id` 默认值同源。

## 10. 生命周期与持久化

### 10.1 本地守护进程

- hub 实例标识 `CLOUDCLI_HUB_ID`,默认 `${HOST}:${SERVER_PORT}`。
- 状态目录 `~/.cloudcli/agents/<dirName>/`:socket(POSIX)/ 端口号文件(Windows)、`meta.json`(原始 hubId、pid、protocolVersion、startedAt、版本)、token 文件。
- `dirName` 为 hubId 经净化后的目录名:非 `[A-Za-z0-9._-]` 字符替换为 `_`(Windows 不允许 `:`),原始 hubId 存在 `meta.json` 中校验;POSIX 下 socket 路径保持在 `sun_path` 上限内(macOS 104 字节,超限改用短哈希目录)。
- 启动:读 `meta.json` → 校验(socket 可连接 + token + 协议版本匹配,不依赖 pid)→ 有效则复用,否则清理陈旧标记 → detached + unref spawn → 等 socket 就绪 → 写标记 → 连接。
- 断连:指数退避重连,超阈值将该节点标 degraded。
- 回收:hub 主动停止时经控制面 SIGTERM 回收;卸载时清理。同 hubId 下只存在一个实例;多 hub(dev 3001 / 生产 3030)目录隔离互不干扰。
- 凭证保护:Linux / macOS 使用 `0600`;Windows 使用 ACL / DPAPI。
- 现有 `local-server.json` 固定路径问题随迁移改为按 hubId 隔离。

### 10.2 持久化边界

文件系统持久化**「发生过什么」**,不持久化**「正在运行的进程」**。

- **hub DB 是 timeline / 历史 / 配置的唯一权威**;node 不落盘事件,只用内存环形缓冲支撑断线续传。
- hub 重启:run 完全不受影响,重连后从 node 内存缓冲续上。
- 守护进程退出:其下 provider CLI 子进程与 PTY 一并结束,在飞 run 标 `interrupted`,经重建 + rewind 重跑恢复。
- 资源上限:node 只做编排;限制最大并发 run 数;终端与浏览器会话进程随守护进程生命周期。

### 10.3 审批超时

- 默认 10 分钟;默认值按 provider 区分,可按节点覆盖(`approval_timeout_overrides`)。
- **hub 未连接期间暂停计时**;中止前 60 秒推送通知。
- 超时行为:中止 run,session 标 `interrupted`,UI 写明原因,保留「rewind 后重跑」。
- 节点可配 `never`(永久等待)。

## 11. 安全

- **配对**:一次性配对码换取 per-node token;token 只存哈希,可吊销、可轮换。
- **双向认证(非对称)**:hub 持私钥;配对时向 node 下发 hub 公钥;每次重连 hub 对 node 的 nonce 签名,node 验签后才接受指令。
- **最小暴露**:节点无对外端口,仅 loopback 内部控制面。
- **爆炸半径**:per-node token + 应用层 hub 身份校验 + 独立审计日志,hub 失陷 ≠ 所有节点失陷。
- **分层**:Tailscale ACL 提供网络层身份,与 hub 用户鉴权、per-node token 叠加。
- **审批来源**:审批/问答由 node 侧发起,hub 只转达。
- 远程执行即受控 RCE,所有控制点归结为「节点信任谁」。

## 12. 部署

```
npm i -g cloudcli
cloudcli node --hub wss://<hub-tailscale-name> --token <pairing-code>
```

- 与 hub 同一份代码,第二个 bin,**不 import database 模块**。
- 服务化:Linux systemd(`Restart=always` + 退避),macOS launchd(LaunchAgent,用户会话),Windows 服务或 PM2;本机 node 由 hub 自动拉起。
- macOS 注意:项目位于 `~/Documents`、`~/Desktop`、`~/Downloads` 时,LaunchAgent 需授予 Full Disk Access;笔记本睡眠期间 run 挂起,唤醒后按重连恢复。
- 连接自检上报,按平台解析引擎路径:`claude ✅ 已登录 / codex ❌ 未安装 / chromium ⚠️ 缺少系统依赖 / git 身份未配置`,附可复制的修复命令。
- 升级:hub `pnpm run deploy`;node 经 `system.upgrade` 更新二进制后重启;协议兼容窗口为 N-1。

## 13. 实施阶段

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| **P0** | `nodes` 表 + `node_id` 列(默认 `local`)+ 常量穿过执行接缝 + 只读节点列表 API | 零行为变化,现有功能全绿 |
| **P1** | `nodeClient` 接口与分帧/流控;node 守护进程骨架(第二 bin、无 DB);本机拆为 hub + 本地守护进程(hub 守护、按 hubId 隔离、本地流);远端 WSS;按纵切打通 `fs → git → pty → engine → session`(未切完的调用暂留 hub 直连,双轨过渡) | 本机与远端各完成一次完整对话 + 编辑文件 + 提交;`pm2 restart cloudcli` 不影响进行中的 run |
| **P2** | 重连续传、审批重播与超时、按节点能力矩阵、session 同步下沉节点、插件与 browser-use 隧道化、其余 fs/进程模块下沉、配对与自检 UX | 断网 30s 后恢复,run 不中断 |

## 14. 架构决策

| 决策 | 结论 |
|---|---|
| 本机守护进程 | hub 作为父进程拉起,detached 运行,可被 SIGTERM 回收 |
| 本地路径隔离 | 按 `CLOUDCLI_HUB_ID` 分目录,目录名净化后使用 |
| 持久化 | hub DB 唯一权威;node 只保留内存环形缓冲,无磁盘 spool |
| 传输 | 本机 UDS(Linux / macOS)/ loopback TCP(Windows);远端 WSS over Tailscale,无 fallback |
| 连接拓扑 | 控制/可续流与交互隧道分两条连接 |
| 双向认证 | 非对称:hub 私钥 + node 侧 hub 公钥验签 |
| 终端 | 守护进程退出后由 UI 提示重建 |
| 审批超时 | hub 断连暂停计时;超时中止;默认按 provider,可按节点覆盖;可配 `never` |
| 插件 | 执行在 node;浏览器三条路径隧道化;密钥不落 node |
| 插件 UI | 维持 hub 同源全权,context 增加 nodeId |
| browser-use | MCP 链同节点闭环;UI 画面隧道化;runtime 随守护进程生命周期 |
| 平台支持 | hub 任意平台;node 支持 Linux / macOS / Windows |
| 项目展示 | 按节点分组 |

## 15. 落地时同步 `docs/core/`

实现后按改动面更新并删除本文件:

- `docs/core/overview.md`:进程拓扑、数据与持久化、构建与部署
- `docs/core/providers.md`:引擎对接框架、能力矩阵
- `docs/core/chat.md`:chat pipeline、run 归属与续传
- `docs/core/frontend.md`:节点分组视图、`nodeId` 透传
