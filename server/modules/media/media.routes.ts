import { pipeline } from 'node:stream/promises';

import express from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import type { createImageMediaService } from '@/modules/media/image-media.service.js';
import { errorStatusCode } from '@/shared/utils.js';

const text = z.string().min(1).max(8192).refine((value) => !value.includes('\0'));
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ id: text, kind: z.literal('asset'), filename: text, projectId: text.optional(), fallbackPath: text.optional() }).strict(),
  z.object({ id: text, kind: z.literal('project'), projectId: text, path: text }).strict(),
  z.object({ id: text, kind: z.literal('external'), path: text, projectId: text.optional(), projectFallback: z.boolean().optional() }).strict(),
]);
const batchSchema = z.object({ images: z.array(sourceSchema).min(1).max(50) }).strict()
  .refine(({ images }) => new Set(images.map(({ id }) => id)).size === images.length);

/** 供媒体装配使用；只有图片读取路由置于 API key 中间件前，签发仍走普通鉴权。 */
export function createMediaRouter(service: ReturnType<typeof createImageMediaService>, authenticate: RequestHandler) {
  const images = express.Router();
  const signing = express.Router();
  const fail = (error: unknown, response: express.Response) => {
    const status = errorStatusCode(error);
    if (response.headersSent) { response.destroy(); return; }
    response.setHeader('Cache-Control', 'no-store');
    if (status >= 500) console.error('[Media] Request failed', error instanceof Error ? error.name : 'Unknown error');
    if (response.headersSent) { response.destroy(); return; }
    response.status(status).json({ error: status >= 500 ? 'Image request failed' : 'Image is unavailable' });
  };
  signing.post('/image-urls', authenticate, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid image batch' }); return; }
    const authenticated = request as typeof request & { user?: { id?: string | number }; authExpiresAt?: number };
    if (authenticated.user?.id === undefined) { response.sendStatus(401); return; }
    try {
      response.json({ images: await service.issueBatch(String(authenticated.user.id), parsed.data.images, authenticated.authExpiresAt) });
    } catch (error) { fail(error, response); }
  });
  images.get('/images', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (typeof request.query.ticket !== 'string' || request.query.ticket.length > 32_768) { response.sendStatus(403); return; }
    try {
      const file = await service.read(request.query.ticket);
      response.setHeader('Content-Type', file.contentType);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      response.setHeader('Referrer-Policy', 'no-referrer');
      // 附件也能经文件编辑修改，因此所有图片都使用缓存再验证。
      response.setHeader('Cache-Control', 'private, no-cache');
      response.setHeader('ETag', file.etag);
      if (request.fresh) { response.status(304).end(); return; }
      // 打开文件时再次核对身份，避免检查与打开之间目标被替换。
      const stream = await file.open();
      response.setHeader('Content-Length', file.size);
      await pipeline(stream, response);
    } catch (error) { fail(error, response); }
  });
  return { images, signing };
}
