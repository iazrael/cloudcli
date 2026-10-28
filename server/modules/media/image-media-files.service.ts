import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { ImageMediaFile, ImageMediaSource } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** 供媒体装配解析并流式读取图片；测试注入路径策略，使用真实文件检查生命周期。 */
export function createImageMediaFiles(dependencies: {
  resolveFilePath: (input: { path: string; projectId?: string; external: boolean }) => Promise<{ path: string; contentType: string }>;
  resolveAssetPath: (filename: string) => string | null;
}) {
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);

  function fileError(statusCode: number): never {
    throw new AppError('Image is unavailable', { statusCode, code: 'IMAGE_UNAVAILABLE' });
  }
  function etag(stats: Stats): string {
    return `W/"${stats.dev}-${stats.ino}-${stats.size}-${stats.mtimeMs}-${stats.ctimeMs}"`;
  }

  async function locate(source: ImageMediaSource): Promise<{ source: ImageMediaSource; path: string; contentType: string }> {
    try {
      if (source.kind === 'asset') {
        const assetPath = dependencies.resolveAssetPath(source.filename);
        if (!assetPath) fileError(403);
        try {
          const [canonical, root] = await Promise.all([realpath(assetPath), realpath(path.dirname(assetPath))]);
          if (path.dirname(canonical) !== root) fileError(403);
          const file = await dependencies.resolveFilePath({ path: canonical, external: true });
          return { ...file, source: { kind: 'asset', filename: path.basename(canonical) } };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !source.projectId || !source.fallbackPath) throw error;
          return locate({ kind: 'project', projectId: source.projectId, path: source.fallbackPath });
        }
      }
      let file;
      try {
        file = await dependencies.resolveFilePath({ path: source.path, projectId: source.projectId, external: source.kind === 'external' });
      } catch (error) {
        if (source.kind !== 'external' || !source.projectFallback || !source.projectId || !(error instanceof AppError) || error.statusCode !== 403) throw error;
        return locate({ kind: 'project', projectId: source.projectId, path: source.path });
      }
      return { ...file, source: source.kind === 'project'
        ? { kind: 'project', projectId: source.projectId, path: file.path }
        : { kind: 'external', path: file.path, ...(source.projectId ? { projectId: source.projectId } : {}) } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') fileError(404);
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') fileError(403);
      throw error;
    }
  }

  return {
  async resolveImage(source: ImageMediaSource) {
    const resolved = await locate(source);
    // 无扩展名的工具截图仍可预览；只读文件头，不把完整图片读进内存。
    if (resolved.contentType === 'application/octet-stream') {
      const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(512);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const bytes = header.subarray(0, bytesRead);
        const hex = bytes.subarray(0, 12).toString('hex');
        if (hex.startsWith('89504e470d0a1a0a')) resolved.contentType = 'image/png';
        else if (hex.startsWith('ffd8ff')) resolved.contentType = 'image/jpeg';
        else if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) resolved.contentType = 'image/gif';
        else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') resolved.contentType = 'image/webp';
        else if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.toString('utf8'))) resolved.contentType = 'image/svg+xml';
      } finally { await handle.close(); }
    }
    if (!IMAGE_TYPES.has(resolved.contentType)) fileError(415);
    const metadata = await stat(resolved.path);
    if (!metadata.isFile()) fileError(403);
    return { source: resolved.source, contentType: resolved.contentType, etag: etag(metadata), size: metadata.size };
  },
  async openImage(file: ImageMediaFile) {
    const resolved = await locate(file.source);
    const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || etag(metadata) !== file.etag) fileError(409);
      return handle.createReadStream();
    } catch (error) { await handle.close(); throw error; }
  },
  };
}
