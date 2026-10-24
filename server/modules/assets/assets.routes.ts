import express from 'express';
import multer from 'multer';

import {
  buildStoredAttachmentRecords,
  createAttachmentUploadStorage,
  isAllowedImageMimeType,
  openStoredAttachmentAsset,
} from '@/modules/assets/services/image-assets.service.js';
import { createUploadReplayService, UploadReplayCapacityError } from '@/modules/assets/services/upload-replay.service.js';

/** Used by the server entrypoint (via assetsRoutes) to create the authenticated assets HTTP interface. */
export function createAssetsRouter(options: Parameters<typeof createUploadReplayService>[0] = {}) {
  const router = express.Router();
  const replay = createUploadReplayService<ReturnType<typeof buildStoredAttachmentRecords>>(options);

  // Each Multer instance gets a storage bound to its own byte limit: Multer
  // configures Busboy with `fileSize + 1`, so the storage must stop one byte earlier.
  const imageUploadLimit = 5 * 1024 * 1024;
  const attachmentUploadLimit = 10 * 1024 * 1024;

  const upload = multer({
    storage: createAttachmentUploadStorage(imageUploadLimit),
    fileFilter: (req, file, cb) => {
      if (isAllowedImageMimeType(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
      }
    },
    limits: {
      fileSize: imageUploadLimit, // 5MB
      files: 5,
    },
  });

  const attachmentUpload = multer({
    storage: createAttachmentUploadStorage(attachmentUploadLimit),
    limits: {
      fileSize: attachmentUploadLimit, // 10MB
      files: 10,
    },
  });

  // Multer parses multipart transport; the replay service owns upload identity and concurrency.
  function registerUploadRoute(kind: 'images' | 'files', middleware: ReturnType<typeof upload.array>) {
    router.post(`/${kind}`, async (req, res) => {
      const requestId = req.header('X-Upload-Request-Id');
      if (requestId !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
        req.resume();
        res.status(400).json({ error: 'Invalid upload request ID' });
        return;
      }
      const user = (req as typeof req & { user?: { id?: unknown } }).user;
      if (requestId && !((typeof user?.id === 'string' && user.id.length > 0)
        || (typeof user?.id === 'number' && Number.isFinite(user.id)))) {
        req.resume();
        res.status(401).json({ error: 'Authentication required for upload retries' });
        return;
      }

      const storeFiles = () => new Promise<ReturnType<typeof buildStoredAttachmentRecords>>((resolve, reject) => {
        middleware(req, res, (error: unknown) => {
          if (error) { reject(error); return; }
          const files = Array.isArray(req.files) ? req.files : [];
          if (files.length === 0) {
            reject(new Error(kind === 'images' ? 'No image files provided' : 'No files provided'));
            return;
          }
          resolve(buildStoredAttachmentRecords(files));
        });
      });

      try {
        const files = requestId
          ? await replay.run(JSON.stringify([user!.id, kind]), requestId, storeFiles)
          : await storeFiles();
        // Replayed requests skip multipart parsing; drain their body without writing files.
        req.resume();
        res.json({ [kind === 'images' ? 'images' : 'attachments']: files });
      } catch (error) {
        req.resume();
        const message = error instanceof Error ? error.message : 'Upload failed';
        res.status(error instanceof UploadReplayCapacityError ? 503 : 400).json({ error: message });
      }
    });
  }

  registerUploadRoute('images', upload.array('images', 5));
  registerUploadRoute('files', attachmentUpload.array('files', 10));

  /**
   * Serves one stored image asset by filename. Only files directly inside the
   * global assets folder are reachable; traversal attempts resolve to null.
   */
  router.get('/images/:filename', async (req, res) => {
    const asset = await openStoredAttachmentAsset(req.params.filename);
    if (asset.status === 'invalid') {
      return res.status(400).json({ error: 'Invalid asset filename' });
    }
    if (asset.status === 'missing') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.setHeader('Content-Type', asset.contentType);
    // Stored-XSS hardening: never let the browser sniff a different type, and
    // force SVGs (which can carry scripts when rendered as a document) to
    // download instead of rendering inline. The chat UI is unaffected — it
    // fetches assets as blobs and shows them through <img>, where SVG scripts
    // never execute.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (asset.contentType === 'image/svg+xml') {
      res.setHeader('Content-Disposition', 'attachment');
    }
    asset.stream.pipe(res);
    asset.stream.on('error', (error) => {
      console.error('Error streaming image asset:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading asset' });
      }
    });
  });

  /**
   * Downloads one stored non-image attachment. Content-Disposition prevents
   * uploaded HTML or other active formats from rendering in the application.
   */
  router.get('/files/:filename', async (req, res) => {
    const asset = await openStoredAttachmentAsset(req.params.filename);
    if (asset.status === 'invalid') {
      return res.status(400).json({ error: 'Invalid asset filename' });
    }
    if (asset.status === 'missing') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename.replace(/["\r\n]/g, '_')}"`);
    asset.stream.pipe(res);
    asset.stream.on('error', (error) => {
      console.error('Error streaming attachment asset:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading asset' });
      }
    });
  });

  return router;
}

const assetsRoutes = createAssetsRouter();
export default assetsRoutes;
