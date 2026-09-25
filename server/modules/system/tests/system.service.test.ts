import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createSystemUpdateService } from '../system.service.js';

type SystemUpdateDependencies = Parameters<typeof createSystemUpdateService>[0];

const APP_ROOT = '/app/cloudcli';
const STATE_PATH = '/home/u/.cloudcli/update-state.json';
const LOG_PATH = '/home/u/.cloudcli/update.log';
const BUILD_INFO_PATH = path.join(APP_ROOT, 'dist', 'build-info.json');

type Harness = {
  dependencies: SystemUpdateDependencies;
  files: Map<string, string>;
  gitCalls: string[];
  launched: string[];
};

/**
 * A checkout on `main` tracking `myfork/main`, answering git from a table keyed
 * by the joined arguments. Anything missing from the table exits non-zero.
 */
function createHarness({
  git = {},
  files = {},
  overrides = {},
}: {
  git?: Record<string, string | null>;
  files?: Record<string, string>;
  overrides?: Partial<SystemUpdateDependencies>;
} = {}): Harness {
  const gitTable: Record<string, string | null> = {
    'rev-parse --abbrev-ref HEAD': 'main',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'myfork/main',
    'fetch --quiet': '',
    'rev-parse HEAD': 'aaaa',
    'rev-parse @{u}': 'aaaa',
    'rev-list --left-right --count HEAD...@{u}': '0\t0',
    'status --porcelain --untracked-files=no': '',
    ...git,
  };
  const fileMap = new Map(Object.entries({
    [BUILD_INFO_PATH]: JSON.stringify({ commit: 'aaaa', dirty: false }),
    ...files,
  }));
  const gitCalls: string[] = [];
  const launched: string[] = [];

  const dependencies: SystemUpdateDependencies = {
    appRoot: APP_ROOT,
    installMode: 'git',
    isPlatform: false,
    pm2AppName: 'cloudcli',
    statePath: STATE_PATH,
    logPath: LOG_PATH,
    runGit: async (args) => {
      const key = args.join(' ');
      gitCalls.push(key);
      const stdout = gitTable[key];
      return stdout === undefined || stdout === null
        ? { exitCode: 1, stdout: '', stderr: `no answer for git ${key}` }
        : { exitCode: 0, stdout, stderr: '' };
    },
    readTextFile: (filePath) => fileMap.get(filePath) ?? null,
    writeTextFile: (filePath, content) => {
      fileMap.set(filePath, content);
    },
    isProcessAlive: () => true,
    launchUpdater: (mode) => {
      launched.push(mode);
    },
    now: () => new Date('2026-09-24T12:00:00Z'),
    ...overrides,
  };

  return { dependencies, files: fileMap, gitCalls, launched };
}

function readState(harness: Harness) {
  return JSON.parse(harness.files.get(STATE_PATH) ?? 'null');
}

async function assertRefused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 409);
    return true;
  });
}

test('a checkout behind its upstream offers a pull and lists the incoming commits', async () => {
  const harness = createHarness({
    git: {
      'rev-parse @{u}': 'cccc',
      'rev-list --left-right --count HEAD...@{u}': '0\t2',
      'log --format=%h%x09%s -n30 HEAD..@{u}': 'cccc\tfeat: second\nbbbb\tfix: first',
    },
  });
  const service = createSystemUpdateService(harness.dependencies);

  const status = await service.getStatus();

  assert.equal(status.supported, true);
  assert.equal(status.upstream, 'myfork/main');
  assert.equal(status.behind, 2);
  assert.equal(status.availableMode, 'pull');
  assert.deepEqual(status.commits, [
    { hash: 'cccc', subject: 'feat: second' },
    { hash: 'bbbb', subject: 'fix: first' },
  ]);
});

test('a checkout whose HEAD moved past the running build offers a rebuild', async () => {
  // The machine the commits were made on: nothing to pull, but the server
  // still runs the build from before them.
  const harness = createHarness({
    git: { 'rev-parse HEAD': 'dddd', 'rev-parse @{u}': 'dddd' },
  });
  const service = createSystemUpdateService(harness.dependencies);

  const status = await service.getStatus();

  assert.equal(status.builtCommit, 'aaaa');
  assert.equal(status.availableMode, 'rebuild');
});

test('an up-to-date checkout running its own HEAD offers nothing', async () => {
  const service = createSystemUpdateService(createHarness().dependencies);

  const status = await service.getStatus();

  assert.equal(status.availableMode, null);
});

test('a build without build-info never claims a rebuild is needed', async () => {
  const harness = createHarness({ git: { 'rev-parse HEAD': 'dddd', 'rev-parse @{u}': 'dddd' } });
  harness.files.delete(BUILD_INFO_PATH);
  const service = createSystemUpdateService(harness.dependencies);

  assert.equal((await service.getStatus()).availableMode, null);
});

test('diverged history offers nothing and is reported as such', async () => {
  const harness = createHarness({
    git: {
      'rev-parse @{u}': 'cccc',
      'rev-list --left-right --count HEAD...@{u}': '1\t2',
      'log --format=%h%x09%s -n30 HEAD..@{u}': 'cccc\tx',
    },
  });
  const status = await createSystemUpdateService(harness.dependencies).getStatus();

  assert.equal(status.diverged, true);
  assert.equal(status.availableMode, null);
});

