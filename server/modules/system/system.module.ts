import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Router } from 'express';

import type { SystemUpdateMode } from '@/shared/types.js';

import { createSystemRouter } from './system.routes.js';
import { createSystemUpdateService } from './system.service.js';

type SystemModuleOptions = {
  appRoot: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
};

const CLOUDCLI_HOME = path.join(os.homedir(), '.cloudcli');
const UPDATE_STATE_PATH = path.join(CLOUDCLI_HOME, 'update-state.json');
const UPDATE_LOG_PATH = path.join(CLOUDCLI_HOME, 'update.log');
/** A hung fetch (credential prompt, dead network) must not stall the status route. */
const GIT_TIMEOUT_MS = 60 * 1000;
/** Interpolated into `pm2 restart <name>` by the updater's shell, so only plain names are accepted. */
const SAFE_PM2_APP_NAME = /^[\w.-]+$/;

// PM2 injects its process description into the environment; `pm_id` marks a
// supervised process and `name` is the app name the updater restarts.
function resolvePm2AppName(): string | null {
  if (process.env.pm_id === undefined) return null;
  const name = process.env.name;
  return name && SAFE_PM2_APP_NAME.test(name) ? name : null;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Builds the authenticated system router for the server entrypoint using the
 * installation details it already resolves for health and startup metadata.
 */
export function createSystemModule(options: SystemModuleOptions): Router {
  const pm2AppName = resolvePm2AppName();

  const systemUpdateService = createSystemUpdateService({
    ...options,
    pm2AppName,
    statePath: UPDATE_STATE_PATH,
    logPath: UPDATE_LOG_PATH,
    runGit: (args) => new Promise((resolve) => {
      execFile('git', args, {
        cwd: options.appRoot,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr || (error?.message ?? '')) });
      });
    }),
    readTextFile,
    writeTextFile,
    isProcessAlive,
    launchUpdater: (mode: SystemUpdateMode) => {
      const launcher = spawn(process.execPath, [
        path.join(options.appRoot, 'scripts', 'self-update.mjs'),
        'launch',
        '--root', options.appRoot,
        '--mode', mode,
        '--app', pm2AppName ?? '',
        '--state', UPDATE_STATE_PATH,
        '--log', UPDATE_LOG_PATH,
      ], {
        cwd: options.appRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      launcher.unref();
    },
    now: () => new Date(),
  });

  return createSystemRouter(systemUpdateService);
}
