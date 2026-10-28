// fileTreeRoutes: used by the server entrypoint to mount the complete authenticated File Tree API at `/api/file-tree`.
export { fileTreeRoutes } from '@/modules/file-tree/file-tree.module.js';

// 媒体复用文件浏览的路径策略，不直接依赖模块内部实现。
export { resolveFileTreeImagePath } from '@/modules/file-tree/file-tree.module.js';
