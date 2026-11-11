#!/usr/bin/env node
// 本地部署：把当前仓库编译产物打包并安装到固定运行目录，再切换 pm2 生产实例。
// 生产实例与开发目录彻底脱钩（见 ~/.pm2/ecosystem.config.cjs），
// 改代码、跑 dev 都不影响正在干活的线上服务。
//
// 用法：pnpm run deploy [--bump]
// 默认沿用 package.json 当前版本号；--bump 才自增 patch 版本并单独提交。
// 脚本会先把自己拉起成 detached 后台进程（日志 ~/.cloudcli/deploy.log），当前终端
// 只跟读日志，所以终端关闭、或 pm2 切换把托管本会话的服务重启，都不会打断部署。
// 在 cloudcli 托管的会话里执行时，切换那一刻自身连接仍会断，后续进度看日志。

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'cloudcli';
const PORT = 3030;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ECOSYSTEM = path.join(os.homedir(), '.pm2', 'ecosystem.config.cjs');
const CLOUDCLI_HOME = path.join(os.homedir(), '.cloudcli');
const RUNTIME_DIR = path.join(CLOUDCLI_HOME, 'runtime');
const NEXT_RUNTIME_DIR = path.join(CLOUDCLI_HOME, `runtime-next-${process.pid}`);
const PREVIOUS_RUNTIME_DIR = path.join(CLOUDCLI_HOME, 'runtime-previous');
const DEPLOY_LOCK = path.join(CLOUDCLI_HOME, 'deploy.lock');
const DEPLOY_LOG = path.join(CLOUDCLI_HOME, 'deploy.log');
const shouldBump = process.argv.includes('--bump');
let cutoverInProgress = false;
let deployCompleted = false;

function fail(msg) {
  console.error(`\n[deploy] ✗ ${msg}`);
  process.exit(1);
}

