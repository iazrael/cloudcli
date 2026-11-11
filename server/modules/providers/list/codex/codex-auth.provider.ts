import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getCodexHome } from '@/shared/index.js';
import { createCliInstallationProbe } from '@/modules/providers/shared/installation/cli-installation-probe.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type {
  CliVersionProbe, ProviderAuthStatus, ProviderQuotaData, ProviderQuotaResetConsumeInput, ProviderQuotaResetConsumeResult } from '@/shared/types.js';
import {
  probeCliVersion, extractEmailFromJwt, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { consumeCodexQuotaReset, fetchCodexQuota } from './codex-quota.provider.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const installationProbe = createCliInstallationProbe({ command: () => 'codex' });

export class CodexProviderAuth implements IProviderAuth {
  /**
   * Checks whether Codex is available to the server runtime, and which
   * version it is. That is the `@openai/codex` package CloudCLI depends on,
   * which `@openai/codex-sdk` resolves from node_modules, not a `codex` on
   * PATH.
   */
  checkInstalled(): CliVersionProbe {
    let launcherPath: string;
    try {
      launcherPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    } catch {
      return { installed: false, exitCode: null, version: null };
    }
    return probeCliVersion(process.execPath, [launcherPath, '--version']);
  }

  /**
   * Returns Codex SDK availability and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads account-level rolling limits through the Codex app-server protocol.
   * Consumer: the provider token-usage service (GET /providers/quota).
   */
  async getQuota(options?: { forceRefresh?: boolean }): Promise<ProviderQuotaData | null> {
    return fetchCodexQuota(options);
  }

  /**
   * Spends one of the account's banked rate-limit reset credits through the
   * Codex app-server protocol. Consumer: the provider token-usage service
   * (POST /providers/quota/reset).
   */
  async consumeQuotaReset(
    input: ProviderQuotaResetConsumeInput,
  ): Promise<ProviderQuotaResetConsumeResult> {
    return consumeCodexQuotaReset(input);
  }

  /**
   * Reads Codex auth.json and checks OAuth tokens or an API key fallback.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    try {
      const authPath = path.join(getCodexHome(), 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);

      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      if (readOptionalString(auth.OPENAI_API_KEY)) {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid tokens found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Codex not configured' : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    return extractEmailFromJwt(idToken) ?? 'Authenticated';
  }
}

/** Provider registry and automatic title jobs share the existing credential reader. */
export const codexAuth = new CodexProviderAuth();
