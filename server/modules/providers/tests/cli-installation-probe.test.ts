import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCliInstallationProbe,
  DEFAULT_NEGATIVE_PROBE_TTL_MS,
  TIMED_OUT_PROBE_TTL_MS,
  type ProbeSpawn,
} from '@/modules/providers/shared/installation/cli-installation-probe.js';

type StubOutcome = { error?: Error; status: number | null; timedOut?: boolean };

type StubSpawn = {
  spawnAsync: ProbeSpawn;
  calls: { command: string; args: string[] }[];
};

/**
 * Replaces the real subprocess spawn with a scripted queue of outcomes and
 * records every call so cache tests can assert how often a probe ran.
 */
const stubProbeSpawn = (outcomes: StubOutcome[], onCall?: () => void): StubSpawn => {
  const calls: { command: string; args: string[] }[] = [];
  const spawnAsync: ProbeSpawn = async (command, args, options) => {
    calls.push({ command, args });
    onCall?.();
    const outcome = outcomes.shift();
    if (!outcome) {
      throw new Error(`unexpected probe call #${calls.length} for ${command}`);
    }
    void options;
    return outcome;
  };
  return { spawnAsync, calls };
};

const ok = { status: 0 };
const missing = { error: new Error('spawn ENOENT'), status: null };
const failing = { status: 1 };

const createClock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test('installed result is cached for the process lifetime', async () => {
  // Second outcome would fail, proving it is never consulted.
  const { spawnAsync, calls } = stubProbeSpawn([ok, missing]);
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync },
  );

  assert.equal(await probe.isInstalled(), true);
  assert.equal(await probe.isInstalled(), true);
  assert.equal(calls.length, 1);
});

test('missing CLI is cached as not installed within the TTL', async () => {
  const { spawnAsync, calls } = stubProbeSpawn([missing, missing]);
  const clock = createClock();
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync, now: clock.now },
  );

  assert.equal(await probe.isInstalled(), false);
  clock.advance(DEFAULT_NEGATIVE_PROBE_TTL_MS - 1);
  assert.equal(await probe.isInstalled(), false);
  assert.equal(calls.length, 1);
});

test('non-zero exit counts as not installed', async () => {
  const { spawnAsync } = stubProbeSpawn([failing]);
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync },
  );

  assert.equal(await probe.isInstalled(), false);
});

test('negative cache expires and the next query probes again', async () => {
  const { spawnAsync, calls } = stubProbeSpawn([missing, ok]);
  const clock = createClock();
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync, now: clock.now },
  );

  assert.equal(await probe.isInstalled(), false);
  clock.advance(DEFAULT_NEGATIVE_PROBE_TTL_MS);
  assert.equal(await probe.isInstalled(), true);
  assert.equal(calls.length, 2);
});

test('a thrown probe error is cached as not installed', async () => {
  const { spawnAsync, calls } = stubProbeSpawn([missing, missing]);
  const spawnThrowing: ProbeSpawn = async (command, args, options) => {
    calls.push({ command, args });
    void options;
    if (calls.length === 1) {
      throw new Error('probe crashed');
    }
    return spawnAsync(command, args, options);
  };
  const clock = createClock();
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync: spawnThrowing, now: clock.now },
  );

  assert.equal(await probe.isInstalled(), false);
  assert.equal(await probe.isInstalled(), false);
  assert.equal(calls.length, 1);
});

test('concurrent queries share one in-flight probe', async () => {
  const calls: { command: string; args: string[] }[] = [];
  let release: ((outcome: StubOutcome) => void) | undefined;
  const spawnAsync: ProbeSpawn = (command, args) => {
    calls.push({ command, args });
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync },
  );

  const first = probe.isInstalled();
  const second = probe.isInstalled();
  assert.equal(calls.length, 1);

  release?.(ok);
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test('a hung CLI times out to installed instead of hiding the provider', async () => {
  const probe = createCliInstallationProbe({
    command: () => process.execPath,
    args: ['-e', 'setTimeout(() => {}, 2000)'],
    timeoutMs: 50,
  });

  assert.equal(await probe.isInstalled(), true);
});

test('a timed-out probe is trusted briefly, then probed again', async () => {
  const timedOut = { error: new Error('installation probe timed out'), status: null, timedOut: true };
  const { spawnAsync, calls } = stubProbeSpawn([timedOut, missing]);
  const clock = createClock();
  const probe = createCliInstallationProbe(
    { command: () => 'cli' },
    { spawnAsync, now: clock.now },
  );

  assert.equal(await probe.isInstalled(), true);
  clock.advance(TIMED_OUT_PROBE_TTL_MS - 1);
  assert.equal(await probe.isInstalled(), true);
  assert.equal(calls.length, 1);

  // Unlike a confirmed install, the timeout verdict expires and is re-checked.
  clock.advance(1);
  assert.equal(await probe.isInstalled(), false);
  assert.equal(calls.length, 2);
});

test('a CLI missing from PATH is not installed even when the probe would time out', async () => {
  // On Windows cross-spawn runs an unresolvable command through cmd.exe, which
  // can outlast the timeout; the PATH check must answer before any spawn.
  const probe = createCliInstallationProbe({
    command: () => 'cloudcli-probe-definitely-missing-cli',
    timeoutMs: 1,
  });

  assert.equal(await probe.isInstalled(), false);
});
