import express from 'express';

import { scheduledJobsAgentService } from '@/modules/scheduled-jobs/services/scheduled-jobs-agent.service.js';
import { scheduledJobsSettingsService } from '@/modules/scheduled-jobs/services/scheduled-jobs-settings.service.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

router.use((req, res, next) => {
  const expected = scheduledJobsSettingsService.getMcpToken();
  const token = readBearerToken(req.headers.authorization)
    || String(req.headers['x-scheduled-jobs-mcp-token'] || '');
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid Scheduled Tasks MCP token.' });
    return;
  }
  if (!scheduledJobsSettingsService.isEnabled()) {
    res.status(403).json({ success: false, error: 'Scheduled tasks are disabled in CloudCLI settings.' });
    return;
  }
  next();
});

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const result = await scheduledJobsAgentService.executeTool(req.params.toolName, input);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Scheduled tasks MCP tool failed.',
    });
  }
});

export default router;
