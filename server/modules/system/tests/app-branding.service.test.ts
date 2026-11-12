import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createAppBrandingService } from '../app-branding.service.js';

type AppBrandingDependencies = Parameters<typeof createAppBrandingService>[0];

const APP_ROOT = path.join('/app/cloudcli');
const MANIFEST_RELATIVE_PATH = 'public/manifest.json';
const INDEX_RELATIVE_PATH = 'dist/index.html';

const DEFAULT_MANIFEST = JSON.stringify({
  name: 'CloudCLI UI',
  short_name: 'CloudCLI UI',
  description: 'CloudCLI UI web application',
  icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192' }],
});

const DEFAULT_INDEX_HTML = [
  '<html><head>',
  '<title>CloudCLI UI</title>',
  '<meta name="apple-mobile-web-app-title" content="Claude UI" />',
  '</head><body></body></html>',
].join('');

function createTestContext(options: {
  manifest?: string | null;
  manifestRelativePath?: string;
  indexHtml?: string | null;
  environment?: NodeJS.ProcessEnv;
} = {}) {
  const files = new Map<string, string>();
  const manifest = options.manifest === undefined ? DEFAULT_MANIFEST : options.manifest;
  const indexHtml = options.indexHtml === undefined ? DEFAULT_INDEX_HTML : options.indexHtml;
  if (manifest !== null) {
    files.set(options.manifestRelativePath ?? MANIFEST_RELATIVE_PATH, manifest);
  }
  if (indexHtml !== null) {
    files.set(INDEX_RELATIVE_PATH, indexHtml);
  }

  const toRelativePath = (filePath: string) =>
    path.relative(APP_ROOT, filePath).split(path.sep).join('/');

  const dependencies: AppBrandingDependencies = {
    appRoot: APP_ROOT,
    environment: options.environment ?? {},
    readFile: (filePath) => {
      const content = files.get(toRelativePath(filePath));
      if (content === undefined) {
        throw new Error(`Unexpected read: ${filePath}`);
      }
      return content;
    },
    fileExists: (filePath) => files.has(toRelativePath(filePath)),
    logError: () => undefined,
    logWarn: () => undefined,
  };

  return { dependencies, files };
}

test('falls back to the neutral default, never the hostname, when CLOUDCLI_NODE_NAME is unset', () => {
  // The manifest and the shell are served without authentication (PWA installs
  // happen pre-auth, including over tunnels), so the hostname must not leak
  // through the name fields.
  const { dependencies } = createTestContext();
  const service = createAppBrandingService(dependencies);

  const manifest = JSON.parse(service.getManifestJson()) as { name: string; short_name: string };

  assert.equal(service.getAppName(), 'CloudCLI');
  assert.equal(manifest.name, 'CloudCLI');
  assert.equal(manifest.short_name, 'CloudCLI');
});

test('uses CLOUDCLI_NODE_NAME when set', () => {
  const { dependencies } = createTestContext({
    environment: { CLOUDCLI_NODE_NAME: 'GPU 节点' },
  });
  const service = createAppBrandingService(dependencies);

  assert.equal(service.getAppName(), 'GPU 节点');
  assert.equal(service.getShortName(), 'GPU 节点');
});

test('strips Windows host prefixes from the short name only', () => {
  const { dependencies } = createTestContext({
    environment: { CLOUDCLI_NODE_NAME: 'DESKTOP-ABC123' },
  });
  const service = createAppBrandingService(dependencies);

  assert.equal(service.getAppName(), 'DESKTOP-ABC123');
  assert.equal(service.getShortName(), 'ABC123');
});

test('truncates long names for the home-screen label', () => {
  const { dependencies } = createTestContext({
    environment: { CLOUDCLI_NODE_NAME: 'ABCDEFGHIJKLMNOPQRST' },
  });
  const service = createAppBrandingService(dependencies);

  assert.equal(service.getAppName(), 'ABCDEFGHIJKLMNOPQRST');
  assert.equal(service.getShortName(), 'ABCDEFGHIJKL');
});

