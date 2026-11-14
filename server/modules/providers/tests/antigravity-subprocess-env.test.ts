/**
 * Antigravity Subprocess Env Tests
 *
 * Verifies the agy subprocess environment strips SSH session indicators, which
 * otherwise flip agy's token storage away from the keychain under pm2.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { buildAntigravitySubprocessEnv } from '../list/antigravity/antigravity-subprocess-env.js';

type SavedEnv = Partial<Record<'SSH_TTY' | 'SSH_CONNECTION' | 'SSH_CLIENT', string | undefined>>;

const sshKeys = ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT'] as const;
const sshSample = '/dev/ttys004';
const saved: SavedEnv = {};

afterEach(() => {
  for (const key of sshKeys) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('buildAntigravitySubprocessEnv drops SSH session indicators', () => {
  for (const key of sshKeys) {
    saved[key] = process.env[key];
    process.env[key] = sshSample;
  }

  const env = buildAntigravitySubprocessEnv();

  for (const key of sshKeys) {
    assert.equal(env[key], undefined);
  }
});

test('buildAntigravitySubprocessEnv keeps non-SSH variables', () => {
  const env = buildAntigravitySubprocessEnv();

  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.ALL_PROXY, process.env.ALL_PROXY);
});

test('buildAntigravitySubprocessEnv does not mutate the process environment', () => {
  saved.SSH_CONNECTION = process.env.SSH_CONNECTION;
  process.env.SSH_CONNECTION = '192.168.1.2 51000 192.168.1.9 22';

  buildAntigravitySubprocessEnv();

  assert.equal(process.env.SSH_CONNECTION, '192.168.1.2 51000 192.168.1.9 22');
});
