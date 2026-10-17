import { randomUUID } from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Transform } from 'node:stream';

import mime from 'mime-types';
import type multer from 'multer';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';
import { createByteLimitTransform } from '@/shared/utils.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type UploadedAttachmentFile = UploadedImageFile;

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/** Creates the global `~/.cloudcli/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Used by the assets routes for streaming multipart files to the global asset store.
 * `maxBytes` must match Multer's `limits.fileSize` for the route, keeping the
 * stored partial file within the configured cap (see
 * `createByteLimitTransform`). Aborted requests close the writer and remove
 * its partial file before notifying Multer, so failed uploads release the
 * replay slot as well as disk resources.
 */
export function createAttachmentUploadStorage(maxBytes = Number.POSITIVE_INFINITY): multer.StorageEngine {
  return {
    _handleFile(req, file, callback) {
      let output: fsSync.WriteStream | undefined;
      let limitGate: Transform | undefined;
      let filePath: string | undefined;
      let finished = false;

      const fail = (error: Error, notifyMulter = true) => {
        if (finished) return;
        finished = true;
        req.off('aborted', onAbort);
        file.stream.unpipe(limitGate);
        limitGate?.unpipe(output);
        limitGate?.destroy();
        // Destroy without an error: Multer decrements its write counter itself
        // on a source-stream error, and must not decrement it again via callback.
        file.stream.destroy();
        const removePartial = async () => {
          let resolvedError: Error = error;
          if (filePath) {
            try { await fs.unlink(filePath); } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
                resolvedError = new AggregateError([error, cleanupError], 'Upload failed and partial file cleanup failed');
              }
            }
          }
          if (resolvedError !== error) console.error('Error cleaning up failed asset upload:', resolvedError);
          if (notifyMulter) callback(resolvedError);
        };
        if (output && !output.closed) {
          output.once('close', () => { void removePartial(); });
          output.destroy();
        } else {
          void removePartial();
        }
      };
      const onAbort = () => fail(new Error('Upload interrupted'));
      req.once('aborted', onAbort);
      file.stream.once('error', (error) => fail(error, false));

      void ensureImageAssetsDir().then((destination) => {
        if (finished) return;
        if (req.aborted) { onAbort(); return; }
        const filename = `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        filePath = path.join(destination, filename);
        output = fsSync.createWriteStream(filePath);
        output.once('error', fail);
        output.once('finish', () => {
          if (finished) return;
          finished = true;
          req.off('aborted', onAbort);
          callback(null, { destination, filename, path: filePath, size: output!.bytesWritten });
        });
        limitGate = createByteLimitTransform(maxBytes);
        file.stream.pipe(limitGate).pipe(output);
      }, (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    },
    _removeFile(_req, file, callback) {
      // After a size limit Multer can pass a failed file without storage metadata.
      // The failure path already removed its partial file before invoking callback.
      if (!file.path) { callback(null); return; }
      fsSync.unlink(file.path, (error) => callback(error?.code === 'ENOENT' ? null : error));
    },
  };
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Maps multer-stored files to provider-neutral attachment records for the
 * assets route. The shared storage format intentionally matches image records
 * so one uploaded file can move through queueing and provider dispatch.
 */
export function buildStoredAttachmentRecords(files: UploadedAttachmentFile[]): StoredImageAsset[] {
  return buildStoredImageRecords(files);
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.cloudcli/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Resolves a general chat attachment for the assets serving route. It shares
 * the image resolver's strict direct-child containment boundary.
 */
export function resolveAttachmentAssetFile(filename: string): string | null {
  return resolveImageAssetFile(filename);
}

/**
 * Opens one stored chat asset for the assets route without exposing arbitrary
 * filesystem reads. The route translates the lookup status and streams the
 * returned direct-child file to the authenticated client.
 */
export async function openStoredAttachmentAsset(filename: string) {
  const resolved = resolveAttachmentAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  try {
    await fs.access(resolved);
  } catch {
    return { status: 'missing' as const };
  }

  return {
    status: 'found' as const,
    contentType: mime.lookup(resolved) || 'application/octet-stream',
    stream: fsSync.createReadStream(resolved),
  };
}
