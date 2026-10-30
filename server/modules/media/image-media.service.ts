import { createHmac, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { ImageMediaDependencies, ImageMediaRequest, ImageMediaResult, ImageMediaSource } from '@/shared/types.js';
import { AppError, errorStatusCode } from '@/shared/utils.js';

const ISSUER = 'cloudcli-media';
const AUDIENCE = 'image-read';
const LIFETIME_SECONDS = 600;

function denied(): never {
  throw new AppError('Invalid or expired image ticket', { statusCode: 403, code: 'IMAGE_TICKET_INVALID' });
}

/** 供媒体路由及装配使用，签发单图票据并重新校验图片读取。 */
export function createImageMediaService(dependencies: ImageMediaDependencies) {
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  // 独立密钥保证图片票据不能被登录鉴权当作登录 JWT 接受。
  const key = createHmac('sha256', dependencies.secret).update('cloudcli:image-read:v1').digest();

  return {
    async issueBatch(userId: string, requests: ImageMediaRequest[], authExpiresAt?: number): Promise<ImageMediaResult[]> {
      const issuedAt = now();
      const expiresAt = Math.min(issuedAt + LIFETIME_SECONDS, authExpiresAt ?? Infinity);
      if (expiresAt <= issuedAt || !await dependencies.userExists(userId)) denied();
      // 顺序检查元数据，限制单批申请的磁盘并发。
      const results: ImageMediaResult[] = [];
      for (const { id, ...source } of requests) {
        try {
          const file = await dependencies.resolveImage(source);
          const ticket = jwt.sign({ v: 1, purpose: AUDIENCE, source: file.source, sub: userId, iat: issuedAt, exp: expiresAt }, key, {
            algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, jwtid: randomUUID(),
          });
          results.push({ id, url: `/api/media/images?ticket=${encodeURIComponent(ticket)}`, expiresAt: expiresAt * 1000 });
        } catch (error) {
          const status = errorStatusCode(error);
          if (status >= 500) console.error('[Media] Image inspection failed', error instanceof Error ? error.name : 'Unknown error');
          results.push({ id, status, error: status === 404 ? 'notFound' : status === 403 ? 'forbidden' : status === 415 ? 'decode' : 'failed' });
        }
      }
      return results;
    },

    async read(ticket: string) {
      let claims: { v: number; purpose: string; sub: string; source: ImageMediaSource; exp: number; iat: number };
      try {
        claims = jwt.verify(ticket, key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTimestamp: now() }) as typeof claims;
      } catch { denied(); }
      if (claims.v !== 1 || claims.purpose !== AUDIENCE || typeof claims.sub !== 'string'
        || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp - claims.iat > LIFETIME_SECONDS
        || !await dependencies.userExists(claims.sub)) denied();
      // 字节传输或返回 304 前都重新检查，目录权限和符号链接可能已变化。
      const file = await dependencies.resolveImage(claims.source);
      return { ...file, open: () => dependencies.openImage(file) };
    },
  };
}
