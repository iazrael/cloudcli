#!/usr/bin/env node
// Self-update runner behind the UI's "update and restart" button, for a git
// checkout supervised by PM2. The server writes the initial job state and
// spawns `launch`; everything else happens here, outside the server process.
//
// Why two phases: PM2 restarts with tree-kill, which walks parent/child
// process links from the server's pid. `launch` spawns the real `run` phase
// detached and exits at once, so `run` has no living ancestor inside the
// server's tree and survives the `pm2 stop` / `pm2 restart` it issues itself.
//
// Failure policy: the running installation must never be left broken. The
// client build is staged into dist.next and only promoted once the server
// build (which stages and promotes itself) has also succeeded; a failed run
// resets the checkout to where it started and brings the server back.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// A stalled install or build must fail the update, not leave it "running"
// forever. The default is generous for a cold npm install on Windows; tests
// and unusual hosts can override it with SELF_UPDATE_COMMAND_TIMEOUT_MS.
const COMMAND_TIMEOUT_MS = (() => {
  const override = Number(process.env.SELF_UPDATE_COMMAND_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 30 * 60 * 1000;
})();
const [phase, ...rawOptions] = process.argv.slice(2);
const options = parseOptions(rawOptions);

for (const required of ['root', 'mode', 'app', 'state', 'log']) {
  if (!options[required]) {
    console.error(`self-update: missing --${required}`);
    process.exit(64);
  }
}

if (phase === 'launch') {
  const runner = spawn(process.execPath, [SCRIPT_PATH, 'run', ...rawOptions], {
    cwd: options.root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  runner.unref();
  process.exit(0);
}

if (phase !== 'run') {
  console.error(`self-update: unknown phase "${phase}" (expected "launch" or "run").`);
  process.exit(64);
}

const root = options.root;
const appName = options.app;
const logFd = fs.openSync(options.log, 'a');

// PM2 flattens its process description into the server's environment. Handing
// that to the pm2 CLI makes it think it runs inside a managed process, so the
// supervisor's own keys are dropped; PM2_HOME stays so the CLI finds the daemon.
const childEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const key of Object.keys(childEnvironment)) {
  if ((/^pm_/i.test(key) || /^PM2_/.test(key)) && key !== 'PM2_HOME') {
    delete childEnvironment[key];
  }
}
for (const key of ['name', 'namespace', 'NODE_APP_INSTANCE']) {
  delete childEnvironment[key];
}

const progress = { merged: false, depsChanged: false, stopped: false, serverPromoted: false };
let fromCommit = null;

writeState({ pid: process.pid, state: 'running', step: 'start' });
log(`self-update ${options.mode} started (pid ${process.pid}) in ${root}`);

try {
  fromCommit = capture('git', ['rev-parse', 'HEAD']);

  if (options.mode === 'pull') {
    step('fetch');
    run('git', ['fetch', '--quiet']);
    step('merge');
    run('git', ['merge', '--ff-only', '@{u}']);
    progress.merged = capture('git', ['rev-parse', 'HEAD']) !== fromCommit;
    progress.depsChanged = progress.merged
      && capture('git', ['diff', '--name-only', fromCommit, 'HEAD', '--', 'package.json', 'package-lock.json']) !== '';
  }

  if (progress.depsChanged) {
    // Windows keeps a running server's native modules locked, so dependencies
    // are only reinstalled with the server stopped. Dev dependencies are
    // forced in: the build needs vite and tsc even when PM2 sets NODE_ENV.
    step('stop');
    await runShell(`pm2 stop ${appName}`);
    progress.stopped = true;
    step('install');
    await runShell('npm install --include=dev');
  }

  step('build-client');
  fs.rmSync(path.join(root, 'dist.next'), { recursive: true, force: true });
  await runShell('npm run build:client -- --outDir dist.next --emptyOutDir');

  step('build-server');
  await runShell('npm run build:server');
  progress.serverPromoted = true;

  step('promote-client');
  promoteClientBuild();

  const targetCommit = capture('git', ['rev-parse', 'HEAD']);
  // The new server settles this state on boot; see the system module.
  writeState({ state: 'restarting', step: 'restart', targetCommit });
  log(`build ready at ${targetCommit}; restarting ${appName}`);
  await runShell(pm2RestartCommand());
  log('restart issued');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${message}`);
  await rollBack();
  writeState({ state: 'failed', step: null, error: message, finishedAt: new Date().toISOString() });
} finally {
  fs.closeSync(logFd);
}

async function rollBack() {
  fs.rmSync(path.join(root, 'dist.next'), { recursive: true, force: true });
  if (progress.merged && fromCommit) {
    await attempt('reset checkout', () => run('git', ['reset', '--keep', fromCommit]));
    if (progress.depsChanged) {
      await attempt('reinstall previous dependencies', () => runShell('npm install --include=dev'));
    }
    if (progress.serverPromoted) {
      // The new server build already replaced dist-server; rebuild the old code.
      await attempt('rebuild previous version', () => runShell('npm run build'));
    }
  }
  if (progress.stopped) {
    await attempt(`restart ${appName}`, () => runShell(pm2RestartCommand()));
  }
}

// A plain `pm2 restart <name>` replays the env PM2 captured at first start, so
// edits to the ecosystem file's env block would never apply. When that file
// defines this app for this checkout, restart through it with --update-env;
// hosts without one (or whose entry points elsewhere) keep the plain restart.
function pm2RestartCommand() {
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
  const ecosystemPath = path.join(pm2Home, 'ecosystem.config.cjs');
  try {
    if (fs.existsSync(ecosystemPath)) {
      const require = createRequire(import.meta.url);
      const app = require(ecosystemPath)?.apps?.find((entry) => entry?.name === appName);
      const comparable = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
      if (app?.cwd && comparable(app.cwd) === comparable(root)) {
        return `pm2 restart "${ecosystemPath}" --only ${appName} --update-env`;
      }
    }
  } catch (error) {
    log(`ecosystem file unreadable, using plain restart: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `pm2 restart ${appName}`;
}

function promoteClientBuild() {
  const next = path.join(root, 'dist.next');
  const live = path.join(root, 'dist');
  const old = path.join(root, 'dist.old');
  if (!fs.existsSync(path.join(next, 'index.html'))) {
    throw new Error('dist.next/index.html is missing after the client build');
  }
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(live)) {
    renameWithRetry(live, old);
  }
  try {
    renameWithRetry(next, live);
  } catch (error) {
    if (fs.existsSync(old) && !fs.existsSync(live)) {
      renameWithRetry(old, live);
    }
    throw error;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

// A request being served from dist can briefly hold a handle on Windows.
function renameWithRetry(from, to) {
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : null;
      if (attemptIndex >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

async function attempt(label, action) {
  try {
    await action();
  } catch (error) {
    log(`rollback step "${label}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function step(name) {
  log(`--- ${name}`);
  writeState({ step: name });
}

function run(command, args) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnvironment,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  throwIfTimedOut(result, `${command} ${args.join(' ')}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
}

// npm and pm2 are .cmd shims on Windows, which only a shell can launch.
// spawnSync cannot run a timer while it waits, so this uses async spawn. On
// timeout the whole tree must die: killing cmd.exe alone would orphan npm.
function runShell(commandLine) {
  log(`$ ${commandLine}`);
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, {
      cwd: root,
      env: childEnvironment,
      stdio: ['ignore', logFd, logFd],
      shell: true,
      windowsHide: true,
      // POSIX needs a dedicated process group so a timeout can kill children.
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`TIMEOUT after ${formatDuration(COMMAND_TIMEOUT_MS)}: ${commandLine}`);
      killProcessTree(child.pid);
      // The tree kill should end the shell, but make sure `close` fires even
      // when taskkill is unavailable or the direct child already exited.
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, COMMAND_TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.on('error', (error) => {
      finish(timedOut ? new Error(`${commandLine} timed out after ${formatDuration(COMMAND_TIMEOUT_MS)}`) : error);
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`${commandLine} timed out after ${formatDuration(COMMAND_TIMEOUT_MS)}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${commandLine} exited with code ${code}${signal ? ` (signal ${signal})` : ''}`));
        return;
      }
      finish();
    });
  });
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: childEnvironment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  throwIfTimedOut(result, `${command} ${args.join(' ')}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

function throwIfTimedOut(result, label) {
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${label} timed out after ${formatDuration(COMMAND_TIMEOUT_MS)}`);
  }
}

function formatDuration(milliseconds) {
  return milliseconds >= 60000 ? `${Math.round(milliseconds / 60000)}m` : `${milliseconds}ms`;
}

// Windows' child.kill() only reaps cmd.exe; npm and pm2 run as grandchildren.
function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.error) log(`taskkill failed: ${result.error.message}`);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    log(`process-group kill failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function log(line) {
  fs.writeSync(logFd, `[${new Date().toISOString()}] ${line}\n`);
}

function writeState(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(options.state, 'utf8'));
  } catch {
    // First write, or a corrupt file the patch replaces.
  }
  const temporaryPath = `${options.state}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ ...current, ...patch }, null, 2));
  fs.renameSync(temporaryPath, options.state);
}

function parseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key.startsWith('--')) {
      parsed[key.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}