test('keeps the packaged manifest fields and overrides only the names', () => {
  const { dependencies } = createTestContext();
  const service = createAppBrandingService(dependencies);

  const manifest = JSON.parse(service.getManifestJson()) as Record<string, unknown>;

  assert.equal(manifest.description, 'CloudCLI UI web application');
  assert.deepEqual(manifest.icons, [{ src: '/icons/icon-192x192.png', sizes: '192x192' }]);
});

test('falls back to a minimal manifest when the packaged file is missing', () => {
  const { dependencies } = createTestContext({ manifest: null });
  const service = createAppBrandingService(dependencies);

  const manifest = JSON.parse(service.getManifestJson()) as Record<string, unknown>;

  assert.equal(manifest.name, 'CloudCLI');
  assert.equal(manifest.display, 'standalone');
});

test('reads the built manifest when the source public copy is not packaged', () => {
  const { dependencies } = createTestContext({ manifestRelativePath: 'dist/manifest.json' });
  const service = createAppBrandingService(dependencies);

  const manifest = JSON.parse(service.getManifestJson()) as Record<string, unknown>;

  assert.equal(manifest.description, 'CloudCLI UI web application');
  assert.deepEqual(manifest.icons, [{ src: '/icons/icon-192x192.png', sizes: '192x192' }]);
});

test('injects the app name into the apple mobile web app title', () => {
  const { dependencies } = createTestContext();
  const service = createAppBrandingService(dependencies);

  const html = service.renderIndexHtml();

  assert.ok(html);
  assert.ok(html.includes('<meta name="apple-mobile-web-app-title" content="CloudCLI" />'));
  assert.ok(html.includes('<title>CloudCLI UI</title>'));
});

test('escapes the app name before injecting it into HTML', () => {
  const { dependencies } = createTestContext({
    environment: { CLOUDCLI_NODE_NAME: 'a"b' },
  });
  const service = createAppBrandingService(dependencies);

  const html = service.renderIndexHtml();

  assert.ok(html);
  assert.ok(html.includes('content="a&quot;b"'));
});

test('does not interpret replacement patterns in the node name', () => {
  const { dependencies } = createTestContext({
    environment: { CLOUDCLI_NODE_NAME: 'Mac $& PWA' },
  });
  const service = createAppBrandingService(dependencies);

  const html = service.renderIndexHtml();

  assert.ok(html);
  assert.ok(html.includes('content="Mac $&amp; PWA"'), html);
});

test('reads the manifest and index shell fresh on every request', () => {
  const { dependencies, files } = createTestContext();
  const service = createAppBrandingService(dependencies);

  assert.ok(JSON.parse(service.getManifestJson()).description === 'CloudCLI UI web application');
  files.set(MANIFEST_RELATIVE_PATH, JSON.stringify({ description: 'rebuilt manifest' }));
  files.set(INDEX_RELATIVE_PATH, DEFAULT_INDEX_HTML.replace('Claude UI', 'Rebuilt UI'));
  assert.equal(JSON.parse(service.getManifestJson()).description, 'rebuilt manifest');
  assert.ok(service.renderIndexHtml()?.includes('<title>CloudCLI UI</title>'));
  assert.ok(service.renderIndexHtml()?.includes('content="CloudCLI"'));
});

test('falls through to the built manifest when the source copy is unparseable', () => {
  const { dependencies, files } = createTestContext({ manifest: '{not json' });
  files.set('dist/manifest.json', DEFAULT_MANIFEST);
  const service = createAppBrandingService(dependencies);

  const manifest = JSON.parse(service.getManifestJson()) as Record<string, unknown>;

  assert.equal(manifest.description, 'CloudCLI UI web application');
});

test('returns null when no production build is present', () => {
  const { dependencies } = createTestContext({ indexHtml: null });
  const service = createAppBrandingService(dependencies);

  assert.equal(service.renderIndexHtml(), null);
});
