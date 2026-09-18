#!/usr/bin/env node
// 本地部署：把当前仓库编译产物打包成独立副本全局安装，并切换 pm2 生产实例。
// 生产实例与开发目录彻底脱钩（见 ~/.pm2/ecosystem.config.cjs），
// 改代码、跑 dev 都不影响正在干活的线上服务。
//
// 用法：pnpm run deploy
// 注意：本会话若由 cloudcli 服务托管，最后的进程切换会断开自身连接，
// 应在服务之外的普通终端里执行。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'cloudcli';
const PORT = 3030;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ECOSYSTEM = path.join(os.homedir(), '.pm2', 'ecosystem.config.cjs');

function fail(msg) {
  console.error(`\n[deploy] ✗ ${msg}`);
  process.exit(1);
}

// 显示输出的执行（build / pack / install 全程可见）
function run(cmd, args, cwd = REPO_ROOT) {
  console.log(`\n[deploy] $ cd ${cwd} && ${cmd} ${args.join(' ')}`);
  try {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' });
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

// ── 0. 更新版本号（自增第三位 patch 版本） ──────────────────
const pkgJsonPath = path.join(REPO_ROOT, 'package.json');
const pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
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

// ── 1. 编译 ────────────────────────────────────────────────
run('pnpm', ['build']);

// ── 2. 打包（存放于稳定的 ~/.cloudcli/deploy 目录，避免随机临时目录被删导致后续 pnpm ENOENT） ───
const deployDir = path.join(os.homedir(), '.cloudcli', 'deploy');
fs.mkdirSync(deployDir, { recursive: true });

// pnpm v10 默认拦截依赖的安装脚本。实测唯一生效的白名单落点是**全局 package.json
// 的 `pnpm.onlyBuiltDependencies`**：写在全局 rc（`only-built-dependencies=`）或全局
// `pnpm-workspace.yaml` 里都不被读取，`pnpm approve-builds` 没有 `-y`，
// `onlyBuiltDependenciesGlobally` 这个设置在 pnpm 10 里根本不存在。
// 没有它，本包的 postinstall（scripts/fix-node-pty.js）和 better-sqlite3 的 install
// 都会被静默跳过。
const BUILD_ALLOWLIST = [APP_NAME, 'better-sqlite3'];

// 同时清理全局 package.json 中可能残留的已失效的本地 file: 路径，防止 pnpm 校验旧依赖时抛 ENOENT
try {
  const globalDir = path.dirname(capture('pnpm', ['root', '-g']) || '');
  const globalPkgJson = path.join(globalDir, 'package.json');
  if (fs.existsSync(globalPkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(globalPkgJson, 'utf8'));
    let modified = false;
    if (pkg.dependencies?.[APP_NAME]?.startsWith('file:')) {
      const oldPath = pkg.dependencies[APP_NAME].slice(5);
      if (!fs.existsSync(oldPath)) {
        delete pkg.dependencies[APP_NAME];
        modified = true;
      }
    }

    // 只增不删：这份名单是全局共享的，别的全局包可能也往里加过条目。
    const current = Array.isArray(pkg.pnpm?.onlyBuiltDependencies) ? pkg.pnpm.onlyBuiltDependencies : [];
    const missing = BUILD_ALLOWLIST.filter((name) => !current.includes(name));
    if (missing.length) {
      pkg.pnpm = { ...pkg.pnpm, onlyBuiltDependencies: [...current, ...missing].sort() };
      modified = true;
      console.log(`[deploy] 已把 ${missing.join('、')} 加入全局构建白名单（pnpm v10 默认拦安装脚本）`);
    }

    if (modified) {
      fs.writeFileSync(globalPkgJson, JSON.stringify(pkg, null, 2) + '\n');
    }
  }
} catch {
  // 忽略全局配置清理异常
}

const packOut = capture('pnpm', ['pack', '--pack-destination', deployDir]);
const packLine = packOut?.split('\n').map((l) => l.trim()).filter(Boolean).pop();
if (!packLine) {
  fail('pnpm pack 未输出 tarball 路径');
}
const tarball = path.isAbsolute(packLine) ? packLine : path.join(deployDir, path.basename(packLine));
if (!fs.existsSync(tarball)) fail(`tarball 不存在：${tarball}`);

// ── 3. 全局安装（独立静态副本，首次会编译原生依赖，较慢） ──
run('pnpm', ['add', '-g', tarball]);

const globalRoot = capture('pnpm', ['root', '-g']);
const pkgDir = path.join(globalRoot, APP_NAME);
const serverEntry = path.join(pkgDir, 'dist-server', 'server', 'index.js');
if (!fs.existsSync(serverEntry)) fail(`全局安装后未找到服务入口：${serverEntry}`);

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
if (!sqliteProbe) fail('无法解析 better-sqlite3 安装位置（全局安装不完整？）');
const sqliteBinary = path.join(sqliteProbe, 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(sqliteBinary)) {
  console.log(`[deploy] better-sqlite3 缺原生二进制（pnpm v10 默认拦构建脚本），补跑 install 脚本…`);
  run('npm', ['run', 'install'], sqliteProbe);
  if (!fs.existsSync(sqliteBinary)) fail(`补跑 install 后仍未生成 ${sqliteBinary}`);
}

// ── 3.6 node-pty 执行权限兜底 ──────────────────────────────
// 同样是 pnpm v10 拦构建脚本的后果：本包的 postinstall（scripts/fix-node-pty.js）
// 负责给 node-pty 的 spawn-helper 补上执行位，缺了它开终端就 posix_spawnp failed。
// 这里不调那个脚本 —— 它按相对路径找 node_modules，pnpm 的全局布局是软链到
// .pnpm 虚拟目录的，靠不住 —— 直接从安装好的包解析 node-pty 的真实位置再补。
//
// 上面的全局构建白名单正常时这一步不会触发；保留它是因为那份名单是全局共享的，
// 被别的工具改写过一次（条目被按字符拆碎）就会重新失效，而这里的后果是开终端直接
// posix_spawnp failed。兜底比信号可靠。
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

// ── 4. 切换 pm2 服务（原地重启，绝不 delete） ──
//
// 从 cloudcli 自己的会话里跑部署时，这个脚本是被部署服务的子孙进程。
// `pm2 delete` 连着进程树一起杀，脚本在第二条命令（start）之前就没了，
// 服务再也起不来 —— 部署把自己锁死。`pm2 restart` 是一条命令，由 pm2 守护
// 进程执行，脚本死了也照样把服务拉回来，进程条目自始至终存在。
//
// 带上 ecosystem 路径与 --update-env，重启时重读配置与环境变量，
// 这正是当初选择 delete + start 想要的效果。
if (!fs.existsSync(ECOSYSTEM)) fail(`pm2 配置不存在：${ECOSYSTEM}`);
const jlist = capture('pm2', ['jlist']);
const running = jlist ? JSON.parse(jlist).find((a) => a.name === APP_NAME) : null;
if (running) {
  run('pm2', ['restart', ECOSYSTEM, '--only', APP_NAME, '--update-env']);
} else {
  run('pm2', ['start', ECOSYSTEM, '--only', APP_NAME]);
  // 进程条目是新建的，落盘一次，pm2 resurrect 才认得它。重启路径不改条目，
  // 无需落盘 —— 也正好避免在脚本可能被重启打断时多做一步。
  run('pm2', ['save']);
}

// ── 5. 健康检查 ────────────────────────────────────────────
console.log(`\n[deploy] 等待 http://127.0.0.1:${PORT} 就绪…`);
const deadline = Date.now() + 60_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' });
    if (res.status < 500) { ready = true; break; }
  } catch {
    // 进程还没起来，继续等
  }
  execFileSync('sleep', ['2']);
}

if (!ready) fail(`60 秒内 ${PORT} 端口未就绪，检查日志：pm2 logs ${APP_NAME}`);
console.log(`\n[deploy] ✓ 部署完成，访问 http://localhost:${PORT}`);
