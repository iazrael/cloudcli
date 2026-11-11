import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hasKeychainItem } from '@/modules/providers/shared/credentials/macos-keychain.js';
import { createCliInstallationProbe } from '@/modules/providers/shared/installation/cli-installation-probe.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe } from '@/shared/types.js';
import type {
  ProviderAuthStatus,
  ProviderAuthSubscriptionOverride,
  ProviderQuotaData,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
} from '@/shared/types.js';
import {
  probeCliVersion, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { consumeClaudeQuotaReset, fetchClaudeQuota } from './claude-quota.provider.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

/**
 * An API-key style credential found in the env or settings.json, plus the
 * user-facing label the settings UI has always shown for it. The labels are
 * kept verbatim so existing consumers of `email` see no change.
 */
type ClaudeApiKeyCredential = Pick<ProviderAuthSubscriptionOverride, 'variable' | 'source'> & {
  label: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

/**
 * The macOS login keychain item Claude Code stores its account credential in.
 * Account attributes differ across installations, so the presence probe matches only the service.
 */
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Injectable collaborators. Only tests pass these: a real macOS machine that
 * is logged in would otherwise make every "not authenticated" fixture pass.
 */
type ClaudeProviderAuthDeps = {
  hasKeychainCredentials?: () => boolean;
};

const installationProbe = createCliInstallationProbe({
  command: () => resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude',
});

export class ClaudeProviderAuth implements IProviderAuth {
  private readonly hasKeychainCredentials: () => boolean;

  constructor(deps: ClaudeProviderAuthDeps = {}) {
    this.hasKeychainCredentials = deps.hasKeychainCredentials
      ?? (() => hasKeychainItem({ service: CLAUDE_KEYCHAIN_SERVICE }));
  }

  /**
   * Checks whether the Claude Code CLI that chats run is available on this
   * host, and which version it is.
   */
  checkInstalled(): CliVersionProbe {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    if (!cliPath) {
      // Windows with no resolvable CLI: the SDK falls back to the binary it
      // bundles, so chats still work. Its version is not this CLI's to report.
      return { installed: true, exitCode: null, version: null };
    }
    return probeCliVersion(cliPath);
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        installedVersion: null,
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
      ...(credentials.subscriptionOverride ? { subscriptionOverride: credentials.subscriptionOverride } : {}),
    };
  }

  /**
   * Reads the claude.ai subscription rate-limit windows (5-hour and weekly).
   * Consumer: the provider token-usage service (GET /providers/quota).
   */
  async getQuota(options?: { forceRefresh?: boolean }): Promise<ProviderQuotaData | null> {
    return fetchClaudeQuota(options);
  }

  /**
   * Spends one Claude reset card after the user confirms it in the quota
   * panel. Consumer: providerTokenUsageService.consumeProviderQuotaReset.
   */
  async consumeQuotaReset(
    input: ProviderQuotaResetConsumeInput,
  ): Promise<ProviderQuotaResetConsumeResult> {
    return consumeClaudeQuotaReset(input);
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Finds an API-key style credential in the same order Claude Code checks them:
   * process env first (auth token, then API key), then the settings.json env block.
   */
  private findApiKeyCredential(settingsEnv: Record<string, unknown>): ClaudeApiKeyCredential | null {
    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { variable: 'ANTHROPIC_AUTH_TOKEN', source: 'process_env', label: 'Auth Token' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { variable: 'ANTHROPIC_API_KEY', source: 'process_env', label: 'API Key Auth' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { variable: 'ANTHROPIC_API_KEY', source: 'settings_file', label: 'API Key Auth' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { variable: 'ANTHROPIC_AUTH_TOKEN', source: 'settings_file', label: 'Configured via settings.json' };
    }

    return null;
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const settingsEnv = await this.loadSettingsEnv();

    const apiKey = this.findApiKeyCredential(settingsEnv);
    if (apiKey) {
      const status: ClaudeCredentialsStatus = { authenticated: true, email: apiKey.label, method: 'api_key' };

      // The key wins, but Claude Code says nothing when it does so while a
      // `claude /login` subscription is also signed in — every request is then
      // billed pay-as-you-go to the key (issue #568). Surface the bypassed
      // login so the settings page can warn about it; an expired or missing
      // login is not being bypassed, so it stays silent.
      const subscription = await this.readSubscriptionStatus();
      if (subscription.authenticated) {
        status.subscriptionOverride = {
          variable: apiKey.variable,
          source: apiKey.source,
          subscriptionEmail: subscription.email,
        };
      }

      return status;
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    return this.readSubscriptionStatus();
  }

  /** Adds the local account label to a detected subscription; metadata never proves authentication. */
  private async readSubscriptionStatus(): Promise<ClaudeCredentialsStatus> {
    const status = await this.readCredentialsFile();
    if (!status.authenticated || status.email) {
      return status;
    }

    try {
      const content = await readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
      const config = readObjectRecord(JSON.parse(content));
      const account = readObjectRecord(config?.oauthAccount);
      return { ...status, email: readOptionalString(account?.emailAddress) ?? null };
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        // Do not log file contents or parse-error excerpts: the config may contain secrets.
        console.warn('Unable to read Claude account metadata', {
          reason: error instanceof SyntaxError ? 'invalid_json' : 'read_failed',
        });
      }
      return status;
    }
  }

  /**
   * Reads the `claude /login` OAuth session from ~/.claude/.credentials.json and
   * reports whether it is still usable. Shared by the fallback path (when no
   * env credential exists) and by the API-key path (to detect a bypassed login).
   */
  private async readCredentialsFile(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        // `accessToken` is short-lived (hours). Claude Code renews it silently
        // from `refreshToken` on the next CLI invocation, so an expired access
        // token alongside a live refresh token is still a working login. Before
        // this check, a still-signed-in account read as "login has expired"
        // until something else happened to run the CLI — which is why opening
        // the Shell tab and coming back made Settings flip to Connected.
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const refreshTokenExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        if (refreshToken && (!refreshTokenExpiresAt || Date.now() < refreshTokenExpiresAt)) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return this.keychainFallback({
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        });
      }

      return this.keychainFallback({
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      });
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return this.keychainFallback({
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      });
    }
  }

  /**
   * Last resort before reporting a logged-out account: on macOS, Claude Code
   * keeps the account credential in the login keychain and writes
   * `~/.claude/.credentials.json` only for MCP plugin tokens, so a file with
   * no usable `claudeAiOauth` says nothing about whether the user is signed
   * in. Without this probe the Settings tab reported "not authenticated" for
   * every macOS login while chats kept working, because the chat path
   * authenticates through the CLI/SDK instead of this detection chain.
   *
   * The keychain item is opaque on purpose: reading the secret may raise an
   * authorization dialog. readSubscriptionStatus adds an optional display email
   * from the local account metadata without opening the keychain secret.
   */
  private keychainFallback(fileVerdict: ClaudeCredentialsStatus): ClaudeCredentialsStatus {
    if (this.hasKeychainCredentials()) {
      return { authenticated: true, email: null, method: 'keychain' };
    }
    return fileVerdict;
  }
}
