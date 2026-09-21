import express from 'express';
import type { Request, Response } from 'express';

import { scheduledJobsService } from '@/modules/scheduled-jobs/services/scheduled-jobs.service.js';
import { runScheduledJobNow } from '@/modules/scheduled-jobs/services/scheduled-job-dispatcher.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
}

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      scheduledJobsService.list(readUserId(req), {
        projectPath: typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined,
        sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      }),
    ));
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = scheduledJobsService.create({
      userId: readUserId(req),
      name: body.name,
      provider: body.provider,
      projectPath: body.projectPath,
      sessionId: body.sessionId,
      sessionMode: body.sessionMode,
      prompt: body.prompt,
      options: body.options,
      cronExpression: body.cronExpression,
      timezone: body.timezone,
    });
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = scheduledJobsService.update(
      readUserId(req),
      readString(req.params.id, 'id'),
      {
        name: body.name,
        prompt: body.prompt,
        options: body.options,
        cronExpression: body.cronExpression,
        timezone: body.timezone,
        sessionMode: body.sessionMode,
        sessionId: body.sessionId,
        enabled: body.enabled,
      },
    );
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    scheduledJobsService.remove(readUserId(req), readString(req.params.id, 'id'));
    res.json(createApiSuccessResponse({ deleted: true }));
  }),
);

router.post(
  '/:id/run',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await runScheduledJobNow(readUserId(req), readString(req.params.id, 'id'));
    res.status(202).json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/:id/runs',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      scheduledJobsService.listRuns(readUserId(req), readString(req.params.id, 'id')),
    ));
  }),
);

export default router;
