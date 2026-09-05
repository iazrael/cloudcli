/**
 * ZCode Credential Decryption and Storage Access
 *
 * Reads and decrypts OAuth credentials and user profiles stored in ZCode's
 * `~/.zcode/v2/credentials.json`. Credentials use AES-256-GCM with key
 * derived via SHA-256 from host environment and username.
 *
 * Consumers:
 * - `ZCodeProviderAuth` in `zcode-auth.provider.ts` (authentication and user status)
 * - `fetchZCodeQuota` in `zcode-quota.provider.ts` (retrieving OAuth access token)
 *
 * @module zcode-credentials
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getZCodeStorageDir } from './zcode-data-root.js';

const CIPHER_PREFIX = 'enc:v1:';
const CIPHER_ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Derives the SHA-256 cipher key from fallback host parameters or ZCODE_CREDENTIAL_SECRET.
 */
function deriveCipherKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secretOverride = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (secretOverride) {
    return createHash('sha256').update(secretOverride).digest();
  }

  let username = 'unknown';
  try {
    username = os.userInfo().username || 'unknown';
  } catch {
    // Some restricted or container environments cannot read userInfo
  }

  const fallback = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  return createHash('sha256').update(fallback).digest();
}

/**
 * Decrypts a single `enc:v1:<iv>.<authTag>.<ciphertext>` string.
 * Returns the original string if it is not prefixed with `enc:v1:`.
 * Throws if the ciphertext format is invalid or decryption fails (bad key/tag).
 *
 * Used by readDecryptedZCodeCredentials and test suites.
 */
export function decryptZCodeCredentialValue(
  cipherText: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!cipherText.startsWith(CIPHER_PREFIX)) {
    return cipherText;
  }

  const payload = cipherText.slice(CIPHER_PREFIX.length);
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credential format: expected iv.authTag.cipher');
  }

  const [rawIv, rawTag, rawEncrypted] = parts;
  const iv = Buffer.from(rawIv, 'base64url');
  const authTag = Buffer.from(rawTag, 'base64url');
  const encrypted = Buffer.from(rawEncrypted, 'base64url');

  const key = deriveCipherKey(env);
  const decipher = createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypts a plaintext string into `enc:v1:<iv>.<authTag>.<ciphertext>` format.
 * Primarily used in test suites to mock ZCode credentials files.
 */
export function encryptZCodeCredentialValue(
  plainText: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const iv = randomBytes(IV_LENGTH);
  const key = deriveCipherKey(env);
  const cipher = createCipheriv(CIPHER_ALGO, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    CIPHER_PREFIX,
    iv.toString('base64url'),
    '.',
    authTag.toString('base64url'),
    '.',
    encrypted.toString('base64url'),
  ].join('');
}

export type DecryptedZCodeCredentials = {
  authenticated: boolean;
  accessToken: string | null;
  zcodeJwtToken: string | null;
  providerFamily: 'bigmodel' | 'zai';
  username: string | null;
  displayName: string | null;
  email: string | null;
  method: string | null;
  error?: string;
};

/**
 * Reads and decrypts all credentials from `<storageDir>/v2/credentials.json`.
 *
 * Consumers:
 * - `ZCodeProviderAuth.getStatus` in `zcode-auth.provider.ts`
 * - `fetchZCodeQuota` in `zcode-quota.provider.ts`
 */
export async function readDecryptedZCodeCredentials(
  storageDir = getZCodeStorageDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DecryptedZCodeCredentials> {
  const credPath = path.join(storageDir, 'v2', 'credentials.json');

  try {
    const content = await readFile(credPath, 'utf8');
    const rawMap = readObjectRecord(JSON.parse(content));

    if (!rawMap) {
      return {
        authenticated: false,
        accessToken: null,
        zcodeJwtToken: null,
        providerFamily: 'bigmodel',
        username: null,
        displayName: null,
        email: null,
        method: null,
        error: 'ZCode credentials file is unreadable. Run the login command again.',
      };
    }

    const decryptedMap: Record<string, string> = {};
    let hadDecryptionFailure = false;

    for (const [key, value] of Object.entries(rawMap)) {
      if (typeof value === 'string') {
        if (value.startsWith(CIPHER_PREFIX)) {
          try {
            decryptedMap[key] = decryptZCodeCredentialValue(value, env);
          } catch {
            // Decryption failed: NEVER retain raw ciphertext as an active token.
            hadDecryptionFailure = true;
          }
        } else {
          decryptedMap[key] = value;
        }
      }
    }

    const bigmodelToken = readOptionalString(decryptedMap['oauth:bigmodel:access_token']);
    const zaiToken = readOptionalString(decryptedMap['oauth:zai:access_token']);
    const zcodeJwt = readOptionalString(decryptedMap['zcodejwttoken']);
    const activeProvider = readOptionalString(decryptedMap['oauth:active_provider']);

    const providerFamily: 'bigmodel' | 'zai' = (activeProvider === 'zai' || zaiToken) ? 'zai' : 'bigmodel';
    const accessToken = (providerFamily === 'zai' ? zaiToken : bigmodelToken) ?? bigmodelToken ?? zaiToken ?? zcodeJwt ?? null;

    if (!accessToken && !zcodeJwt) {
      return {
        authenticated: false,
        accessToken: null,
        zcodeJwtToken: null,
        providerFamily,
        username: null,
        displayName: null,
        email: null,
        method: null,
        error: hadDecryptionFailure
          ? 'ZCode credentials could not be decrypted. Check your environment secret or re-login in ZCode desktop app.'
          : 'No ZCode login credentials found. Run the login command.',
      };
    }

    let username: string | null = null;
    let displayName: string | null = null;
    let email: string | null = null;

    const rawUserInfo = decryptedMap['oauth:bigmodel:user_info'] ?? decryptedMap['oauth:zai:user_info'];
    if (rawUserInfo) {
      try {
        const parsed = JSON.parse(rawUserInfo);
        username = readOptionalString(parsed.username) ?? null;
        displayName = readOptionalString(parsed.displayName) ?? readOptionalString(parsed.name) ?? null;
        email = readOptionalString(parsed.email) ?? null;
      } catch {
        // Ignore JSON parse errors for user info
      }
    }

    return {
      authenticated: true,
      accessToken: accessToken ?? null,
      zcodeJwtToken: zcodeJwt ?? null,
      providerFamily,
      username,
      displayName,
      email: email ?? username ?? displayName ?? null,
      method: 'Z.AI OAuth',
    };
  } catch (error) {
    let errorMessage = 'Unable to read ZCode credentials. Run the login command.';
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      errorMessage = 'ZCode credentials not found. Run the login command.';
    } else if (error instanceof SyntaxError) {
      errorMessage = 'ZCode credentials file is corrupted. Run the login command again.';
    }

    return {
      authenticated: false,
      accessToken: null,
      zcodeJwtToken: null,
      providerFamily: 'bigmodel',
      username: null,
      displayName: null,
      email: null,
      method: null,
      error: errorMessage,
    };
  }
}
