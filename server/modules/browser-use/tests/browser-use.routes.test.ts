import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createBrowserUseRouter, type BrowserUseRouterService } from '@/modules/browser-use/browser-use.routes.js';
import { MANUAL_MAX_SCROLL_DELTA, MANUAL_TYPE_MAX_LENGTH } from '@/modules/browser-use/browser-use.service.js';

type RecordedCall = { args: unknown[]; result: unknown };

function fakeService(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const calls: Record<string, RecordedCall[]> = {};
  const record = (name: string, result: unknown) => async (...args: unknown[]) => {
    (calls[name] ||= []).push({ args, result });
    if (overrides[name]) {
      return overrides[name](args);
    }
    return result;
  };

  const manualSession = {
    id: 'session-1',
    createdBy: 'manual',
    status: 'ready',
    url: 'http://192.168.1.1/',
    title: 'Router',
    screenshotDataUrl: 'data:image/jpeg;base64,abc',
    viewport: { width: 1024, height: 768 },
  };

  return {
    calls,
    manualSession,
    service: {
      createManualSession: record('createManualSession', manualSession),
      getManualScreen: record('getManualScreen', manualSession),
      manualNavigate: record('manualNavigate', manualSession),
      manualNav: record('manualNav', manualSession),
      manualClick: record('manualClick', manualSession),
      manualScroll: record('manualScroll', manualSession),
      manualType: record('manualType', manualSession),
      manualPressKey: record('manualPressKey', manualSession),
      manualViewport: record('manualViewport', { ...manualSession, viewport: { width: 390, height: 844 } }),
    } as unknown as BrowserUseRouterService,
  };
}

async function withServer(
  service: BrowserUseRouterService,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/browser-use', createBrowserUseRouter(service));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const json = async (response: Response) => await response.json() as Record<string, any>;

test('POST /sessions creates a manual session', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.success, true);
    assert.equal(body.data.session.createdBy, 'manual');
    assert.deepEqual(fake.calls.createManualSession?.[0].args, []);
  });
});

test('POST /sessions maps service failures to SESSION_CREATE_FAILED', async () => {
  const fake = fakeService({
    createManualSession: () => {
      throw new Error('Browser is disabled in settings.');
    },
  });
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions`, { method: 'POST' });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.error.code, 'BROWSER_USE_SESSION_CREATE_FAILED');
    assert.equal(body.error.details, 'Browser is disabled in settings.');
  });
});

test('GET /sessions/:id/screen returns the refreshed session', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/screen`);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.success, true);
    assert.equal(body.data.session.screenshotDataUrl, 'data:image/jpeg;base64,abc');
    assert.deepEqual(fake.calls.getManualScreen?.[0].args, ['session-1']);
  });
});

test('GET /sessions/:id/screen maps failures to SESSION_SCREEN_LOAD_FAILED', async () => {
  const fake = fakeService({
    getManualScreen: () => {
      throw new Error('Browser session not found.');
    },
  });
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/missing/screen`);
    assert.equal(response.status, 500);
    const body = await json(response);
    assert.equal(body.error.code, 'BROWSER_USE_SESSION_SCREEN_LOAD_FAILED');
  });
});

test('POST navigate normalizes bare LAN addresses before calling the service', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '192.168.1.1' }),
    });
    assert.equal(response.status, 200);
    assert.equal(fake.calls.manualNavigate?.[0].args[1], 'http://192.168.1.1/');
  });
});

test('POST navigate rejects empty and non-http URLs without calling the service', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    for (const url of ['', 'file:///etc/passwd']) {
      const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      assert.equal(response.status, 400, url);
      const body = await json(response);
      assert.equal(body.error.code, 'BROWSER_USE_SESSION_CONTROL_FAILED');
    }
    assert.equal(fake.calls.manualNavigate, undefined);
  });
});

test('POST nav accepts only back/forward/reload', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    for (const action of ['back', 'forward', 'reload']) {
      const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/nav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      assert.equal(response.status, 200, action);
    }
    assert.deepEqual(fake.calls.manualNav?.map((call) => call.args[1]), ['back', 'forward', 'reload']);

    const invalid = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/nav`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(fake.calls.manualNav?.length, 3);
  });
});

test('POST click forwards finite viewport coordinates', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 120.4, y: 300 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fake.calls.manualClick?.[0].args[1], { x: 120.4, y: 300 });

    for (const point of [{ x: 'a', y: 1 }, { x: Number.NaN, y: 1 }]) {
      const invalid = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(point),
      });
      assert.equal(invalid.status, 400, JSON.stringify(point));
    }
    assert.equal(fake.calls.manualClick?.length, 1);
  });
});

test('POST scroll clamps deltas to the manual scroll budget', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deltaX: 0, deltaY: -600 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fake.calls.manualScroll?.[0].args[1], { deltaX: 0, deltaY: -600 });

    const invalid = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deltaX: 0, deltaY: MANUAL_MAX_SCROLL_DELTA + 1 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(fake.calls.manualScroll?.length, 1);
  });
});

test('POST type enforces the manual text budget', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/type`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'admin' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(fake.calls.manualType?.[0].args[1], 'admin');

    for (const text of ['', 'a'.repeat(MANUAL_TYPE_MAX_LENGTH + 1)]) {
      const invalid = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      assert.equal(invalid.status, 400, `${text.length} chars`);
    }
    assert.equal(fake.calls.manualType?.length, 1);
  });
});

test('POST key only forwards allowlisted keys', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    for (const key of ['Enter', 'Backspace', 'ArrowDown', 'PageUp']) {
      const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      assert.equal(response.status, 200, key);
    }
    assert.deepEqual(fake.calls.manualPressKey?.map((call) => call.args[1]), ['Enter', 'Backspace', 'ArrowDown', 'PageUp']);

    for (const key of ['a', 'Meta+a', 'F12']) {
      const invalid = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      assert.equal(invalid.status, 400, key);
    }
    assert.equal(fake.calls.manualPressKey?.length, 4);
  });
});

test('POST viewport switches the manual session layout', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/viewport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: 390, height: 844 }),
    });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.data.session.viewport, { width: 390, height: 844 });
    assert.deepEqual(fake.calls.manualViewport?.[0].args[1], { width: 390, height: 844 });
  });
});

test('POST viewport rejects non-integer and out-of-range sizes', async () => {
  const fake = fakeService();
  await withServer(fake.service, async (baseUrl) => {
    for (const size of [
      { width: 200, height: 400 },
      { width: 3000, height: 400 },
      { width: 390.5, height: 844 },
      { width: '390', height: 844 },
      { width: null, height: 844 },
    ]) {
      const response = await fetch(`${baseUrl}/api/browser-use/sessions/session-1/viewport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(size),
      });
      assert.equal(response.status, 400, JSON.stringify(size));
      const body = await json(response);
      assert.equal(body.error.code, 'BROWSER_USE_SESSION_CONTROL_FAILED');
    }
    assert.equal(fake.calls.manualViewport, undefined);
  });
});

test('manual control failures map to SESSION_CONTROL_FAILED', async () => {
  const fake = fakeService({
    manualNavigate: () => {
      throw new Error('Browser session not found.');
    },
  });
  await withServer(fake.service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions/missing/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://192.168.1.1/' }),
    });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.error.code, 'BROWSER_USE_SESSION_CONTROL_FAILED');
    assert.equal(body.error.details, 'Browser session not found.');
  });
});
