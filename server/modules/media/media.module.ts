import { authenticateToken, JWT_SECRET } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';
import { resolveAttachmentAssetFile } from '@/modules/assets/index.js';
import { resolveFileTreeImagePath } from '@/modules/file-tree/index.js';
import { createImageMediaService } from '@/modules/media/image-media.service.js';
import { createImageMediaFiles } from '@/modules/media/image-media-files.service.js';
import { createMediaRouter } from '@/modules/media/media.routes.js';

const files = createImageMediaFiles({ resolveFilePath: resolveFileTreeImagePath, resolveAssetPath: resolveAttachmentAssetFile });
const service = createImageMediaService({
  secret: JWT_SECRET,
  userExists: (id) => Number.isSafeInteger(Number(id)) && Boolean(userDb.getUserById(Number(id))),
  ...files,
});

/** 供服务入口挂载；仅单图票据读取入口不经过通用 API 凭据检查。 */
export const mediaRoutes = createMediaRouter(service, authenticateToken);
