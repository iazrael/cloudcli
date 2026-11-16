import { authenticateToken, JWT_SECRET } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';
import { resolveAttachmentAssetFile } from '@/modules/assets/index.js';
import { resolveFileTreeMediaPath } from '@/modules/file-tree/index.js';
import { createMediaTicketService } from '@/modules/media/media-ticket.service.js';
import { createMediaFiles } from '@/modules/media/media-files.service.js';
import { createMediaRouter } from '@/modules/media/media.routes.js';

const files = createMediaFiles({ resolveFilePath: resolveFileTreeMediaPath, resolveAssetPath: resolveAttachmentAssetFile });
const service = createMediaTicketService({
  secret: JWT_SECRET,
  userExists: (id) => Number.isSafeInteger(Number(id)) && Boolean(userDb.getUserById(Number(id))),
  ...files,
});

/** 供服务入口挂载；仅签名票据读取入口不经过通用 API 凭据检查。 */
export const mediaRoutes = createMediaRouter(service, authenticateToken);
