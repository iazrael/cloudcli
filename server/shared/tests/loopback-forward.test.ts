import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { forwardToLoopbackService } from '@/shared/utils.js';

type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * Starts an upstream service on the loopback interface plus a tiny Express app
 * that forwards everything to it, then runs the assertions against the Express
 * app's base URL.
 */
async function withForwardingPair(
  upstreamHandler: UpstreamHandler,
  run: (baseUrl: string) => Promise<void>,
  options: { transformResponseHeaders?: Parameters<typeof forwardToLoopbackService>[0]['transformResponseHeaders'] } = {},
): Promise<void> {
  const upstream = http.createServer(upstreamHandler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const app = express();
  app.use(express.text({ type: '*/*' }));
  app.use((req, res, next) => {
    // Production callers pass Express-decoded pathnames and an already-encoded
    // query; the forwarder re-encodes the pathname, so the fixture must not
    // hand it the still-encoded originalUrl verbatim.
    const queryIndex = req.originalUrl.indexOf('?');
    const search = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
    forwardToLoopbackService(
      {
        port: upstreamPort,
        path: `${decodeURIComponent(req.path)}${search}`,
        method: req.method,
        headers: { 'x-forwarded-test': 'yes' },
        body: typeof req.body === 'string' && req.body.length > 0 ? req.body : undefined,
        transformResponseHeaders: options.transformResponseHeaders,
      },
      res,
      next,
    );
  });

  const proxy = app.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = (proxy.address() as AddressInfo).port;

  try {
    await run(`http://127.0.0.1:${proxyPort}`);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test('streams the upstream status, headers and body back to the caller', async () => {
  await withForwardingPair(
    (req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain; charset=utf-8', 'x-upstream': req.url ?? '' });
      res.end('hello from upstream');
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/report.html?tab=2`);

      assert.equal(response.status, 201);
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(response.headers.get('x-upstream'), '/report.html?tab=2');
      assert.equal(await response.text(), 'hello from upstream');
    },
  );
});

test('forwards the request method, headers and body', async () => {
  await withForwardingPair(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          marker: req.headers['x-forwarded-test'],
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'payload',
      });

      assert.deepEqual(await response.json(), { method: 'POST', marker: 'yes', body: 'payload' });
    },
  );
});

test('applies the response header transform before writing the head', async () => {
  await withForwardingPair(
    (_req, res) => {
      res.writeHead(200, { 'set-cookie': 'upstream=1', 'content-type': 'text/html' });
      res.end('<html></html>');
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);

      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('x-rewritten'), 'done');
    },
    {
      transformResponseHeaders: (headers) => {
        const { 'set-cookie': _dropped, ...rest } = headers;
        return { ...rest, 'x-rewritten': 'done' };
      },
    },
  );
});

test('reports connection failures through the error callback', async () => {
  const app = express();
  const reportedErrors: Error[] = [];
  app.use((_req, res) => {
    forwardToLoopbackService(
      // Port 1 is never listening in the test environment.
      { port: 1, path: '/', method: 'GET', headers: {} },
      res,
      (error) => {
        reportedErrors.push(error);
        res.status(502).end('upstream unreachable');
      },
    );
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 502);
    assert.equal(reportedErrors.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
