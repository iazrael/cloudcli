import { readFile } from 'node:fs/promises';

import { createCliInstallationProbe } from '@/modules/providers/shared/installation/cli-installation-probe.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus, ProviderQuotaData } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getOpenCodeAuthPath } from './opencode-data-root.js';
import { fetchOpenCodeQuota } from './opencode-quota.provider.js';

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

const installationProbe = createCliInstallationProbe({ command: () => 'opencode' });

export class OpenCodeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the OpenCode CLI is available to the server process.
   */
  private checkInstalled(): Promise<boolean> {
    return installationProbe.isInstalled();
  }

  /**
   * Returns OpenCode CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = await this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'opencode',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads OpenCode's auth store or falls back to provider API key environment variables.
   */
  private async checkCredentials(): Promise<OpenCodeCredentialsStatus> {
    try {
      const content = await readFile(getOpenCodeAuthPath(), 'utf8');
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
   * Retrieves OpenCode Go subscription usage (5-hour, weekly and monthly
   * limits). Resolves to null for Zen-only installs, which have no usage
   * endpoint.
   *
   * Consumer: the provider token-usage service (GET /providers/quota).
   */
  async getQuota(options?: { forceRefresh?: boolean }): Promise<ProviderQuotaData | null> {
    return fetchOpenCodeQuota(options);
  }
}