// 显示输出的执行（build / pack / install 全程可见）；切换后的步骤直接调用
// runChecked，让上层有机会回滚，而不是在命令失败时立刻退出进程。
function runChecked(cmd, args, cwd = REPO_ROOT) {
  console.log(`\n[deploy] $ cd ${cwd} && ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function run(cmd, args, cwd = REPO_ROOT) {
  try {
    runChecked(cmd, args, cwd);
  } catch {
    fail(`命令执行失败：${cmd} ${args.join(' ')}`);
  }
}

// 捕获 stdout 的执行
function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireDeployLock() {
  fs.mkdirSync(CLOUDCLI_HOME, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(DEPLOY_LOCK, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      let ownerPid = null;
      try {
        ownerPid = JSON.parse(fs.readFileSync(DEPLOY_LOCK, 'utf8')).pid;
      } catch {
        fail(`部署锁内容无效，请确认没有部署进程后手工删除：${DEPLOY_LOCK}`);
      }
      if (isProcessAlive(ownerPid)) {
        fail(`已有部署正在运行（PID ${ownerPid}），请等待它完成`);
      }
      fs.rmSync(DEPLOY_LOCK, { force: true });
    }
  }

  fail(`无法取得部署锁：${DEPLOY_LOCK}`);
}

function releaseDeployLock() {
  try {
    const ownerPid = JSON.parse(fs.readFileSync(DEPLOY_LOCK, 'utf8')).pid;
    if (ownerPid === process.pid) fs.rmSync(DEPLOY_LOCK, { force: true });
  } catch {
    // 锁已被清理或内容损坏时无需再处理。
  }
}

// ── 脱离宿主进程 ───────────────────────────────────────────
// 部署中途要重启 pm2。如果这个脚本本身是被重启对象的子进程——在 cloudcli 托管的
// 终端里执行就是这种情况——宿主一死脚本跟着死，可能停在切换之前，留下"构建过了
// 但线上没更新"。所以先把自己重新拉起成 detached 进程（detached 等于 setsid，
// 终端挂断的 SIGHUP 也到不了它），输出写进日志文件，当前终端只负责跟读：
// 关掉终端、或者宿主服务被重启，部署都照样跑完。
if (!process.env.CLOUDCLI_DEPLOY_DETACHED) {
  fs.mkdirSync(CLOUDCLI_HOME, { recursive: true });
  const args = process.argv.slice(2);
  fs.writeFileSync(DEPLOY_LOG, `[deploy] ${new Date().toISOString()} 启动，参数：${args.join(' ') || '（无）'}\n`);

  const logFd = fs.openSync(DEPLOY_LOG, 'a');
  const worker = spawn(process.execPath, [import.meta.filename, ...args], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CLOUDCLI_DEPLOY_DETACHED: '1' },
  });
  worker.unref();
  fs.closeSync(logFd);

  console.log(`[deploy] 部署已在后台启动（PID ${worker.pid}），日志：${DEPLOY_LOG}`);
  console.log('[deploy] 以下为实时日志。在这里按 Ctrl-C 只停止跟读，不会中断部署。');

  const tail = spawn('tail', ['-n', '+2', '-f', DEPLOY_LOG], { stdio: ['ignore', 'inherit', 'inherit'] });
  const exitCode = await new Promise((resolve) => {
    worker.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    worker.on('error', () => resolve(1));
  });
  // 留一点时间让 tail 把最后几行吐完，再收掉它。
  await new Promise((resolve) => setTimeout(resolve, 500));
  tail.kill('SIGTERM');
  process.exit(exitCode);
}

// 清理被强杀的历史部署留下的暂存目录（正常退出会自己删）。
for (const entry of fs.readdirSync(CLOUDCLI_HOME, { withFileTypes: true })) {
  const orphanPid = /^runtime-next-(\d+)$/.exec(entry.name)?.[1];
  if (entry.isDirectory() && orphanPid && !isProcessAlive(Number(orphanPid))) {
    fs.rmSync(path.join(CLOUDCLI_HOME, entry.name), { recursive: true, force: true });
    console.log(`[deploy] 已清理上次中断留下的暂存目录：${entry.name}`);
  }
}

acquireDeployLock();
process.on('exit', (code) => {
  fs.rmSync(NEXT_RUNTIME_DIR, { recursive: true, force: true });
  releaseDeployLock();
  // 中断和失败都走这里：把"线上没变"说清楚，别让人以为构建成功就等于部署成功。
  if (!deployCompleted) {
    console.error(
      `\n[deploy] ✗ 部署未完成（退出码 ${code}）。固定运行目录未切换，线上仍是本次部署前的版本。` +
      (shouldBump ? '\n[deploy]   版本号若已自增并提交，该版本号作废，下次 --bump 会在它之上继续自增。' : ''),
    );
  }
});
function handleTerminationSignal(signal) {
  if (cutoverInProgress) {
    console.warn(`\n[deploy] ! 已收到 ${signal}，固定目录已切换；将继续验证，失败时自动回滚`);
    return;
  }
  const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
  process.exit(exitCode);
}
process.on('SIGINT', () => handleTerminationSignal('SIGINT'));
process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'));
process.on('SIGHUP', () => handleTerminationSignal('SIGHUP'));

// ── 0. 版本号（默认沿用 package.json；--bump 自增第三位 patch 并提交） ──
const pkgJsonPath = path.join(REPO_ROOT, 'package.json');
const pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
if (shouldBump) {
  const semverParts = (pkgData.version || '1.0.0').split('.');
  if (semverParts.length >= 3) {
    semverParts[2] = String(parseInt(semverParts[2], 10) + 1);
    pkgData.version = semverParts.join('.');
  } else {
    pkgData.version = `${pkgData.version || '1.0'}.1`;
  }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgData, null, 2) + '\n');
  console.log(`\n[deploy] 版本号自增至：v${pkgData.version}`);

  // 自增本身会把工作区弄脏，而构建指纹（vite.config.js）按 `git status --porcelain`
  // 判定 -dirty，于是每次部署的版本号都被自己标成 dirty。把这一行改动单独提交掉，
  // dirty 就只在真有未提交改动时出现。只提交 package.json，不碰工作区其它改动；
  // 钩子跳过 —— 这里改的只是一个版本号。
  const versionCommit = capture('git', [
    'commit', '--no-verify', '-m', `chore(release): v${pkgData.version}`, '--', pkgJsonPath,
  ]);
  if (versionCommit === null) {
    console.warn('[deploy] ! 版本号提交失败（不在 git 仓库、或有冲突未解决），构建指纹会带 -dirty');
  } else {
    console.log(`[deploy] 已提交版本号变更：chore(release): v${pkgData.version}`);
  }
} else {
  // 版本号交给发版流水线管理，日常部署不消耗 patch 号。
  console.log(`\n[deploy] 沿用版本号 v${pkgData.version}`);
}

// ── 1. 编译 ────────────────────────────────────────────────
run('pnpm', ['build']);

// ── 2. 打包（存放于稳定的 ~/.cloudcli/deploy 目录，避免随机临时目录被删导致后续 pnpm ENOENT） ───
const deployDir = path.join(CLOUDCLI_HOME, 'deploy');
fs.mkdirSync(deployDir, { recursive: true });

// pnpm v11 起 onlyBuiltDependencies 被移除，改为 pnpm-workspace.yaml 的
// allowBuilds 白名单，且 strictDepBuilds 默认 true 会把未申报的构建脚本
// 直接判成安装失败。这里沿用 v10 语义：白名单只放行本包和 better-sqlite3，
// 其余构建脚本静默跳过（better-sqlite3 与 node-pty 另有兜底检查）。
// 白名单写进 staging 自己的 pnpm-workspace.yaml，不碰共享的全局 pnpm 配置。
const BUILD_ALLOWLIST = [APP_NAME, 'better-sqlite3'];

const packOut = capture('pnpm', ['pack', '--pack-destination', deployDir]);
const packLine = packOut?.split('\n').map((l) => l.trim()).filter(Boolean).pop();
if (!packLine) {
  fail('pnpm pack 未输出 tarball 路径');
}
const tarball = path.isAbsolute(packLine) ? packLine : path.join(deployDir, path.basename(packLine));
if (!fs.existsSync(tarball)) fail(`tarball 不存在：${tarball}`);

// ── 3. 安装到独立暂存目录（首次会编译原生依赖，较慢） ──
// node-linker=hoisted 让 cloudcli 本体成为普通目录，而不是指向 .pnpm 哈希目录的软链。
// 先完整安装到 runtime-next；全部检查通过后才切换，安装失败不碰正在运行的版本。
fs.rmSync(NEXT_RUNTIME_DIR, { recursive: true, force: true });
fs.mkdirSync(NEXT_RUNTIME_DIR, { recursive: true });
fs.writeFileSync(path.join(NEXT_RUNTIME_DIR, 'package.json'), JSON.stringify({
  private: true,
  dependencies: { [APP_NAME]: `file:${tarball}` },
}, null, 2) + '\n');
// pnpm 12 起只读 pnpm-workspace.yaml 里的构建脚本白名单，写进 package.json
// 的 `pnpm` 字段会被静默忽略，better-sqlite3 等原生依赖就永远走不上兜底路径。
fs.writeFileSync(
  path.join(NEXT_RUNTIME_DIR, 'pnpm-workspace.yaml'),
  `allowBuilds:\n${BUILD_ALLOWLIST.map((name) => `  ${name}: true`).join('\n')}\nstrictDepBuilds: false\n`,
);
// staging 安装按档回退：
// ① 默认源直连——剥掉全部代理环境变量走直连。默认源来自 ~/.npmrc（2026-11-09
//    起是官方源，官方源经本机 TUN 直连实测可达；若换回 npmmirror 镜像，直连
//    同样是它的唯一正确姿势：代理出口 IP 请求镜像实测吃 500）。
// ② 官方源走代理——显式指到 registry.npmjs.org 并继承代理环境，兜默认源不可
//    用（镜像抽风/TUN 故障）时的底。
// 每次安装都对 900+ 包全量解析元数据，曾把部署卡死在安装阶段。
// 不做 staging 锁持久化 + frozen 安装的原因见 docs/design/部署registry源回退.md。
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org';
const PROXY_ENV_KEYS = [
  'http_proxy', 'https_proxy', 'all_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'npm_config_proxy', 'npm_config_https_proxy',
];
const directEnv = { ...process.env };
for (const key of PROXY_ENV_KEYS) delete directEnv[key];
const installAttempts = [
  { name: '默认源直连（禁代理）', env: directEnv },
  { name: `npm 官方源走代理（${OFFICIAL_REGISTRY}）`, env: { ...process.env, npm_config_registry: OFFICIAL_REGISTRY } },
];
let installed = false;
for (const attempt of installAttempts) {
  console.log(`\n[deploy] staging 安装：${attempt.name}`);
  try {
    execFileSync('pnpm', ['install', '--prod', '--config.node-linker=hoisted'], {
      cwd: NEXT_RUNTIME_DIR,
      stdio: 'inherit',
      env: attempt.env,
    });
    installed = true;
    break;
  } catch {
    console.log(`\n[deploy] ✗ ${attempt.name} 安装失败${attempt === installAttempts.at(-1) ? '' : '，换下一档重试'}`);
  }
}
if (!installed) fail(`staging 安装失败（镜像直连与官方源走代理均尝试过）：${NEXT_RUNTIME_DIR}`);

let pkgDir = path.join(NEXT_RUNTIME_DIR, 'node_modules', APP_NAME);
const serverEntry = path.join(pkgDir, 'dist-server', 'server', 'index.js');
if (!fs.existsSync(serverEntry)) fail(`安装后未找到服务入口：${serverEntry}`);

// ── 3.5 原生依赖兜底 ───────────────────────────────────────
// pnpm v10 起默认不执行依赖的构建脚本，better-sqlite3 的 install 脚本
// （prebuild-install 下载 / node-gyp 编译原生二进制）会被拦掉，服务在
// 首次开库时即崩、端口永远起不来。这里从服务入口解析包的真实落盘目录，
// 缺二进制就在该目录补跑一次 install 脚本。
const sqliteProbe = capture('node', [
  '-e',
  `const fs=require('fs'),path=require('path');` +
  `const dir=fs.realpathSync(${JSON.stringify(pkgDir)});` +
  `console.log(fs.realpathSync(path.dirname(require.resolve('better-sqlite3/package.json',{paths:[dir]}))))`,
]);
if (!sqliteProbe) fail('无法解析 better-sqlite3 安装位置（运行目录安装不完整？）');
const sqliteBinary = path.join(sqliteProbe, 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(sqliteBinary)) {
  console.log(`[deploy] better-sqlite3 缺原生二进制（pnpm v10 默认拦构建脚本），补跑 install 脚本…`);
  run('npm', ['run', 'install'], sqliteProbe);
  if (!fs.existsSync(sqliteBinary)) fail(`补跑 install 后仍未生成 ${sqliteBinary}`);
}

// ── 3.6 node-pty 执行权限兜底 ──────────────────────────────
// 同样是 pnpm v10 拦构建脚本的后果：本包的 postinstall（scripts/fix-node-pty.js）
// 负责给 node-pty 的 spawn-helper 补上执行位，缺了它开终端就 posix_spawnp failed。
// 这里仍直接从安装好的包解析 node-pty 的真实位置再补，避免依赖具体布局。
//
// 上面的构建白名单正常时这一步不会触发；仍保留兜底检查，避免安装脚本行为变化后
// 开终端直接报 posix_spawnp failed。
const ptyProbe = capture('node', [
  '-e',
  `const fs=require('fs'),path=require('path');` +
  `try{const dir=fs.realpathSync(${JSON.stringify(pkgDir)});` +
  `console.log(fs.realpathSync(path.dirname(require.resolve('node-pty/package.json',{paths:[dir]}))))}catch{}`,
]);
if (ptyProbe) {
  const prebuilds = path.join(ptyProbe, 'prebuilds');
  let fixed = 0;
  if (fs.existsSync(prebuilds)) {
    for (const entry of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, entry, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      if ((fs.statSync(helper).mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
        fixed += 1;
      }
    }
  }
  if (fixed > 0) {
    console.log(`[deploy] node-pty spawn-helper 缺执行位，已补 ${fixed} 个`);
  }
} else {
  console.log('[deploy] 未解析到 node-pty，跳过 spawn-helper 权限检查');
}

// ── 3.7 受控切换固定运行目录 ───────────────────────────────
// 部署锁保证同一时间只有一个切换者。每次 rename 在同一文件系统内是原子的；两次
// rename 之间固定路径会短暂不存在，因此 PM2 只在整个目录切换完成后才会重启。
if (!fs.existsSync(ECOSYSTEM)) fail(`pm2 配置不存在：${ECOSYSTEM}`);
const expectedRuntimePath = path.join(RUNTIME_DIR, 'node_modules', APP_NAME);
const expectedServerEntry = path.join(expectedRuntimePath, 'dist-server', 'server', 'index.js');
let configuredApp;
try {
  const requireFromDeploy = createRequire(import.meta.url);
  const ecosystemConfig = requireFromDeploy(ECOSYSTEM);
  configuredApp = ecosystemConfig?.apps?.find((app) => app?.name === APP_NAME);
} catch (error) {
  fail(`无法读取 pm2 配置：${error instanceof Error ? error.message : String(error)}`);
}
if (
  configuredApp?.script !== expectedServerEntry
  || configuredApp?.cwd !== expectedRuntimePath
) {
  fail(`pm2 的 cloudcli 配置必须指向固定运行目录：${expectedRuntimePath}`);
}

function restorePreviousRuntime() {
  if (!fs.existsSync(PREVIOUS_RUNTIME_DIR)) return false;

  if (fs.existsSync(RUNTIME_DIR)) fs.renameSync(RUNTIME_DIR, NEXT_RUNTIME_DIR);
  try {
    fs.renameSync(PREVIOUS_RUNTIME_DIR, RUNTIME_DIR);
    return true;
  } catch (error) {
    if (!fs.existsSync(RUNTIME_DIR) && fs.existsSync(NEXT_RUNTIME_DIR)) {
      fs.renameSync(NEXT_RUNTIME_DIR, RUNTIME_DIR);
    }
    throw error;
  }
}

try {
  fs.rmSync(PREVIOUS_RUNTIME_DIR, { recursive: true, force: true });
  if (fs.existsSync(RUNTIME_DIR)) fs.renameSync(RUNTIME_DIR, PREVIOUS_RUNTIME_DIR);
  fs.renameSync(NEXT_RUNTIME_DIR, RUNTIME_DIR);
  cutoverInProgress = true;
} catch (error) {
  if (!fs.existsSync(RUNTIME_DIR) && fs.existsSync(PREVIOUS_RUNTIME_DIR)) {
    fs.renameSync(PREVIOUS_RUNTIME_DIR, RUNTIME_DIR);
  }
  fail(`切换固定运行目录失败：${error instanceof Error ? error.message : String(error)}`);
}
pkgDir = path.join(RUNTIME_DIR, 'node_modules', APP_NAME);
console.log(`[deploy] 已切换固定运行目录：${pkgDir}`);

// ── 4. 切换 pm2 服务 ────────────────────────────────────────
//
// PM2 的 restart/startOrRestart 对已存在进程只合并环境变量，不更新 pm_exec_path
// 和 pm_cwd。首次从旧 pnpm 全局目录迁移时必须重建一次进程条目；固定路径生效后
// 的后续部署只做原地 restart。部署必须从服务外的普通终端运行，见文件头说明。
const restartArgs = ['restart', ECOSYSTEM, '--only', APP_NAME, '--update-env'];

function getRegisteredApp() {
  const jlist = capture('pm2', ['jlist']);
  if (jlist === null) throw new Error('无法读取 pm2 进程列表');
  const matches = JSON.parse(jlist).filter((app) => app.name === APP_NAME);
  if (matches.length > 1) throw new Error(`pm2 存在 ${matches.length} 个同名 cloudcli 进程，拒绝自动切换`);
  return matches[0] ?? null;
}

function startOrRestartConfiguredApp() {
  const registered = getRegisteredApp();
  if (!registered) {
    runChecked('pm2', ['start', ECOSYSTEM, '--only', APP_NAME]);
    return;
  }

  const alreadyUsesFixedRuntime = (
    registered.pm2_env?.pm_exec_path === expectedServerEntry
    && registered.pm2_env?.pm_cwd === expectedRuntimePath
  );
  if (alreadyUsesFixedRuntime) {
    runChecked('pm2', restartArgs);
    return;
  }

  console.log(`[deploy] PM2 仍登记旧入口，重建进程条目：${registered.pm2_env?.pm_exec_path ?? '未知路径'}`);
  runChecked('pm2', ['delete', String(registered.pm_id)]);
  runChecked('pm2', ['start', ECOSYSTEM, '--only', APP_NAME]);
}

function verifyPm2RuntimePath() {
  const app = getRegisteredApp();
  if (
    app?.pm2_env?.pm_exec_path !== expectedServerEntry
    || app?.pm2_env?.pm_cwd !== expectedRuntimePath
  ) {
    throw new Error('pm2 仍未使用固定运行目录');
  }
}

async function waitUntilReady() {
  console.log(`\n[deploy] 等待 http://127.0.0.1:${PORT} 就绪…`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' });
      if (res.status < 500) return true;
    } catch {
      // 进程还没起来，继续等
    }
    execFileSync('sleep', ['2']);
  }
  return false;
}

