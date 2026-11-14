import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encryptZCodeCredentialValue } from '../list/zcode/zcode-credentials.js';
import { clearEnginePathCache } from '../list/zcode/zcode-engine-path.js';
import { buildZCodeSendModelParams } from '../list/zcode/zcode-models.provider.js';
import { ZCodeRunLifecycle } from '../list/zcode/zcode-run-lifecycle.js';

const locationKey = (accountId = '123') => `project-key-location:v1:${encodeURIComponent(JSON.stringify([
  'https://bigmodel.cn', 'bigmodel', accountId, null, 1, 'non-team',
]))}`;

async function withAccount(run: (writeCredentials: (changes?: Record<string, string | null>) => Promise<void>) => Promise<void>) {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zcode-project-auth-'));
  process.env.ZCODE_STORAGE_DIR = directory;
  await mkdir(path.join(directory, 'v2'));
  await mkdir(path.join(directory, 'cli'));
  await writeFile(path.join(directory, 'cli/config.json'), JSON.stringify({ provider: {
    'bigmodel-coding-plan': { kind: 'anthropic', options: { apiKey: 'stale-key', baseURL: 'https://example.invalid' }, models: { 'GLM-5.3-Flash': {} } },
  } }));
  const writeCredentials = async (changes: Record<string, string | null> = {}) => {
    const fields = {
      'oauth:active_provider': 'zai_cn',
      'oauth:zai_cn:user_info': JSON.stringify({ id: 'user-1' }),
      'oauth:linked_bigmodel': JSON.stringify({ userId: 'user-1', customerId: '123', accessToken: 'business-login' }),
      [locationKey()]: JSON.stringify({ organizationId: 'org-test', projectId: 'proj-test', apiKeyId: 'key-test' }),
      ...changes,
    };
    await writeFile(path.join(directory, 'v2/credentials.json'), JSON.stringify(Object.fromEntries(
      Object.entries(fields).flatMap(([key, value]) => value === null ? [] : [[key, encryptZCodeCredentialValue(value)]]),
    )));
  };
  try { await writeCredentials(); await run(writeCredentials); }
  finally {
    if (previous === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('modern personal login routes bare and saved legacy models to the account without sending the stale key', async () => {
  await withAccount(async () => {
    for (const model of ['GLM-5.3-Flash', 'bigmodel-coding-plan/GLM-5.3-Flash', 'builtin:bigmodel-coding-plan/GLM-5.3-Flash']) {
      assert.deepEqual(buildZCodeSendModelParams(model), {
        modelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } },
        modelExecution: { selectionScope: 'execution' },
      });
    }
  });
});

test('runtime headers exchange the current account login for a model token and reuse it', async (t) => {
  await withAccount(async () => {
    const requests: Array<{ url: string; options?: RequestInit }> = [];
    t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      return Response.json({ code: 200, data: { enable: true, accessToken: 'short-lived-model-token', tokenType: 'Bearer', expiresIn: 3600, expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    });
    const lifecycle = new ZCodeRunLifecycle();
    const request = { id: 'req-project', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:bigmodel-individual-coding-plan' } };
    const first = await lifecycle.handleServerRequest(request);
    assert.ok('result' in first);
    const firstResult = first.result as { headersApplied: boolean; requestAuth: { apiKey: string } };
    assert.equal(firstResult.requestAuth.apiKey, 'short-lived-model-token');
    assert.equal(firstResult.headersApplied, true);
    assert.equal(requests[0].url, 'https://bigmodel.cn/api/biz/v1/organization/org-test/projects/proj-test/api_keys/key-test/access_tokens');
    assert.equal(requests[0].options?.method, 'POST');
    assert.equal(new Headers(requests[0].options?.headers).get('Authorization'), 'Bearer business-login');
    assert.equal(JSON.parse(String(requests[0].options?.body)).clientType, 'zcode');
    assert.deepEqual(await lifecycle.handleServerRequest(request), first);
    assert.equal(requests.length, 1);
  });
});

const invalidAccounts: Record<string, Record<string, string>> = {
  'different active profile': { 'oauth:zai_cn:user_info': JSON.stringify({ id: 'other-user' }) },
  'unmatched project account': { 'oauth:linked_bigmodel': JSON.stringify({ userId: 'user-1', customerId: '999', accessToken: 'other-login' }) },
  'incomplete linked account': { 'oauth:linked_bigmodel': JSON.stringify({ customerId: '123', accessToken: 'business-login' }) },
  'unreadable project location': { [locationKey()]: 'not-json' },
  'international account': { 'oauth:active_provider': 'zai' },
};
for (const [name, changes] of Object.entries(invalidAccounts)) {
  test(`modern login refuses ${name} without using a legacy Key`, async (t) => {
    await withAccount(async (write) => {
      await write({ ...changes, 'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'old-personal-key' });
      const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not request'); });
      assert.throws(() => buildZCodeSendModelParams('GLM-5.3-Flash'), /credentials.*active account/);
      const answer = await new ZCodeRunLifecycle().handleServerRequest({ id: 'invalid', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:bigmodel-individual-coding-plan' } });
      assert.ok('result' in answer);
      assert.equal((answer.result as { headersApplied: boolean }).headersApplied, false);
      assert.equal(fetch.mock.callCount(), 0);
    });
  });
}

for (const [name, response] of Object.entries({
  'HTTP rejection': () => Response.json({}, { status: 401 }),
  'business rejection': () => Response.json({ code: 403, data: { accessToken: 'must-not-use' } }),
  'disabled project': () => Response.json({ code: 200, data: { enable: false } }),
  'expired token': () => Response.json({ code: 200, data: { accessToken: 'expired', tokenType: 'Bearer', expiresIn: 3600, expiresAt: 1 } }),
  'invalid expiry': () => Response.json({ code: 200, data: { accessToken: 'bad', tokenType: 'Bearer', expiresIn: '3600', expiresAt: 9999999999 } }),
  'malformed JSON': () => new Response('invalid'),
  'network failure': () => { throw new Error('private request diagnostic must not leak'); },
})) {
  test(`runtime headers reject ${name} and can retry after recovery`, async (t) => {
    await withAccount(async () => {
      let recovered = false;
      t.mock.method(globalThis, 'fetch', async () => recovered
        ? Response.json({ code: 200, data: { accessToken: 'recovered-token', tokenType: 'Bearer', expiresIn: 3600, expiresAt: Math.floor(Date.now() / 1000) + 3600 } })
        : response());
      const lifecycle = new ZCodeRunLifecycle();
      const request = { id: 'failure', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:bigmodel-individual-coding-plan' } };
      const failed = await lifecycle.handleServerRequest(request);
      assert.ok('result' in failed);
      assert.equal((failed.result as { headersApplied: boolean }).headersApplied, false);
      assert.doesNotMatch(JSON.stringify(failed), /business-login|must-not-use|private request diagnostic/);
      recovered = true;
      const success = await lifecycle.handleServerRequest(request);
      assert.ok('result' in success);
      assert.equal((success.result as { requestAuth: { apiKey: string } }).requestAuth.apiKey, 'recovered-token');
    });
  });
}

test('runtime headers refresh early, invalidate rejected tokens, and reject another account scope', async (t) => {
  await withAccount(async () => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, data: {
      accessToken: `token-${++calls}`, tokenType: 'Bearer', expiresIn: 300, expiresAt: Math.floor(now / 1000) + 300,
    } }));
    const lifecycle = new ZCodeRunLifecycle();
    const request = (extra: Record<string, unknown> = {}) => lifecycle.handleServerRequest({ id: 'refresh', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:bigmodel-individual-coding-plan', ...extra } });
    const first = await request();
    assert.ok('result' in first);
    const auth = (first.result as { requestAuth: { apiKey: string; accountScope: string } }).requestAuth;
    const rejected = await request({ expectedAccountScope: '0'.repeat(64) });
    assert.ok('result' in rejected);
    assert.equal((rejected.result as { headersApplied: boolean }).headersApplied, false);
    assert.equal(calls, 1);
    const fingerprint = createHash('sha256').update(auth.apiKey).digest('hex');
    await request({ expectedAccountScope: auth.accountScope, rejectedProjectTokenFingerprint: fingerprint });
    assert.equal(calls, 2);
    now += 181_000;
    await Promise.all([request(), request()]);
    assert.equal(calls, 3);
    const wrongAccess = await request({ accountAccess: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'team-coding-plan', entitled: true } });
    assert.ok('result' in wrongAccess);
    assert.equal((wrongAccess.result as { headersApplied: boolean }).headersApplied, false);
    assert.equal(calls, 3);
  });
});

test('a login change during token exchange discards the old account token', async (t) => {
  await withAccount(async (write) => {
    t.mock.method(globalThis, 'fetch', async () => {
      await write({ 'oauth:linked_bigmodel': JSON.stringify({ userId: 'user-1', customerId: '123', accessToken: 'rotated-login' }) });
      return Response.json({ code: 200, data: { accessToken: 'old-account-token', tokenType: 'Bearer', expiresIn: 3600, expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    });
    const answer = await new ZCodeRunLifecycle().handleServerRequest({ id: 'login-change', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:bigmodel-individual-coding-plan' } });
    assert.ok('result' in answer);
    assert.equal((answer.result as { headersApplied: boolean }).headersApplied, false);
    assert.doesNotMatch(JSON.stringify(answer), /old-account-token|rotated-login/);
  });
});

test('an active zai_cn login without its linked account never uses a residual personal Key', async () => {
  await withAccount(async (write) => {
    await write({
      'oauth:linked_bigmodel': null,
      'oauth:zai_cn:access_token': 'current-login',
      [locationKey()]: null,
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:old-account:api-key': 'old-account-key',
    });
    assert.throws(() => buildZCodeSendModelParams('GLM-5.3-Flash'), /credentials.*active account/);
  });
});

test('a bound modern engine request cannot fall back to a legacy account after login removal', async () => {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-legacy-scope-'));
  process.env.ZCODE_STORAGE_DIR = root;
  try {
    await mkdir(path.join(root, 'v2'));
    await writeFile(path.join(root, 'v2/credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'old-account-key',
    }));
    const answer = await new ZCodeRunLifecycle().handleServerRequest({ id: 'bound', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: 'account:bigmodel-individual-coding-plan', expectedAccountScope: '0'.repeat(64) } });
    assert.ok('result' in answer);
    assert.equal((answer.result as { headersApplied: boolean }).headersApplied, false);
    assert.doesNotMatch(JSON.stringify(answer), /old-account-key/);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_STORAGE_DIR;
    else process.env.ZCODE_STORAGE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

for (const version of ['3.17.2', '3.18.2']) {
  test(`BigModel OAuth with a saved personal Key respects the ${version} app authentication contract`, async () => {
    await withAccount(async (write) => {
      const appRoot = path.join(process.env.ZCODE_STORAGE_DIR!, 'ZCode.app/Contents');
      const engineDir = path.join(appRoot, 'Resources/glm');
      await mkdir(engineDir, { recursive: true });
      await writeFile(path.join(engineDir, 'zcode.cjs'), '');
      await writeFile(path.join(appRoot, 'Info.plist'), `<plist><key>CFBundleShortVersionString</key><string>${version}</string></plist>`);
      const previousEngine = process.env.CLOUDCLI_ZCODE_ENGINE;
      process.env.CLOUDCLI_ZCODE_ENGINE = path.join(engineDir, 'zcode.cjs');
      clearEnginePathCache();
      try {
        await write({
          'oauth:linked_bigmodel': null,
          'oauth:zai_cn:user_info': null,
          'oauth:active_provider': 'bigmodel',
          'oauth:bigmodel:user_info': JSON.stringify({ id: '123' }),
          'oauth:bigmodel:access_token': 'bigmodel-login',
          [locationKey()]: null,
          'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'legacy-personal-key',
        });
        if (version === '3.17.2') {
          assert.equal(buildZCodeSendModelParams('GLM-5.3-Flash')?.modelExecution.requestAuth?.apiKey, 'legacy-personal-key');
          await write({
            'oauth:linked_bigmodel': null, 'oauth:zai_cn:user_info': null, 'oauth:active_provider': 'bigmodel',
            'oauth:bigmodel:user_info': JSON.stringify({ id: 'other-account' }), 'oauth:bigmodel:access_token': 'bigmodel-login',
            [locationKey()]: null,
            'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'legacy-personal-key',
          });
        }
        assert.throws(() => buildZCodeSendModelParams('GLM-5.3-Flash'), /credentials.*active account/);
      } finally {
        if (previousEngine === undefined) delete process.env.CLOUDCLI_ZCODE_ENGINE;
        else process.env.CLOUDCLI_ZCODE_ENGINE = previousEngine;
        clearEnginePathCache();
      }
    });
  });
}
