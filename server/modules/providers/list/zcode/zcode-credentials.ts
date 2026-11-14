/**
 * ZCode Credential Decryption and Storage Access
 *
 * Reads and decrypts credentials stored in ZCode's `~/.zcode/v2/credentials.json`.
 * Two wire formats exist side by side since the 2026-11 ZCode desktop upgrade:
 *
 * - `enc:v1:<iv>.<authTag>.<cipher>` — AES-256-GCM keyed by a SHA-256 digest
 *   derived from the host environment (or `ZCODE_CREDENTIAL_SECRET`).
 * - `enc:v2:<source>:<fingerprint>:<iv>.<authTag>.<cipher>` — AES-256-GCM
 *   keyed by a random 32-byte secret the desktop app keeps in the OS keychain
 *   (`source: "os"`) or derives from `ZCODE_CREDENTIAL_SECRET` (`source: "env"`).
 *   The 24-hex `fingerprint` is `sha256(key)` truncated, so a candidate key is
 *   verified before any decryption attempt. Headless processes (pm2) cannot
 *   unlock the login keychain, so the os key is read from the staged
 *   `credential-secret` file beside the credentials store first.
 *
 * Consumers:
 * - `ZCodeProviderAuth` in `zcode-auth.provider.ts` (authentication and user status)
 * - `fetchZCodeQuota` in `zcode-quota.provider.ts` (coding-plan quota auth)
 * - send builders / account model catalog (JWT and api-key reads)
 *
 * @module zcode-credentials
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getZCodeStorageDir } from './zcode-data-root.js';

const CIPHER_PREFIX = 'enc:v1:';
const CIPHER_V2_PREFIX = 'enc:v2:';
const CIPHER_ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const V2_KEY_BYTES = 32;
const V2_FINGERPRINT_PATTERN = /^[a-f0-9]{24}$/;
const V2_SOURCES = ['os', 'env'] as const;
// The desktop app names its macOS keychain entry with this service string.
const KEYCHAIN_SERVICE = 'ZCode Credential Encryption';
// Headless staging: the base64url os key written beside the credential store
// (see scripts/zcode-stage-credential-key.mjs).
const STAGED_KEY_FILE = 'credential-secret';
// Failed key resolutions are retried only after this delay, so polling
// consumers do not spawn a keychain subprocess on every read.
const V2_KEY_MISS_TTL_MS = 30_000;

/**
 * Resolved v2 key caches. Positive entries are immutable (the fingerprint is
 * derived from the key itself); negative entries expire so a later staging run
 * can supply the key without a restart.
 */
const v2KeyCache = new Map<string, Buffer>();
const v2KeyMissCache = new Map<string, number>();

/**
 * Resets the v2 key caches. Used in tests to ensure isolation.
 */
export function clearZCodeCredentialKeyCache(): void {
  v2KeyCache.clear();
  v2KeyMissCache.clear();
}

/** Injectable keychain access for tests; mirrors the os keychain read. */
export type ZCodeV2KeyOverrides = {
  readKeychainSecret?: () => Promise<string | null>;
};

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

/** Seals plaintext into `<iv>.<authTag>.<cipher>` base64url segments. */
function sealAesGcmPayload(plainText: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

/** Opens `<iv>.<authTag>.<cipher>` base64url segments; throws when malformed. */
function openAesGcmPayload(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
    throw new Error('Invalid encrypted credential format: expected iv.authTag.cipher');
  }

  const [rawIv, rawTag, rawEncrypted] = parts;
  const iv = Buffer.from(rawIv, 'base64url');
  const authTag = Buffer.from(rawTag, 'base64url');
  const encrypted = Buffer.from(rawEncrypted, 'base64url');
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted credential format: expected iv.authTag.cipher');
  }

  const decipher = createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
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

  return openAesGcmPayload(cipherText.slice(CIPHER_PREFIX.length), deriveCipherKey(env));
}

/**
 * Encrypts a plaintext string into `enc:v1:<iv>.<authTag>.<ciphertext>` format.
 * Primarily used in test suites to mock ZCode credentials files.
 */
export function encryptZCodeCredentialValue(
  plainText: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return CIPHER_PREFIX + sealAesGcmPayload(plainText, deriveCipherKey(env));
}

/** The v2 key fingerprint the desktop app embeds in every sealed value. */
function v2Fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

/**
 * Encrypts a plaintext string into `enc:v2:<source>:<fingerprint>:<payload>`
 * format. Primarily used in test suites to mock v2 credentials files.
 */