test('installs that cannot update themselves say why', async () => {
  const npm = await createSystemUpdateService(
    createHarness({ overrides: { installMode: 'npm' } }).dependencies,
  ).getStatus();
  assert.equal(npm.supported, false);
  assert.equal(npm.reason, 'not-git');

  const platform = await createSystemUpdateService(
    createHarness({ overrides: { isPlatform: true } }).dependencies,
  ).getStatus();
  assert.equal(platform.reason, 'platform');

  const noUpstream = await createSystemUpdateService(
    createHarness({ git: { 'rev-parse --abbrev-ref --symbolic-full-name @{u}': null } }).dependencies,
  ).getStatus();
  assert.equal(noUpstream.reason, 'no-upstream');
  assert.equal(noUpstream.branch, 'main');

  // Without PM2 nothing could bring the server back, but the status is still shown.
  const unsupervised = await createSystemUpdateService(
    createHarness({ overrides: { pm2AppName: null } }).dependencies,
  ).getStatus();
  assert.equal(unsupervised.supported, false);
  assert.equal(unsupervised.reason, 'not-pm2');
  assert.equal(unsupervised.upstream, 'myfork/main');
});

test('fetches are throttled unless a refresh is forced', async () => {
  const harness = createHarness();
  const service = createSystemUpdateService(harness.dependencies);

  await service.getStatus();
  await service.getStatus();
  await service.getStatus({ refresh: true });

  assert.equal(harness.gitCalls.filter((call) => call === 'fetch --quiet').length, 2);
});

test('a failed fetch is surfaced without failing the status', async () => {
  const harness = createHarness({ git: { 'fetch --quiet': null } });
  const status = await createSystemUpdateService(harness.dependencies).getStatus();

  assert.match(status.fetchError ?? '', /no answer for git fetch/);
  assert.equal(status.supported, true);
});

test('starting an update records the job before launching the runner', async () => {
  const harness = createHarness({
    git: {
      'rev-parse @{u}': 'cccc',
      'rev-list --left-right --count HEAD...@{u}': '0\t1',
      'log --format=%h%x09%s -n30 HEAD..@{u}': 'cccc\tfeat: x',
    },
    files: { [LOG_PATH]: 'old run\n' },
  });
  const service = createSystemUpdateService(harness.dependencies);

  const result = await service.startUpdate();

  assert.equal(result.mode, 'pull');
  assert.deepEqual(harness.launched, ['pull']);
  const state = readState(harness);
  assert.equal(state.state, 'running');
  assert.equal(state.fromCommit, 'aaaa');
  assert.equal(state.pid, null);
  assert.equal(harness.files.get(LOG_PATH), '');

  // The recorded job refuses a second click while the runner works.
  await assertRefused(service.startUpdate(), 'already-running');
});

test('a dirty checkout, diverged history or nothing to do refuse to start', async () => {
  await assertRefused(
    createSystemUpdateService(createHarness({
      git: {
        'rev-parse HEAD': 'dddd',
        'status --porcelain --untracked-files=no': ' M server/index.ts',
      },
    }).dependencies).startUpdate(),
    'dirty',
  );

  await assertRefused(
    createSystemUpdateService(createHarness({
      git: {
        'rev-list --left-right --count HEAD...@{u}': '1\t1',
        'log --format=%h%x09%s -n30 HEAD..@{u}': 'cccc\tx',
      },
    }).dependencies).startUpdate(),
    'diverged',
  );

  await assertRefused(createSystemUpdateService(createHarness().dependencies).startUpdate(), 'up-to-date');

  await assertRefused(
    createSystemUpdateService(createHarness({ overrides: { pm2AppName: null } }).dependencies).startUpdate(),
    'not-pm2',
  );
});

test('a launcher that cannot spawn fails the job instead of leaving it running', async () => {
  const harness = createHarness({
    git: { 'rev-parse HEAD': 'dddd', 'rev-parse @{u}': 'dddd' },
    overrides: {
      launchUpdater: () => {
        throw new Error('spawn ENOENT');
      },
    },
  });

  await assert.rejects(createSystemUpdateService(harness.dependencies).startUpdate(), /spawn ENOENT/);
  assert.equal(readState(harness).state, 'failed');
});

test('the restarted server settles a restarting job by the build it booted', async () => {
  const succeeded = createHarness({
    files: { [STATE_PATH]: JSON.stringify({ id: '1', state: 'restarting', targetCommit: 'aaaa', pid: 5 }) },
  });
  createSystemUpdateService(succeeded.dependencies);
  assert.equal(readState(succeeded).state, 'succeeded');

  const mismatched = createHarness({
    files: { [STATE_PATH]: JSON.stringify({ id: '1', state: 'restarting', targetCommit: 'ffff', pid: 5 }) },
  });
  createSystemUpdateService(mismatched.dependencies);
  assert.equal(readState(mismatched).state, 'failed');
});

test('a runner that died mid-update no longer blocks the next one', async () => {
  const harness = createHarness({
    files: {
      [STATE_PATH]: JSON.stringify({ id: '1', state: 'running', pid: 42, startedAt: '2026-09-24T11:59:00Z' }),
      [LOG_PATH]: 'line one\nline two\n',
    },
    overrides: { isProcessAlive: () => false },
  });

  const status = await createSystemUpdateService(harness.dependencies).getStatus();

  assert.equal(status.job?.state, 'failed');
  assert.deepEqual(status.job?.logTail, ['line one', 'line two']);
  assert.equal('pid' in (status.job ?? {}), false);
});

test('a job the runner never picked up expires after the launch grace period', async () => {
  const fresh = createHarness({
    files: { [STATE_PATH]: JSON.stringify({ id: '1', state: 'running', pid: null, startedAt: '2026-09-24T11:59:30Z' }) },
  });
  assert.equal((await createSystemUpdateService(fresh.dependencies).getStatus()).job?.state, 'running');

  const lost = createHarness({
    files: { [STATE_PATH]: JSON.stringify({ id: '1', state: 'running', pid: null, startedAt: '2026-09-24T11:50:00Z' }) },
  });
  assert.equal((await createSystemUpdateService(lost.dependencies).getStatus()).job?.state, 'failed');
});