try {
  startOrRestartConfiguredApp();
  verifyPm2RuntimePath();
  if (!await waitUntilReady()) throw new Error(`60 秒内 ${PORT} 端口未就绪`);
  // 只持久化验证通过的进程；pm2 resurrect 不会恢复旧路径或未通过健康检查的新版本。
  runChecked('pm2', ['save']);
} catch (error) {
  const deployError = error instanceof Error ? error.message : String(error);
  console.error(`\n[deploy] ! 新版本启动失败，正在恢复上一版本：${deployError}`);

  try {
    if (!restorePreviousRuntime()) {
      fail(`新版本启动失败，且没有可回滚的上一版本：${deployError}`);
    }
    startOrRestartConfiguredApp();
    verifyPm2RuntimePath();
    if (!await waitUntilReady()) throw new Error(`回滚后 ${PORT} 端口仍未就绪`);
    runChecked('pm2', ['save']);
  } catch (rollbackError) {
    fail(`新版本启动失败且自动回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
  }

  fail(`新版本启动失败，已恢复上一版本：${deployError}`);
}

// ── 5. 更新稳定 CLI 入口 ───────────────────────────────────
// 旧部署用 pnpm 全局安装，生成的 shell shim 硬编码了 .pnpm 哈希路径。新入口直接
// 指向固定 runtime；先准备临时软链，再 rename 覆盖，避免留下半写入的脚本。
const globalBinDir = capture('pnpm', ['bin', '-g']);
if (globalBinDir) {
  const cliEntry = path.join(pkgDir, 'dist-server', 'server', 'modules', 'cli', 'cli.js');
  const cliLink = path.join(globalBinDir, APP_NAME);
  const nextCliLink = path.join(globalBinDir, `.${APP_NAME}-next-${process.pid}`);
  try {
    fs.rmSync(nextCliLink, { force: true });
    fs.symlinkSync(cliEntry, nextCliLink);

    const globalRoot = capture('pnpm', ['root', '-g']);
    const globalManifest = globalRoot && path.join(path.dirname(globalRoot), 'package.json');
    if (globalManifest && fs.existsSync(globalManifest)) {
      const manifest = JSON.parse(fs.readFileSync(globalManifest, 'utf8'));
      if (manifest.dependencies?.[APP_NAME]) {
        try {
          runChecked('pnpm', ['remove', '-g', APP_NAME]);
        } catch (error) {
          console.warn(`[deploy] ! 清理旧全局安装失败，将只覆盖 CLI 入口：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    fs.renameSync(nextCliLink, cliLink);
    console.log(`[deploy] CLI 固定入口：${cliLink} -> ${cliEntry}`);
  } catch (error) {
    fs.rmSync(nextCliLink, { force: true });
    fail(`更新 cloudcli CLI 入口失败：${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  fail('无法解析 pnpm 全局 bin 目录，未能更新 cloudcli CLI 入口');
}

cutoverInProgress = false;
deployCompleted = true;

// ── 6. 清理历史部署包 ───────────────────────────────────────
// tarball 只在本次安装 runtime-next 时用一次；回滚不依赖它——线上回滚走
// runtime-previous，源码回退走 git。部署成功后只留最新 2 个包（本次 + 一个旧版），
// 更早的自动删掉，防止 deploy 目录随版本无限膨胀。放在成功路径上：失败部署
// 不动存量；清理本身出错也只警告，部署结果已经成立，不能被收尾步骤掀翻。
function pruneDeployTarballs(keepCount = 2) {
  try {
    const tarballs = fs.readdirSync(deployDir)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => ({ name: f, mtimeMs: fs.statSync(path.join(deployDir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of tarballs.slice(keepCount)) {
      fs.rmSync(path.join(deployDir, old.name), { force: true });
    }
    if (tarballs.length > keepCount) {
      const kept = tarballs.slice(0, keepCount).map((t) => t.name).join('、');
      console.log(`[deploy] 已清理 ${tarballs.length - keepCount} 个历史部署包，保留：${kept}`);
    }
  } catch (error) {
    console.warn(`[deploy] ! 历史部署包清理失败（不影响部署）：${error instanceof Error ? error.message : String(error)}`);
  }
}
pruneDeployTarballs();

console.log(`\n[deploy] ✓ 部署完成，访问 http://localhost:${PORT}`);
