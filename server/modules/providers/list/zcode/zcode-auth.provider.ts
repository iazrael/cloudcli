import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus, ProviderQuotaData } from '@/shared/types.js';

import { readDecryptedZCodeCredentials } from './zcode-credentials.js';
import { getEngineVersion, tryResolveEnginePath } from './zcode-engine-path.js';
import { fetchZCodeQuota } from './zcode-quota.provider.js';

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
}