export function encryptZCodeCredentialValueV2(
  plainText: string,
  key: Buffer,
  source: (typeof V2_SOURCES)[number],
): string {
  return `${CIPHER_V2_PREFIX}${source}:${v2Fingerprint(key)}:${sealAesGcmPayload(plainText, key)}`;
}

/**
 * Reads the staged os key (`<storageDir>/v2/credential-secret`, base64url of
 * exactly 32 bytes) written by the staging script for headless processes.
 */
async function readStagedOsKey(storageDir: string): Promise<Buffer | null> {
  try {
    const content = (await readFile(path.join(storageDir, 'v2', STAGED_KEY_FILE), 'utf8')).trim();
    if (!content) {
      return null;
    }
    const key = Buffer.from(content, 'base64url');
    return key.length === V2_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort macOS keychain read of the desktop app's credential key. Works
 * in GUI sessions; headless processes (pm2) cannot unlock the login keychain
 * and fail fast, which the negative cache below absorbs.
 */
async function readMacOsKeychainSecret(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const value = stdout.trim();
        resolve(value || null);
      },
    );
  });
}

/**
 * Resolves and verifies the v2 key for one source/fingerprint pair. Positive
 * results are memoized forever (fingerprint determines the key); misses are
 * memoized briefly so polling consumers do not re-spawn the keychain read.
 */
async function resolveV2Key(
  source: (typeof V2_SOURCES)[number],
  fingerprint: string,
  storageDir: string,
  env: NodeJS.ProcessEnv,
  overrides: ZCodeV2KeyOverrides,
): Promise<Buffer | null> {
  const cached = v2KeyCache.get(fingerprint);
  if (cached) {
    return cached;
  }
  const missUntil = v2KeyMissCache.get(fingerprint);
  if (missUntil !== undefined && missUntil > Date.now()) {
    return null;
  }

  let candidate: Buffer | null = null;
  if (source === 'env') {
    const secret = env.ZCODE_CREDENTIAL_SECRET?.trim();
    if (secret) {
      candidate = createHash('sha256').update(secret).digest();
    }
  } else {
    const staged = await readStagedOsKey(storageDir);
    candidate = staged && v2Fingerprint(staged) === fingerprint ? staged : null;
    if (!candidate) {
      const readKeychainSecret = overrides.readKeychainSecret ?? readMacOsKeychainSecret;
      const secret = await readKeychainSecret();
      const key = secret ? Buffer.from(secret, 'base64url') : null;
      candidate = key && key.length === V2_KEY_BYTES ? key : null;
    }
  }

  if (candidate && v2Fingerprint(candidate) === fingerprint) {
    v2KeyCache.set(fingerprint, candidate);
    v2KeyMissCache.delete(fingerprint);
    return candidate;
  }

  v2KeyMissCache.set(fingerprint, Date.now() + V2_KEY_MISS_TTL_MS);
  return null;
}

/** Parsed segments of an `enc:v2:` value, or null when the format is unknown. */
function parseV2Value(value: string): {
  source: (typeof V2_SOURCES)[number];
  fingerprint: string;
  payload: string;
} | null {
  if (!value.startsWith(CIPHER_V2_PREFIX)) {
    return null;
  }
  const withoutPrefix = value.slice(CIPHER_V2_PREFIX.length);
  const sourceEnd = withoutPrefix.indexOf(':');
  const fingerprintEnd = sourceEnd >= 0 ? withoutPrefix.indexOf(':', sourceEnd + 1) : -1;
  if (sourceEnd <= 0 || fingerprintEnd <= sourceEnd) {
    return null;
  }
  const source = withoutPrefix.slice(0, sourceEnd);
  const fingerprint = withoutPrefix.slice(sourceEnd + 1, fingerprintEnd);
  const payload = withoutPrefix.slice(fingerprintEnd + 1);
  if (!(V2_SOURCES as readonly string[]).includes(source) || !V2_FINGERPRINT_PATTERN.test(fingerprint) || !payload) {
    return null;
  }
  return { source: source as (typeof V2_SOURCES)[number], fingerprint, payload };
}

/**
 * Decrypts a single `enc:v2:<source>:<fingerprint>:<iv>.<authTag>.<ciphertext>`
 * string. Returns null (never throws) when the format is unknown, no key
 * matches the fingerprint, or the authenticated decryption fails — callers
 * must treat null as "undecryptable" and never keep the ciphertext as a token.
 *
 * Used by readDecryptedZCodeCredentials, the coding-plan quota context reader,
 * and test suites.
 */
