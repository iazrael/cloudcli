#!/usr/bin/env node
/**
 * Stages the ZCode desktop credential key for headless processes.
 *
 * Since the 2026-11 ZCode desktop upgrade, credential values in
 * `~/.zcode/v2/credentials.json` are sealed with `enc:v2:` AES-256-GCM under a
 * random 32-byte key that lives in the macOS login keychain (service
 * "ZCode Credential Encryption"). GUI sessions can read the keychain directly;
 * headless processes (the pm2-run cloudcli server) cannot, so they read the
 * staged copy written by this script instead:
 *
 *   node scripts/zcode-stage-credential-key.mjs
 *
 * Run it again after every ZCode desktop re-login (the key may rotate). The
 * script never prints the key; it prints the key fingerprint, which the
 * desktop app also embeds in every `enc:v2` value.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const KEYCHAIN_SERVICE = 'ZCode Credential Encryption';
const KEY_BYTES = 32;

const storageDir = process.env.ZCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), '.zcode');
const target = path.join(storageDir, 'v2', 'credential-secret');

execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 5_000 }, async (error, stdout) => {
  if (error) {
    console.error(`Could not read the keychain entry "${KEYCHAIN_SERVICE}" (${error.message}).`);
    console.error('Run this script from a GUI session where the login keychain is unlocked.');
    process.exit(1);
  }

  const keyBase64url = stdout.trim();
  const key = Buffer.from(keyBase64url, 'base64url');
  if (!/^[A-Za-z0-9_-]+$/.test(keyBase64url) || key.length !== KEY_BYTES) {
    console.error('The keychain entry does not hold a 32-byte base64url key; refusing to stage it.');
    process.exit(1);
  }

  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24);

  try {
    const existing = (await readFile(target, 'utf8')).trim();
    if (existing === keyBase64url) {
      console.log(`Already staged (fingerprint ${fingerprint}): ${target}`);
      return;
    }
  } catch {
    // First run: no staged copy yet.
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${keyBase64url}\n`, { mode: 0o600 });
  // The mode option only applies on creation; tighten an existing file too.
  await chmod(target, 0o600);
  console.log(`Staged key (fingerprint ${fingerprint}) -> ${target}`);
  console.log('Headless processes can now decrypt enc:v2 credentials.');
});
