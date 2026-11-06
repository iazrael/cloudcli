import express from 'express';
import type { Response } from 'express';

import {
  MANUAL_MAX_SCROLL_DELTA,
  MANUAL_TYPE_MAX_LENGTH,
  browserUseService,
  isManualKeyAllowed,
  normalizeManualUrl,
} from '@/modules/browser-use/browser-use.service.js';

/**
 * Stable machine-readable error codes for the browser-use API.
 *
 * The server always replies with the structured envelope used by AppError
 * (`{ success: false, error: { code, message, details } }`). Clients map
 * `code` to localized copy; `message` is an English fallback and `details`
 * may carry the underlying error text for diagnostics.
 */
export const BROWSER_USE_ERROR_CODES = {
  STATUS_LOAD_FAILED: 'BROWSER_USE_STATUS_LOAD_FAILED',
  SETTINGS_LOAD_FAILED: 'BROWSER_USE_SETTINGS_LOAD_FAILED',
  SETTINGS_SAVE_FAILED: 'BROWSER_USE_SETTINGS_SAVE_FAILED',
  RUNTIME_INSTALL_FAILED: 'BROWSER_USE_RUNTIME_INSTALL_FAILED',
  SESSIONS_LOAD_FAILED: 'BROWSER_USE_SESSIONS_LOAD_FAILED',
  SESSION_CREATE_FAILED: 'BROWSER_USE_SESSION_CREATE_FAILED',
  SESSION_CONTROL_FAILED: 'BROWSER_USE_SESSION_CONTROL_FAILED',
  SESSION_SCREEN_LOAD_FAILED: 'BROWSER_USE_SESSION_SCREEN_LOAD_FAILED',
  SESSION_STOP_FAILED: 'BROWSER_USE_SESSION_STOP_FAILED',
  SESSION_DELETE_FAILED: 'BROWSER_USE_SESSION_DELETE_FAILED',
} as const;

