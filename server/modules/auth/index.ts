// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateTokenOrApiKey: used for endpoints accessible via either JWT or API Key.
export { authenticateTokenOrApiKey } from './auth.middleware.js';
// authenticateTokenOrApiKeyWhen: used by the server entrypoint to open only the
// provider model-catalog reads to API keys while the rest of /api/providers stays JWT-only.
export { authenticateTokenOrApiKeyWhen } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';

// 媒体装配从安装级持久密钥派生专用图片票据密钥。
export { JWT_SECRET } from './auth.middleware.js';
