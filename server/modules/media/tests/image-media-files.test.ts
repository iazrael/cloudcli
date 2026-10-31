import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import mime from 'mime-types';

import { createImageMediaFiles } from '@/modules/media/image-media-files.service.js';
import { AppError } from '@/shared/utils.js';

async function fixture(run: (context: { root: string; assets: string; project: string; files: ReturnType<typeof createImageMediaFiles> }) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-signed-files-'));
  const root = await realpath(temp);
  const assets = path.join(root, 'assets');
  const project = path.join(root, 'project');
  await mkdir(assets); await mkdir(project);
  const files = createImageMediaFiles({
    resolveAssetPath: (filename) => !filename.includes('/') && !filename.includes('..') ? path.join(assets, filename) : null,
    resolveFilePath: async ({ path: filePath, projectId, external }) => {
      const canonical = await realpath(path.resolve(external ? root : project, filePath));
      const allowedRoot = external ? assets : project;
      if ((!external && projectId !== 'p') || !canonical.startsWith(allowedRoot + path.sep)) {
        throw new AppError('denied', { statusCode: 403 });
      }
      return { path: canonical, contentType: mime.lookup(canonical) || 'application/octet-stream' };
    },
  });
  try { await run({ root, assets, project, files }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('missing legacy assets fall back to project files; external project fallback binds the canonical result', async () => {
  await fixture(async ({ files, project }) => {
    await writeFile(path.join(project, 'old.png'), 'PNG');
    const attachment = await files.resolveImage({ kind: 'asset', filename: 'old.png', projectId: 'p', fallbackPath: 'old.png' });
    assert.deepEqual(attachment.source, { kind: 'project', projectId: 'p', path: path.join(project, 'old.png') });
    const external = await files.resolveImage({ kind: 'external', path: path.join(project, 'old.png'), projectId: 'p', projectFallback: true });
    assert.deepEqual(external.source, attachment.source);
    const stream = await files.openImage(attachment);
    let bytes = ''; for await (const chunk of stream) bytes += chunk.toString();
    assert.equal(bytes, 'PNG');
    assert.equal(stream.destroyed, true);
  });
});

test('non-image files, asset traversal and cross-directory asset symlinks cannot be signed', async () => {
  await fixture(async ({ files, assets, project }) => {
    await writeFile(path.join(assets, 'active.html'), '<script>alert(1)</script>');
    await writeFile(path.join(project, 'private.png'), 'PRIVATE');
    await symlink(path.join(project, 'private.png'), path.join(assets, 'escape.png'));
    for (const filename of ['active.html', '../project/private.png', 'escape.png']) {
      await assert.rejects(files.resolveImage({ kind: 'asset', filename }), (error: unknown) => error instanceof AppError && [403, 415].includes(error.statusCode));
    }
  });
});

test('replacing an image after inspection cannot return replacement bytes; destroying a read stream closes its descriptor', async () => {
  await fixture(async ({ files, assets }) => {
    const filePath = path.join(assets, 'a.png');
    await writeFile(filePath, 'ORIGINAL');
    const inspected = await files.resolveImage({ kind: 'asset', filename: 'a.png' });
    await unlink(filePath); await writeFile(filePath, 'REPLACED');
    await assert.rejects(files.openImage(inspected), (error: unknown) => error instanceof AppError && error.statusCode === 409);
    const current = await files.resolveImage({ kind: 'asset', filename: 'a.png' });
    const stream = await files.openImage(current);
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    stream.destroy(); await closed;
    assert.equal(stream.closed, true);
  });
});

test('extensionless PNG screenshots and APNG previews remain readable', async () => {
  await fixture(async ({ files, project }) => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await writeFile(path.join(project, 'render'), png);
    await writeFile(path.join(project, 'animation.apng'), png);
    for (const name of ['render', 'animation.apng']) {
      const inspected = await files.resolveImage({ kind: 'project', projectId: 'p', path: name });
      assert.ok(['image/png', 'image/apng'].includes(inspected.contentType));
      const stream = await files.openImage(inspected);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), png);
    }
  });
});