function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details,
    },
  });
}

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function readBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorDetails(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/** Service surface consumed by the browser-use HTTP routes; the real implementation is browserUseService. */
export type BrowserUseRouterService = typeof browserUseService;

/**
 * Builds the full browser-use HTTP router against an injected service so tests
 * can drive the real routes with a fake. The default export binds the
 * production singleton and is mounted by server/index.ts behind
 * `authenticateToken`.
 */
export function createBrowserUseRouter(service: BrowserUseRouterService): express.Router {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    try {
      res.json({ success: true, data: await service.getStatus() });
    } catch (error) {
      sendError(
        res,
        500,
        BROWSER_USE_ERROR_CODES.STATUS_LOAD_FAILED,
        'Failed to load Browser status.',
        errorDetails(error),
      );
    }
  });

  router.get('/settings', async (_req, res) => {
    try {
      res.json({ success: true, data: { settings: await service.getSettings() } });
    } catch (error) {
      sendError(
        res,
        500,
        BROWSER_USE_ERROR_CODES.SETTINGS_LOAD_FAILED,
        'Failed to load Browser settings.',
        errorDetails(error),
      );
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const settings = await service.updateSettings(req.body || {});
      res.json({ success: true, data: { settings } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SETTINGS_SAVE_FAILED,
        'Failed to save Browser settings.',
        errorDetails(error),
      );
    }
  });

  router.post('/runtime/install', async (_req, res) => {
    try {
      const result = await service.installRuntime();
      if (result.success) {
        res.json({ success: true, data: result });
        return;
      }
      sendError(
        res,
        500,
        BROWSER_USE_ERROR_CODES.RUNTIME_INSTALL_FAILED,
        'Failed to install Browser runtime.',
        result.message,
      );
    } catch (error) {
      sendError(
        res,
        500,
        BROWSER_USE_ERROR_CODES.RUNTIME_INSTALL_FAILED,
        'Failed to install Browser runtime.',
        errorDetails(error),
      );
    }
  });

  router.get('/sessions', async (_req, res) => {
    try {
      res.json({ success: true, data: { sessions: await service.listSessions() } });
    } catch (error) {
      sendError(
        res,
        401,
        BROWSER_USE_ERROR_CODES.SESSIONS_LOAD_FAILED,
        'Failed to list browser sessions.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions', async (_req, res) => {
    try {
      const session = await service.createManualSession();
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CREATE_FAILED,
        'Failed to create browser session.',
        errorDetails(error),
      );
    }
  });

  router.get('/sessions/:sessionId/screen', async (req, res) => {
    try {
      const session = await service.getManualScreen(readParam(req.params.sessionId));
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        500,
        BROWSER_USE_ERROR_CODES.SESSION_SCREEN_LOAD_FAILED,
        'Failed to load the browser screen.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/navigate', async (req, res) => {
    try {
      const url = normalizeManualUrl(String(readBody(req.body).url ?? ''));
      const session = await service.manualNavigate(readParam(req.params.sessionId), url);
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CONTROL_FAILED,
        'Failed to control the browser session.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/nav', async (req, res) => {
    try {
      const action = readBody(req.body).action;
      if (action !== 'back' && action !== 'forward' && action !== 'reload') {
        throw new Error('Unknown navigation action.');
      }

      const session = await service.manualNav(readParam(req.params.sessionId), action);
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CONTROL_FAILED,
        'Failed to control the browser session.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/click', async (req, res) => {
    try {
      const body = readBody(req.body);
      const x = readNumber(body.x);
      const y = readNumber(body.y);
      if (x === null || y === null) {
        throw new Error('Click coordinates must be numbers.');
      }

      const session = await service.manualClick(readParam(req.params.sessionId), { x, y });
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CONTROL_FAILED,
        'Failed to control the browser session.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/scroll', async (req, res) => {
    try {
      const body = readBody(req.body);
      const deltaX = readNumber(body.deltaX);
      const deltaY = readNumber(body.deltaY);
      if (deltaX === null || deltaY === null
        || Math.abs(deltaX) > MANUAL_MAX_SCROLL_DELTA
        || Math.abs(deltaY) > MANUAL_MAX_SCROLL_DELTA) {
        throw new Error(`Scroll deltas must be finite and within ±${MANUAL_MAX_SCROLL_DELTA}.`);
      }

      const session = await service.manualScroll(readParam(req.params.sessionId), { deltaX, deltaY });
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CONTROL_FAILED,
        'Failed to control the browser session.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/type', async (req, res) => {
    try {
      const text = readBody(req.body).text;
      if (typeof text !== 'string' || text.length === 0 || text.length > MANUAL_TYPE_MAX_LENGTH) {
        throw new Error(`Text must be a non-empty string of at most ${MANUAL_TYPE_MAX_LENGTH} characters.`);
      }

      const session = await service.manualType(readParam(req.params.sessionId), text);
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CONTROL_FAILED,
        'Failed to control the browser session.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/key', async (req, res) => {
    try {
      const key = readBody(req.body).key;
      if (typeof key !== 'string' || !isManualKeyAllowed(key)) {
        throw new Error('Key is not allowed for remote control.');
      }

      const session = await service.manualPressKey(readParam(req.params.sessionId), key);
      res.json({ success: true, data: { session } });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_CONTROL_FAILED,
        'Failed to control the browser session.',
        errorDetails(error),
      );
    }
  });

  router.post('/sessions/:sessionId/stop', async (req, res) => {
    try {
      const result = await service.stopSession(readParam(req.params.sessionId));
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_STOP_FAILED,
        'Failed to stop browser session.',
        errorDetails(error),
      );
    }
  });

  router.delete('/sessions/:sessionId', async (req, res) => {
    try {
      const result = await service.deleteSession(readParam(req.params.sessionId));
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(
        res,
        400,
        BROWSER_USE_ERROR_CODES.SESSION_DELETE_FAILED,
        'Failed to delete browser session.',
        errorDetails(error),
      );
    }
  });

  return router;
}

export default createBrowserUseRouter(browserUseService);
