import express from 'express';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate self-update status and execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
): express.Router {
  const router = express.Router();

  router.get('/update/status', async (request, response, next) => {
    try {
      const refresh = request.query.refresh === '1' || request.query.refresh === 'true';
      response.json(await systemUpdateService.getStatus({ refresh }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/update', async (_request, response, next) => {
    try {
      response.status(202).json({ success: true, ...(await systemUpdateService.startUpdate()) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
