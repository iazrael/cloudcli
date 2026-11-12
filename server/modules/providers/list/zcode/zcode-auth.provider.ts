import type { IProviderAuth } from '@/shared/interfaces.js';
import type {
  CliVersionProbe,
  ProviderAuthStatus,
  ProviderQuotaData,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
} from '@/shared/types.js';

import { readDecryptedZCodeCredentials } from './zcode-credentials.js';
import { getEngineVersion, tryResolveEnginePath } from './zcode-engine-path.js';
import { consumeZCodeQuotaReset, fetchZCodeQuota } from './zcode-quota.provider.js';

/**
 * ZCode authentication provider implementing installation, credential
 * detection, and account quota retrieval.
 */
export class ZCodeProviderAuth implements IProviderAuth {
  /**
   * Returns ZCode installation and authentication status.
   *
   * `installed` mirrors `zcode-engine-path` resolution success, annotated
   * with the detected CLI version; `loginCommand` carries the
   * `node <engine-path> login` guide the frontend login modal should run.
   * Never throws for uninstalled/unauthenticated states per contract.
   */
  /**
   * CLI version card probe (GET /providers/cli/status). The engine resolver
   * already knows installation and version, so no extra subprocess runs here;
   * the eager background probe makes the version null for the first moments
   * after startup.
   *
   * Consumer: provider-cli.service.
   */
  checkInstalled(): CliVersionProbe {
    const enginePath = tryResolveEnginePath();
    if (!enginePath) {
      return { installed: false, exitCode: null, version: null };
    }
    return { installed: true, exitCode: 0, version: getEngineVersion() };
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const enginePath = tryResolveEnginePath();

    if (!enginePath) {
      return {
        installed: false,
        provider: 'zcode',
        authenticated: false,
        email: null,
        method: null,
        error: 'ZCode is not installed. Install the ZCode desktop app from https://z.ai/download first.',
      };
    }

    const credentials = await readDecryptedZCodeCredentials();

    return {
      installed: true,
      provider: 'zcode',
      installedVersion: getEngineVersion(),
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.authenticated
        ? credentials.method
        : getEngineVersion(),
      error: credentials.authenticated ? undefined : credentials.error,
      loginCommand: `node ${enginePath} login`,
    };
  }

  /**
   * Retrieves account-level quota status (5-hour and weekly limits) for ZCode.
   *
   * Consumer: the provider token-usage service (GET /providers/quota).
   */
  async getQuota(options?: { forceRefresh?: boolean }): Promise<ProviderQuotaData | null> {
    return fetchZCodeQuota(options);
  }

  /**
   * Spends one of the account's personal-plan reset cards through the
   * BigModel coding-plan console. Consumer: the provider token-usage service
   * (POST /providers/quota/reset).
   */
  async consumeQuotaReset(
    input: ProviderQuotaResetConsumeInput,
  ): Promise<ProviderQuotaResetConsumeResult> {
    return consumeZCodeQuotaReset(input);
  }
}

