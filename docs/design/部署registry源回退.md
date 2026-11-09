# 部署 registry 源回退

状态：已实施，待下次真实部署验证回退路径

基准：main @ 80d0ce61，2026-11-09

## 目标

staging 安装（`pnpm install --prod`，每次部署全量解析 900+ 包元数据）在镜像源抽风时不再打死整个部署。2026-11-09 实测：npmmirror 对 `@opentelemetry/sdk-trace-base`、`file-selector`、`@cacheable/utils` 等包的元数据接口连续 500，重试耗尽后 `ERR_PNPM_FETCH_500`，部署卡死在安装阶段。

## 范围

只改 `scripts/deploy.mjs` 的 staging 安装步骤。不动仓库依赖管理方式、不动部署产物形态。

## 方案

staging 安装按顺序尝试，任一档成功即继续，全失败才报错退出：

1. 环境继承（现状：npmmirror）。
2. 失败后注入 `npm_config_registry=https://registry.npmjs.org` 重试一次（官方源经本机代理实测可用，2026-11-09 部署即由此跑通）。

## 为什么不做 staging 锁文件（决策记录）

直观方案是把 pnpm-lock.yaml 持久化后用 `--frozen-lockfile` 安装（锁住则完全不发元数据请求），但 fixture 实测否决：

- pnpm 对 `file:` tarball 依赖会在锁文件里记 integrity，且 frozen 安装强制校验；部署 tarball 每次构建内容必变，frozen 必挂（`/tmp` fixture：同路径换内容 tarball + 旧锁 frozen 直接报 integrity 错）。
- 绕过它要么每次手改锁文件里的 integrity 标量（跨 pnpm 版本脆），要么重构运行时布局（用仓库 package.json + 锁 frozen 装依赖、再解包 tarball，动 PM2 指向的目录结构）——超出本次目标。
- 仓库开发侧已是 npm 系（worktree `npm ci` + package-lock.json），再引入 pnpm 锁是双份真相会漂移。

若未来需要完全可复现部署（版本漂移成为实际痛点），正解是全仓统一 pnpm：单管理器、提交 pnpm-lock、部署真 frozen。那是独立的更大决策，不在本次范围。

## 验证

- `node --check scripts/deploy.mjs`。
- fixture 复刻两档尝试逻辑：死端口源 + 官方源，验证环境注入与重试收敛。
- 回退路径未在真实部署中触发过（当日 npmmirror 已恢复），留待下次故障观察 deploy.log。

## 风险

- 非网络类安装失败（如依赖解析出真错误）会跑满两档再退出，多花一次安装时间；可接受。
- 官方源走代理，速度慢于国内镜像；只在第一档失败后才走，正常部署零开销。