export async function decryptZCodeCredentialValueV2(
  value: string,
  storageDir: string = getZCodeStorageDir(),
  env: NodeJS.ProcessEnv = process.env,
  overrides: ZCodeV2KeyOverrides = {},
): Promise<string | null> {
  const parsed = parseV2Value(value);
  if (!parsed) {
    return null;
  }

  const key = await resolveV2Key(parsed.source, parsed.fingerprint, storageDir, env, overrides);
  if (!key) {
    return null;
  }

  try {
    return openAesGcmPayload(parsed.payload, key);
  } catch {
    return null;
  }
}

/**
 * Decrypts one raw credential entry of any supported wire format. Returns null
 * for undecryptable values instead of ever exposing ciphertext.
 */
async function decryptCredentialEntry(
  value: string,
  storageDir: string,
  env: NodeJS.ProcessEnv,
  overrides: ZCodeV2KeyOverrides = {},
): Promise<string | null> {
  if (value.startsWith(CIPHER_V2_PREFIX)) {
    return decryptZCodeCredentialValueV2(value, storageDir, env, overrides);
  }
  if (value.startsWith(CIPHER_PREFIX)) {
    try {
      return decryptZCodeCredentialValue(value, env);
    } catch {
      return null;
    }
  }
  return value;
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
 */
export async function readDecryptedZCodeCredentials(
  storageDir: string = getZCodeStorageDir(),
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
      if (typeof value !== 'string') {
        continue;
      }
      const plain = await decryptCredentialEntry(value, storageDir, env);
      if (plain === null) {
        // Decryption failed: NEVER retain raw ciphertext as an active token.
        hadDecryptionFailure = true;
      } else {
        decryptedMap[key] = plain;
      }
    }

    const bigmodelToken = readOptionalString(decryptedMap['oauth:bigmodel:access_token']);
    const internationalZaiToken = readOptionalString(decryptedMap['oauth:zai:access_token']);
    // zai_cn is the bigmodel.cn (China) OAuth issuer the 2026-11 desktop login uses.
    const zaiCnToken = readOptionalString(decryptedMap['oauth:zai_cn:access_token']);
    const zcodeJwt = readOptionalString(decryptedMap['zcodejwttoken']);
    const activeProvider = readOptionalString(decryptedMap['oauth:active_provider']);

    const providerFamily: 'bigmodel' | 'zai' = (activeProvider === 'zai' || internationalZaiToken) ? 'zai' : 'bigmodel';
    const accessToken = (providerFamily === 'zai'
      ? internationalZaiToken
      : zaiCnToken ?? bigmodelToken) ?? bigmodelToken ?? internationalZaiToken ?? zaiCnToken ?? zcodeJwt ?? null;

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

    const rawUserInfo = decryptedMap['oauth:bigmodel:user_info']
      ?? decryptedMap['oauth:zai_cn:user_info']
      ?? decryptedMap['oauth:zai:user_info'];
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

/** One resolved coding-plan account the quota endpoints authenticate with. */
export type ZCodeCodingPlanQuotaContext = {
  /** Raw coding-plan credential (`authorization` header, no Bearer prefix). */
  apiKey: string;
  /** Plan/provider family (`bigmodel`, `zai`, or legacy `bigmodel-*-coding-plan`). */
  planFamily: string;
  /** `org-…` organization id from the paired project key location, if stored. */
  organizationId: string | null;
  /** `proj_…` project id from the paired project key location, if stored. */
  projectId: string | null;
};

/** Extracts `user_id` or `id` as a string from a decrypted `oauth:*:user_info` JSON blob. */
function readUserInfoId(rawUserInfo: string | null | undefined): string | null {
  if (!rawUserInfo) {
    return null;
  }
  try {
    const parsed = readObjectRecord(JSON.parse(rawUserInfo));
    const candidate = parsed?.user_id ?? parsed?.id;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
    return readOptionalString(candidate) ?? null;
  } catch {
    return null;
  }
}

/** Parses `oauth:linked_bigmodel` and verifies its `userId` against the active profile id when present. */
function parseLinkedBigModelCredential(
  rawLinked: string | null | undefined,
  expectedUserId: string | null,
): { customerId: string; accessToken: string } | null {
  if (!rawLinked) {
    return null;
  }
  try {
    const parsed = readObjectRecord(JSON.parse(rawLinked));
    const userId = readOptionalString(parsed?.userId);
    const customerId = readOptionalString(parsed?.customerId);
    const accessToken = readOptionalString(parsed?.accessToken);
    if (!customerId || !accessToken) {
      return null;
    }
    if (expectedUserId && userId && userId !== expectedUserId) {
      return null;
    }
    return { customerId, accessToken };
  } catch {
    return null;
  }
}

/**
 * Resolves the coding-plan quota auth context: prefers the active OAuth
 * session's quota credential (`oauth:linked_bigmodel` for `zai_cn` login, or
 * direct `oauth:bigmodel:access_token` / `oauth:zai:access_token`), paired by
 * `customerId` with its `project-key-location:v1:*` entry (`org-…`/`proj_…`
 * scoping headers). Falls back to the legacy single stored coding-plan
 * `api-key` entry only when no OAuth quota credential is stored (ZCode 3.18.2+
 * rotates coding-plan keys without updating legacy `account-provider:*:api-key`
 * rows).
 *
 * Returns null — rather than guessing — when no valid credential is stored or
 * several legacy coding-plan accounts coexist.
 *
 * Consumer: fetchZCodeQuota / consumeZCodeQuotaReset in `zcode-quota.provider.ts`.
 */
export async function readZCodeCodingPlanQuotaContext(
  storageDir: string = getZCodeStorageDir(),
  env: NodeJS.ProcessEnv = process.env,
  overrides: ZCodeV2KeyOverrides = {},
): Promise<ZCodeCodingPlanQuotaContext | null> {
  const credPath = path.join(storageDir, 'v2', 'credentials.json');

  let rawMap: Record<string, unknown>;
  try {
    rawMap = readObjectRecord(JSON.parse(await readFile(credPath, 'utf8'))) ?? {};
  } catch {
    return null;
  }

  const readOAuthField = async (key: string): Promise<string | null> => {
    const rawValue = rawMap[key];
    if (typeof rawValue !== 'string') {
      return null;
    }
    const decrypted = await decryptCredentialEntry(rawValue, storageDir, env, overrides);
    return readOptionalString(decrypted) ?? null;
  };

  const apiKeyEntries: Array<{ planFamily: string; customerId: string; apiKey: string }> = [];
  const locations = new Map<string, { organizationId: string | null; projectId: string | null }>();

  for (const [key, value] of Object.entries(rawMap)) {
    if (typeof value !== 'string') {
      continue;
    }

    const apiKeyMatch = /^account-provider:coding-plan:account:([a-z0-9-]+):account:(\d+):api-key$/.exec(key);
    if (apiKeyMatch) {
      const apiKey = await decryptCredentialEntry(value, storageDir, env, overrides);
      if (apiKey) {
        apiKeyEntries.push({ planFamily: apiKeyMatch[1], customerId: apiKeyMatch[2], apiKey });
      }
      continue;
    }

    const locationMatch = /^project-key-location:v1:(.+)$/.exec(key);
    if (locationMatch) {
      const plain = await decryptCredentialEntry(value, storageDir, env, overrides);
      if (!plain) {
        continue;
      }
      try {
        // The key's selector is `[host, family, customerId, …]`; the value is
        // the org/project metadata scoped to that customer.
        const selector = JSON.parse(decodeURIComponent(locationMatch[1]));
        const meta = JSON.parse(plain);
        const customerId = readOptionalString(selector?.[2]);
        if (!customerId) {
          continue;
        }
        locations.set(customerId, {
          organizationId: readOptionalString(meta?.organizationId) ?? null,
          projectId: readOptionalString(meta?.projectId) ?? null,
        });
      } catch {
        // Malformed selector or metadata: ignore this location entry.
      }
    }
  }

  const activeProvider = await readOAuthField('oauth:active_provider');
  const buildContext = (apiKey: string, planFamily: string, customerId: string | null): ZCodeCodingPlanQuotaContext => {
    const location = customerId ? locations.get(customerId) ?? null : null;
    return {
      apiKey,
      planFamily,
      organizationId: location?.organizationId ?? null,
      projectId: location?.projectId ?? null,
    };
  };

  if (activeProvider === 'zai') {
    const zaiToken = await readOAuthField('oauth:zai:access_token');
    if (zaiToken) {
      const customerId = readUserInfoId(await readOAuthField('oauth:zai:user_info'));
      return buildContext(zaiToken, 'zai', customerId);
    }
  } else {
    if (activeProvider === 'bigmodel') {
      const bigmodelToken = await readOAuthField('oauth:bigmodel:access_token');
      if (bigmodelToken) {
        const customerId = readUserInfoId(await readOAuthField('oauth:bigmodel:user_info'));
        return buildContext(bigmodelToken, 'bigmodel', customerId);
      }
    }

    const activeUserInfo = (await readOAuthField('oauth:zai_cn:user_info'))
      ?? (await readOAuthField('oauth:bigmodel:user_info'));
    const linked = parseLinkedBigModelCredential(
      await readOAuthField('oauth:linked_bigmodel'),
      readUserInfoId(activeUserInfo),
    );
    if (linked) {
      return buildContext(linked.accessToken, 'bigmodel', linked.customerId);
    }

    const bigmodelToken = await readOAuthField('oauth:bigmodel:access_token');
    if (bigmodelToken) {
      const customerId = readUserInfoId(await readOAuthField('oauth:bigmodel:user_info'));
      return buildContext(bigmodelToken, 'bigmodel', customerId);
    }

    const zaiToken = await readOAuthField('oauth:zai:access_token');
    if (zaiToken) {
      const customerId = readUserInfoId(await readOAuthField('oauth:zai:user_info'));
      return buildContext(zaiToken, 'zai', customerId);
    }
  }

  if (apiKeyEntries.length !== 1) {
    return null;
  }

  const entry = apiKeyEntries[0];
  return buildContext(entry.apiKey, entry.planFamily, entry.customerId);
}

/** Reads one selected credential, rejecting missing or undecryptable values. */
function readDecryptedCredential(
  select: (rawMap: Record<string, unknown>) => string | null,
  storageDir = getZCodeStorageDir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const credPath = path.join(storageDir, 'v2', 'credentials.json');
  try {
    const content = fsSync.readFileSync(credPath, 'utf8');
    const rawMap = readObjectRecord(JSON.parse(content));
    if (!rawMap) return null;
    const rawToken = select(rawMap);
    if (!rawToken) {
      return null;
    }
    if (rawToken.startsWith(CIPHER_PREFIX) || rawToken.startsWith(CIPHER_V2_PREFIX)) {
      // Sync consumers cannot stage keychain/file overrides here; reuse the
      // shared decryption with the process defaults.
      const plain = decryptCredentialEntrySync(rawToken, storageDir, env);
      return plain;
    }
    return rawToken;
  } catch {
    return null;
  }
}

/**
 * Synchronous best-effort decryption for the sync readers below: v1 values use
 * the derivable key; v2 values consult the staged os key file or the env
 * secret (never the keychain, which needs async), sharing the async path's
 * key cache so repeated sync reads stay cheap.
 */
function decryptCredentialEntrySync(value: string, storageDir: string, env: NodeJS.ProcessEnv): string | null {
  if (value.startsWith(CIPHER_V2_PREFIX)) {
    // Malformed v2 values must never fall through to the v1 passthrough,
    // which would return the ciphertext verbatim as if it were a token.
    return decryptV2EntrySync(value, storageDir, env);
  }
  try {
    return decryptZCodeCredentialValue(value, env);
  } catch {
    return null;
  }
}

function decryptV2EntrySync(value: string, storageDir: string, env: NodeJS.ProcessEnv): string | null {
  const parsed = parseV2Value(value);
  if (!parsed) {
    return null;
  }

  let key: Buffer | null = v2KeyCache.get(parsed.fingerprint) ?? null;
  if (!key && parsed.source === 'env') {
    const secret = env.ZCODE_CREDENTIAL_SECRET?.trim();
    key = secret ? createHash('sha256').update(secret).digest() : null;
  }
  if (!key && parsed.source === 'os') {
    try {
      const content = fsSync.readFileSync(path.join(storageDir, 'v2', STAGED_KEY_FILE), 'utf8').trim();
      const staged = content ? Buffer.from(content, 'base64url') : null;
      key = staged && staged.length === V2_KEY_BYTES ? staged : null;
    } catch {
      key = null;
    }
  }
  if (!key || v2Fingerprint(key) !== parsed.fingerprint) {
    return null;
  }
  v2KeyCache.set(parsed.fingerprint, key);

  try {
    return openAesGcmPayload(parsed.payload, key);
  } catch {
    return null;
  }
}

/** Used by the account model catalog, send builder, and runtime header bridge. */
export function readDecryptedZCodeIndividualPlanApiKey(
  storageDir = getZCodeStorageDir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readDecryptedCredential((rawMap) => {
    const keys = Object.keys(rawMap).filter((key) =>
      /^account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:[^:]+:api-key$/.test(key));
    // Never guess between accounts: that could charge the wrong subscription.
    return keys.length === 1 ? readOptionalString(rawMap[keys[0]]) ?? null : null;
  }, storageDir, env);
}

/** Used by trial-plan model discovery, send auth, and account activation. */
export function readDecryptedZCodeJwtToken(
  storageDir = getZCodeStorageDir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readDecryptedCredential((rawMap) => readOptionalString(rawMap.zcodejwttoken) ?? null, storageDir, env);
}
