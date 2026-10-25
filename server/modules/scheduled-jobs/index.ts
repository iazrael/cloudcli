// The HTTP surface for recurring scheduled jobs, mounted by the app.
export { default as scheduledJobsRoutes } from './scheduled-jobs.routes.js';

// The token-authenticated endpoint the managed MCP bridge forwards tool calls
// to; mounted by the app next to the browser-use MCP endpoint.
export { default as scheduledJobsMcpRoutes } from './scheduled-jobs-mcp.routes.js';

// The timer that fires them, started and stopped with the server.
export {
  initializeScheduledJobDispatcher,
  closeScheduledJobDispatcher,
} from './services/scheduled-job-dispatcher.service.js';

// scheduledJobsSettingsService: used by the server entrypoint to reconcile the
// managed MCP registration on startup.
export { scheduledJobsSettingsService } from './services/scheduled-jobs-settings.service.js';

/**
 * Lazily starts the Scheduled Tasks MCP stdio entrypoint. Keeping this import
 * lazy ensures the entrypoint loads environment configuration before its
 * runtime is evaluated.
 */
export async function startScheduledJobsMcp(): Promise<void> {
  await import('./scheduled-jobs-mcp.js');
}
