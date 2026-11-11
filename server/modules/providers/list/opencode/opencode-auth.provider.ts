import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath } from '@/modules/providers/list/opencode/opencode-data-root.js';
import { tryResolveOpenCodeEnginePath } from '@/modules/providers/list/opencode/opencode-engine-path.js';
import { fetchOpenCodeQuota } from '@/modules/providers/list/opencode/opencode-quota.provider.js';
import { createCliInstallationProbe } from '@/modules/providers/shared/installation/cli-installation-probe.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type {
  CliVersionProbe, ProviderAuthStatus, ProviderQuotaData } from '@/shared/types.js';
import {
  probeCliVersion, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type OpenCodeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

// The override is read per probe (tests swap it between cases); otherwise the
// shared resolver finds the binary even when PATH lacks the install location.
const installationProbe = createCliInstallationProbe({
  command: () => process.env.CLOUDCLI_OPENCODE_CLI?.trim() || tryResolveOpenCodeEnginePath() || 'opencode',
});

export class OpenCodeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the OpenCode CLI is available to the server process, and
   * which version it is. Unlike the other CLIs it has always needed a clean
   * `--version` exit to count as installed.
   */
  checkInstalled(): CliVersionProbe {
    const probe = probeCliVersion('opencode');
    return { ...probe, installed: probe.exitCode === 0 };
  }

  /**
   * Returns OpenCode CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'opencode',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads the signed-in workspace's OpenCode Go plan usage meters (5-hour,
   * weekly, monthly). Consumer: the provider token-usage service
   * (GET /providers/quota).
   */
  async getQuota(options?: { forceRefresh?: boolean }): Promise<ProviderQuotaData | null> {
    return fetchOpenCodeQuota(options);
  }

  /**
   * Reads OpenCode's credential store. OpenCode v2 keeps credentials in the
   * `credential` table of its shared SQLite database and no longer writes the
   * v1-era auth.json, so the database is checked first; auth.json and the
   * provider API key environment variables remain as fallbacks for older CLI
   * layouts.
   */
  private async checkCredentials(): Promise<OpenCodeCredentialsStatus> {
    const databaseCredential = this.readActiveDatabaseCredential();
    if (databaseCredential) {
      return {
        authenticated: true,
        email: databaseCredential,
        method: 'credentials_db',
      };
    }

    try {
      const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      for (const [providerId, providerAuth] of Object.entries(auth)) {
        const providerRecord = readObjectRecord(providerAuth);
        if (!providerRecord) {
          continue;
        }

        const hasCredential = Object.values(providerRecord).some(
          (value) => readOptionalString(value) !== undefined || Boolean(readObjectRecord(value)),
        );
        if (hasCredential) {
          return {
            authenticated: true,
            email: `${providerId} credentials`,
            method: 'credentials_file',
          };
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : 'Failed to read OpenCode auth',
        };
      }
    }

    const envCredential = OPENCODE_ENV_CREDENTIAL_KEYS.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'OpenCode not configured',
    };
  }

  /**
   * Returns the label of the most recently updated active credential row, or
   * null when the database is absent, unreadable, or has no active row. A
   * read-only connection never blocks against the CLI's WAL writes, and a
   * database without the credential table (older v2 layouts) just means "no
   * database credential" rather than an error.
   */
  private readActiveDatabaseCredential(): string | null {
    let db: Database.Database;
    try {
      db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }

    try {
      const row = db.prepare(
        'SELECT label FROM credential WHERE active = 1 ORDER BY time_updated DESC, time_created DESC LIMIT 1',
      ).get() as { label?: string } | undefined;
      return row?.label?.trim() || null;
    } catch {
      return null;
    } finally {
      db.close();
    }
  }
}
