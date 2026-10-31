import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    readExternalTextFile: unexpectedOperation,
    openExternalFile: unexpectedOperation,
    openFile: unexpectedOperation,
    resolveImagePath: unexpectedOperation,
    checkPathsExist: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

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

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('external-file route forwards the requested path to the read-only service', async () => {
  const inputs: string[] = [];
  const services = createFakeServices({
    readExternalTextFile: async (filePath) => {
      inputs.push(filePath);
      return { content: '# Plan', path: filePath };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/external-file?path=${encodeURIComponent('/home/user/.gemini/antigravity-cli/brain/session/plan.md')}`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      content: '# Plan',
      path: '/home/user/.gemini/antigravity-cli/brain/session/plan.md',
    });
  });

  assert.deepEqual(inputs, ['/home/user/.gemini/antigravity-cli/brain/session/plan.md']);
});

test('external-file route rejects requests without a path before calling the service', async () => {
  let readCalled = false;
  const services = createFakeServices({
    readExternalTextFile: async () => {
      readCalled = true;
      throw new Error('readExternalTextFile should not run without a path');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/external-file`);
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Invalid file path');
  });

  assert.equal(readCalled, false);
});

test('external-file content route streams an external media file with proper content type', async () => {
  const inputs: string[] = [];
  const services = createFakeServices({
    openExternalFile: async (filePath) => {
      inputs.push(filePath);
      return {
        contentType: 'image/png',
        stream: Readable.from(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/external-file/content?path=${encodeURIComponent('/home/user/.cloudcli/assets/shot.png')}`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = await response.arrayBuffer();
    assert.equal(bytes.byteLength, 4);
  });

  assert.deepEqual(inputs, ['/home/user/.cloudcli/assets/shot.png']);
});

test('external-file routes forward optional projectId to services', async () => {
  const textCalls: Array<{ path: string; projectId?: string }> = [];
  const contentCalls: Array<{ path: string; projectId?: string }> = [];

  const services = createFakeServices({
    readExternalTextFile: async (filePath, projectId) => {
      textCalls.push({ path: filePath, projectId });
      return { content: 'hello', path: filePath };
    },
    openExternalFile: async (filePath, projectId) => {
      contentCalls.push({ path: filePath, projectId });
      return {
        contentType: 'image/png',
        stream: Readable.from([]),
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const textRes = await fetch(
      `${baseUrl}/api/file-tree/external-file?path=${encodeURIComponent('/worktrees/feat/file.txt')}&projectId=proj-123`,
    );
    assert.equal(textRes.status, 200);

    const contentRes = await fetch(
      `${baseUrl}/api/file-tree/external-file/content?path=${encodeURIComponent('/worktrees/feat/img.png')}&projectId=proj-123`,
    );
    assert.equal(contentRes.status, 200);
  });

  assert.deepEqual(textCalls, [{ path: '/worktrees/feat/file.txt', projectId: 'proj-123' }]);
  assert.deepEqual(contentCalls, [{ path: '/worktrees/feat/img.png', projectId: 'proj-123' }]);
});

test('paths/exists forwards the batch and echoes per-path statuses', async () => {
  const inputs: Parameters<FileTreeServices['checkPathsExist']>[] = [];
  const services = createFakeServices({
    checkPathsExist: async (...input) => {
      inputs.push(input);
      return input[0].map(({ id }) => ({ id, status: 200 }));
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/paths/exists`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'a', path: 'src/a.ts', projectId: 'p1' },
          { id: 'b', path: '/tmp/b.txt' },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [{ id: 'a', status: 200 }, { id: 'b', status: 200 }] });
  });

  assert.deepEqual(inputs, [[
    [
      { id: 'a', path: 'src/a.ts', projectId: 'p1' },
      { id: 'b', path: '/tmp/b.txt' },
    ],
  ]]);
});

test('paths/exists rejects malformed, duplicate and oversized batches', async () => {
  const services = createFakeServices({
    checkPathsExist: async () => {
      throw new Error('checkPathsExist must not run for invalid batches');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const post = (body: unknown) => fetch(`${baseUrl}/api/file-tree/paths/exists`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    assert.equal((await post({})).status, 400);
    assert.equal((await post({ items: [] })).status, 400);
    assert.equal((await post({ items: [{ id: 'a', path: 5 }] })).status, 400);
    assert.equal((await post({ items: [{ id: 'a', path: 'a' }, { id: 'a', path: 'b' }] })).status, 400);
    assert.equal((await post({ items: Array.from({ length: 51 }, (_, index) => ({ id: `id-${index}`, path: 'a.ts' })) })).status, 400);
  });
});
