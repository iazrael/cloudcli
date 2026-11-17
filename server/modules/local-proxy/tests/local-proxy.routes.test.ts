import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  createLocalProxyRouter,
  localProxyAbsolutePathFallback,
} from '@/modules/local-proxy/local-proxy.routes.js';
import { AppError } from '@/shared/utils.js';

type ProxyHarness = {
  baseUrl: string;
  upstreamPort: number;
};

/**
 * Runs the proxy routes in front of a throwaway upstream service, with
 * authentication stubbed out so the tests exercise the proxy's own credentials
 * rather than the app's JWT middleware.
 */
async function withProxy(
  upstreamHandler: http.RequestListener,
  run: (harness: ProxyHarness) => Promise<void>,
): Promise<void> {
  const upstream = http.createServer(upstreamHandler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const app = express();
  app.use(express.json());
  app.use('/api/local-proxy', createLocalProxyRouter((_req: Request, _res: Response, next: NextFunction) => next()));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    res.status(status).json({ success: false, error: { code } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, upstreamPort });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function mintProxyPath(harness: ProxyHarness, targetPath = '/report.html'): Promise<string> {
  const response = await fetch(`${harness.baseUrl}/api/local-proxy/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://localhost:${harness.upstreamPort}${targetPath}` }),
  });
  const payload = await response.json() as { data: { proxyPath: string } };
  return payload.data.proxyPath;
}

const respondWithEcho: http.RequestListener = (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html',
    'set-cookie': 'upstream_session=1',
  });
  res.end(`<html>${req.url}</html>`);
};

test('mints a proxy path for a loopback URL', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness, '/report.html?tab=2');

    assert.match(proxyPath, new RegExp(`^/api/local-proxy/p/${harness.upstreamPort}/report\\.html\\?`));
    assert.ok(new URL(proxyPath, harness.baseUrl).searchParams.get('ticket'));
  });
});

test('refuses to mint a ticket for a non-loopback target', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const response = await fetch(`${harness.baseUrl}/api/local-proxy/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://example.com/' }),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'LOCAL_PROXY_INVALID_TARGET');
  });
});

test('spends the ticket for a session cookie and redirects the ticket out of the URL', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness, '/report.html?tab=2');

    const response = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });

    assert.equal(response.status, 302);
    const location = response.headers.get('location') ?? '';
    assert.equal(location, `/api/local-proxy/p/${harness.upstreamPort}/report.html?tab=2`);
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^cloudcli_local_proxy=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/api\/local-proxy/i);
  });
});

test('serves the upstream page to a request carrying the session cookie', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness);
    const redirect = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });
    const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0];

    const response = await fetch(`${harness.baseUrl}/api/local-proxy/p/${harness.upstreamPort}/assets/app.js`, {
      headers: { cookie },
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<html>/assets/app.js</html>');
    // The upstream's own cookie must not be planted on the cloudcli origin.
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

test('forwards a non-ASCII document path percent-encoded to the upstream service', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness, '/试听.html');
    const redirect = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });
    const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0];

    const response = await fetch(`${harness.baseUrl}/api/local-proxy/p/${harness.upstreamPort}/试听.html`, {
      headers: { cookie },
    });

    assert.equal(response.status, 200);
    // The upstream sees the encoded form; passing the decoded path would make
    // http.request throw ERR_UNESCAPED_CHARACTERS and surface as a 500.
    assert.equal(await response.text(), '<html>/%E8%AF%95%E5%90%AC.html</html>');
  });
});

test('keeps an already-encoded non-ASCII query intact', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness, '/report.html?q=中文');
    const redirect = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });
    const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0];

    const response = await fetch(`${harness.baseUrl}/api/local-proxy/p/${harness.upstreamPort}/report.html?q=中文`, {
      headers: { cookie },
    });

    assert.equal(response.status, 200);
    // Re-encoding the query would turn %E4%B8%AD%E6%96%87 into %25E4%25B8%25AD%E6%2596%2587.
    assert.equal(await response.text(), '<html>/report.html?q=%E4%B8%AD%E6%96%87</html>');
  });
});

test('rejects a request with neither ticket nor session cookie', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const response = await fetch(`${harness.baseUrl}/api/local-proxy/p/${harness.upstreamPort}/report.html`);

    assert.equal(response.status, 401);
  });
});

test('rejects a spent ticket', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness);
    await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });

    const replay = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });

    assert.equal(replay.status, 401);
  });
});

test('allows only GET and HEAD through the proxy', async () => {
  await withProxy(respondWithEcho, async (harness) => {
    const proxyPath = await mintProxyPath(harness);
    const redirect = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });
    const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0];

    const response = await fetch(`${harness.baseUrl}/api/local-proxy/p/${harness.upstreamPort}/report.html`, {
      method: 'POST',
      headers: { cookie },
    });

    assert.equal(response.status, 405);
  });
});

test('does not forward the caller cookies or credentials to the local service', async () => {
  const seen: Array<http.IncomingHttpHeaders> = [];
  await withProxy(
    (req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
    async (harness) => {
      const proxyPath = await mintProxyPath(harness);
      const redirect = await fetch(`${harness.baseUrl}${proxyPath}`, { redirect: 'manual' });
      const cookie = (redirect.headers.get('set-cookie') ?? '').split(';')[0];

      await fetch(`${harness.baseUrl}/api/local-proxy/p/${harness.upstreamPort}/report.html`, {
        headers: { cookie, authorization: 'Bearer secret-jwt', 'accept-language': 'zh-CN' },
      });

      const forwarded = seen.at(-1) ?? {};
      assert.equal(forwarded.cookie, undefined);
      assert.equal(forwarded.authorization, undefined);
      assert.equal(forwarded['accept-language'], 'zh-CN');
    },
  );
});

/**
 * Mounts only the absolute-path fallback, with a stand-in for the SPA's static
 * handler behind it, so the redirect decision can be checked on its own.
 */
async function withAbsolutePathFallback(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(localProxyAbsolutePathFallback);
  app.use((_req: Request, res: Response) => {
    res.status(200).send('spa');
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('redirects a proxied page root-absolute asset request back into its proxy prefix', async () => {
  await withAbsolutePathFallback(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/app.js?v=1`, {
      redirect: 'manual',
      headers: { referer: `${baseUrl}/api/local-proxy/p/4174/report.html` },
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/api/local-proxy/p/4174/assets/app.js?v=1');
  });
});

test('leaves the app own requests alone', async () => {
  await withAbsolutePathFallback(async (baseUrl) => {
    const noReferer = await fetch(`${baseUrl}/assets/app.js`, { redirect: 'manual' });
    assert.equal(noReferer.status, 200);

    const appReferer = await fetch(`${baseUrl}/assets/app.js`, {
      redirect: 'manual',
      headers: { referer: `${baseUrl}/chat/123` },
    });
    assert.equal(appReferer.status, 200);

    // API calls from a proxied page must not be bounced into the proxy.
    const apiCall = await fetch(`${baseUrl}/api/user/me`, {
      redirect: 'manual',
      headers: { referer: `${baseUrl}/api/local-proxy/p/4174/report.html` },
    });
    assert.equal(apiCall.status, 200);
  });
});
