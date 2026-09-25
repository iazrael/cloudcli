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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
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
    runShell(`pm2 stop ${appName}`);
    progress.stopped = true;
    step('install');
    runShell('npm install --include=dev');
  }

  step('build-client');
  fs.rmSync(path.join(root, 'dist.next'), { recursive: true, force: true });
  runShell('npm run build:client -- --outDir dist.next --emptyOutDir');

  step('build-server');
  runShell('npm run build:server');
  progress.serverPromoted = true;

  step('promote-client');
  promoteClientBuild();

  const targetCommit = capture('git', ['rev-parse', 'HEAD']);
  // The new server settles this state on boot; see the system module.
  writeState({ state: 'restarting', step: 'restart', targetCommit });
  log(`build ready at ${targetCommit}; restarting ${appName}`);
  runShell(`pm2 restart ${appName}`);
  log('restart issued');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${message}`);
  rollBack();
  writeState({ state: 'failed', step: null, error: message, finishedAt: new Date().toISOString() });
} finally {
  fs.closeSync(logFd);
}

function rollBack() {
  fs.rmSync(path.join(root, 'dist.next'), { recursive: true, force: true });
  if (progress.merged && fromCommit) {
    attempt('reset checkout', () => run('git', ['reset', '--keep', fromCommit]));
    if (progress.depsChanged) {
      attempt('reinstall previous dependencies', () => runShell('npm install --include=dev'));
    }
    if (progress.serverPromoted) {
      // The new server build already replaced dist-server; rebuild the old code.
      attempt('rebuild previous version', () => runShell('npm run build'));
    }
  }
  if (progress.stopped) {
    attempt(`restart ${appName}`, () => runShell(`pm2 restart ${appName}`));
  }
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

function attempt(label, action) {
  try {
    action();
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
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
}

// npm and pm2 are .cmd shims on Windows, which only a shell can launch.
function runShell(commandLine) {
  log(`$ ${commandLine}`);
  const result = spawnSync(commandLine, {
    cwd: root,
    env: childEnvironment,
    stdio: ['ignore', logFd, logFd],
    shell: true,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandLine} exited with code ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: childEnvironment, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
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
