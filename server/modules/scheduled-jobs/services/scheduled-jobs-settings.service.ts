import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { getModuleDirectory } from '@/shared/utils.js';

const __dirname = getModuleDirectory(import.meta.url);

const SETTINGS_KEY = 'scheduled_jobs_settings';
const MCP_TOKEN_KEY = 'scheduled_jobs_mcp_token';

/** The name the managed MCP server is registered under in every engine's config. */
export const SCHEDULED_JOBS_MCP_SERVER_NAME = 'cloudcli-scheduled-tasks';

/**
 * Whether the scheduled-tasks feature is on, and which account the agent
 * bridge acts as.
 *
 * The switch is global (one per install, like the Browser feature): off means
 * no MCP tools, no workspace tab, and the dispatcher stops firing. The owner
 * is the user who enabled it; MCP tool calls have no session of their own, so
 * they manage that account's jobs.
 */
export type ScheduledJobsSettings = {
  enabled: boolean;
  ownerUserId: number | null;
};

/** One provider's outcome from the last managed-MCP registration pass. */
export type ScheduledJobsMcpRegistration = {
  provider: LLMProvider;
  created: boolean;
  error?: string;
};

const DEFAULT_SETTINGS: ScheduledJobsSettings = {
  enabled: false,
  ownerUserId: null,
};

/** The last registration pass's per-provider results, for the settings status card. */
let lastRegistration: ScheduledJobsMcpRegistration[] | null = null;

function readSettings(): ScheduledJobsSettings {
  try {
    const raw = appConfigDb.get(SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<ScheduledJobsSettings>;
    return {
      enabled: parsed.enabled === true,
      ownerUserId: typeof parsed.ownerUserId === 'number' ? parsed.ownerUserId : null,
    };
  } catch (error) {
    console.warn('[ScheduledJobs] Failed to read settings:', error instanceof Error ? error.message : error);
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: ScheduledJobsSettings): ScheduledJobsSettings {
  const normalized: ScheduledJobsSettings = {
    enabled: settings.enabled === true,
    ownerUserId: typeof settings.ownerUserId === 'number' ? settings.ownerUserId : null,
  };

  appConfigDb.set(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(MCP_TOKEN_KEY, token);
  return token;
}

/** The stdio entrypoint, or the CLI subcommand when running from a package install. */
function getMcpCommand(): { command: string; args: string[] } {
  const mcpScriptPath = path.join(__dirname, '..', 'scheduled-jobs-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return {
      command: process.execPath,
      args: [mcpScriptPath],
    };
  }

  return {
    command: 'cloudcli',
    args: ['scheduled-jobs-mcp'],
  };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/scheduled-jobs-mcp`;
}

/**
 * Settings, token, and managed-MCP registration for the agent-facing side of
 * scheduled tasks.
 *
 * Consumed by the settings HTTP routes (toggle + status), the MCP HTTP route
 * (token validation), the dispatcher (enabled gate), and the server entrypoint
 * (startup reconciliation).
 */
export const scheduledJobsSettingsService = {
  getSettings(): ScheduledJobsSettings {
    return readSettings();
  },

  /** True when the feature is on; the dispatcher's poll checks this. */
  isEnabled(): boolean {
    return readSettings().enabled;
  },

  /**
   * Saves the toggle and reconciles the managed MCP registration.
   *
   * `ownerUserId` is recorded when enabling so MCP calls can be attributed to
   * an account; enabling is idempotent, so a re-save also repairs a missing
   * registration on a freshly installed engine.
   */
  async updateSettings(
    input: { enabled?: unknown; ownerUserId?: number },
  ): Promise<ScheduledJobsSettings> {
    const current = readSettings();
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
    const next = writeSettings({
      enabled,
      ownerUserId: typeof input.ownerUserId === 'number' ? input.ownerUserId : current.ownerUserId,
    });

    if (next.enabled) {
      await this.registerAgentMcp();
    } else if (current.enabled) {
      await this.unregisterAgentMcp();
    }

    return next;
  },

  async getStatus() {
    const settings = readSettings();
    return {
      enabled: settings.enabled,
      available: settings.enabled,
      mcpServerName: SCHEDULED_JOBS_MCP_SERVER_NAME,
      providers: lastRegistration,
      message: settings.enabled
        ? 'Scheduled tasks are enabled; agents can manage them over MCP.'
        : 'Scheduled tasks are disabled in settings.',
    };
  },

  /**
   * Registers the managed MCP server with every engine.
   *
   * The per-provider env tells the bridge which engine its calls came from, so
   * an agent-created task defaults to the engine that created it.
   */
  async registerAgentMcp() {
    const { command, args } = getMcpCommand();
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: SCHEDULED_JOBS_MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_SCHEDULED_JOBS_MCP_TOKEN: getOrCreateMcpToken(),
        CLOUDCLI_SCHEDULED_JOBS_API_URL: getMcpApiUrl(),
      },
      envFor: (provider) => ({ CLOUDCLI_SCHEDULED_JOBS_PROVIDER: provider }),
    });
    lastRegistration = results;
    return { name: SCHEDULED_JOBS_MCP_SERVER_NAME, command, args, results };
  },

  async unregisterAgentMcp() {
    const results = await providerMcpService.removeMcpServerFromAllProviders({
      name: SCHEDULED_JOBS_MCP_SERVER_NAME,
      scope: 'user',
    });
    lastRegistration = null;
    return { name: SCHEDULED_JOBS_MCP_SERVER_NAME, results };
  },

  /**
   * Idempotently reconciles the registration on server startup, so engines
   * installed or added after the toggle was flipped still get the bridge.
   */
  async syncAgentMcpIfNeeded() {
    if (!readSettings().enabled) {
      return { synced: false as const, reason: 'disabled' };
    }

    const registration = await this.registerAgentMcp();
    return { synced: true as const, registration };
  },

  getMcpToken(): string {
    return getOrCreateMcpToken();
  },
};
