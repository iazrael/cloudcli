import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

async function rejection(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got: ${String(error)}`);
    return error;
  }
  return assert.fail('the plugin operation unexpectedly succeeded');
}

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    scanPlugins: () => [], readConfig: () => ({}), saveConfig: () => undefined,
    getPluginDirectory: () => null, getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null, assetIsFile: () => false, contentType: () => 'text/plain',
    install: async () => ({ name: 'plugin', dirName: 'plugin' }),
    update: async () => ({ name: 'plugin', dirName: 'plugin' }),
    uninstall: async () => undefined, startServer: async () => 4000,
    stopServer: async () => undefined, getServerPort: () => undefined,
    isServerRunning: () => false, joinPath: (...parts) => parts.join('/'),
    logError: () => undefined, ...overrides,
  };
}

test('update restarts a running plugin server when the update fails', async () => {
  const operations: string[] = [];
  let running = true;
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: 'server.js' }],
    getPluginDirectory: () => '/plugins/demo',
    isServerRunning: () => running,
    stopServer: async () => { operations.push('stop'); running = false; },
    update: async () => { operations.push('pull'); throw new Error('git pull failed'); },
    startServer: async () => { operations.push('start'); running = true; return 4000; },
  }));
  await assert.rejects(service.update('demo'), /git pull failed/);
  assert.deepEqual(operations, ['stop', 'pull', 'start']);
});

test('a failed update does not start a plugin server that was not running', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: 'server.js' }],
    getPluginDirectory: () => '/plugins/demo',
    update: async () => { operations.push('pull'); throw new Error('git pull failed'); },
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await assert.rejects(service.update('demo'), /git pull failed/);
  assert.deepEqual(operations, ['pull']);
});

test('setEnabled persists configuration and starts an enabled plugin server', async () => {
  const operations: string[] = [];
  const service = createPluginsService(dependencies({
    scanPlugins: () => [{ name: 'demo', dirName: 'demo', server: { entry: 'server.js' } }],
    getPluginDirectory: () => '/plugins/demo',
    saveConfig: () => operations.push('save'),
    startServer: async () => { operations.push('start'); return 4000; },
  }));
  await service.setEnabled('demo', true);
  assert.deepEqual(operations, ['save', 'start']);
});

test('an install failure from npm or the build becomes a coded AppError', async () => {
  const logged: Array<[string, unknown]> = [];
  const service = createPluginsService(dependencies({
    install: async () => { throw new Error('npm run build failed (exit code 127): sh: 1: tsc: not found'); },
    logError: (message, error) => { logged.push([message, error]); },
  }));

  const error = await rejection(service.install('https://github.com/acme/plugin'));

  assert.equal(error.code, 'PLUGIN_INSTALL_FAILED');
  assert.equal(error.statusCode, 500);
  assert.match(error.message, /^Could not install the plugin: npm run build failed/);
  assert.match(error.message, /tsc: not found/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'Plugin install failed for https://github.com/acme/plugin');
});

test('a git AppError passes through an install unchanged', async () => {
  const gitFailure = new AppError('Could not install the plugin: the repository was not found.', {
    code: 'PLUGIN_GIT_REPO_NOT_FOUND',
    statusCode: 422,
  });
  const service = createPluginsService(dependencies({
    install: async () => { throw gitFailure; },
  }));

  const error = await rejection(service.install('https://github.com/acme/plugin'));

  assert.equal(error, gitFailure);
  assert.equal(error.code, 'PLUGIN_GIT_REPO_NOT_FOUND');
  assert.equal(error.statusCode, 422);
});

test('an update failure from npm or the build becomes a coded AppError', async () => {
  const service = createPluginsService(dependencies({
    update: async () => { throw new Error('npm install for demo failed (exit code 1)'); },
  }));

  const error = await rejection(service.update('demo'));

  assert.equal(error.code, 'PLUGIN_UPDATE_FAILED');
  assert.equal(error.statusCode, 500);
  assert.match(error.message, /^Could not update the plugin: npm install for demo failed/);
});
