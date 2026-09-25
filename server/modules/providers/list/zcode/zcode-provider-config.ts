/**
 * ZCode Provider Config Resolution
 *
 * The ZCode desktop app points its embedded CLI engine at three provider
 * configuration files through environment variables. A bare `app-server`
 * spawn (as CloudCLI does) does not inherit them, so the engine cannot locate
 * its builtin provider catalog and `session/create` hangs until the client
 * times out — no model can be selected at all.
 *
 * This module reconstructs those variables from the resolved engine path and
 * the ZCode storage directory:
 * - `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`: the active builtin catalog. The
 *   engine refreshes a copy under `<storage>/v2/runtime/provider/...` and
 *   falls back to the catalog bundled with the install
 *   (`<resources>/config/provider/zcode-builtin.json`).
 * - `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE`: the install-bundled copy.
 * - `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`: the user's provider overrides
 *   (`<storage>/v2/provider_config.json`), which hold every provider and model
 *   the user added in the ZCode app.
 *
 * Every path is set only when it exists, so an older ZCode install keeps the
 * engine's own resolution behavior.
 *
 * @module zcode-provider-config
 */

import fs from 'node:fs';
import path from 'node:path';

import { getZCodeStorageDir } from './zcode-data-root.js';

/**
 * Engine env override names, exported so the supervisor can strip ambient
 * values inherited from a parent ZCode App session before merging CloudCLI's
 * own resolution (see {@link resolveZCodeProviderConfigEnv}).
 *
 * Consumers: zcode-engine-supervisor.ts and the provider-config tests.
 */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';
export const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE';
export const ZCODE_PERSONAL_PROVIDER_CONFIG_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

/**
 * Path to a provider config file, when it exists on disk.
 */
type ProviderConfigPaths = {
  /** Install-bundled builtin catalog, or null when absent. */
  bundled: string | null;
  /** Storage-refreshed builtin catalog, or null when absent. */
  runtime: string | null;
  /** User provider overrides, or null when absent. */
  personal: string | null;
};

/**
 * Finds the install-bundled builtin catalog from the engine entry path.
 *
 * The engine lives at `<app>/resources/glm/zcode.cjs` (or
 * `<app>/Contents/Resources/glm/zcode.cjs` on macOS), so the catalog sits one
 * directory up under `config/provider`. Exported for the engine-path tests.
 *
 * Consumers: `resolveZCodeProviderConfigEnv` (spawn env) and the models
 * provider (catalog fallback source).
 */
export function findZCodeBundledProviderConfig(enginePath: string): string | null {
  const candidate = path.join(path.dirname(enginePath), '..', 'config', 'provider', 'zcode-builtin.json');
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Finds the newest storage-refreshed builtin catalog.
 *
 * The engine lays them out as
 * `<storage>/v2/runtime/provider/<platform>/<version>/endpoint-<hash>/zcode-builtin.json`;
 * the layout is globbed rather than reconstructed so platform/version naming
 * changes cannot silently break resolution. Exported for the engine-path
 * tests.
 *
 * Consumers: `resolveZCodeProviderConfigEnv` (spawn env) and the models
 * provider (primary catalog source).
 */
export function findZCodeRuntimeProviderConfig(): string | null {
  const runtimeRoot = path.join(getZCodeStorageDir(), 'v2', 'runtime', 'provider');
  let platforms: fs.Dirent[];
  try {
    platforms = fs.readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest: { filePath: string; mtimeMs: number } | null = null;

  for (const platform of platforms) {
    if (!platform.isDirectory()) continue;
    const platformDir = path.join(runtimeRoot, platform.name);
    let versions: fs.Dirent[];
    try {
      versions = fs.readdirSync(platformDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const versionDir = path.join(platformDir, version.name);
      let endpoints: fs.Dirent[];
      try {
        endpoints = fs.readdirSync(versionDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const endpoint of endpoints) {
        if (!endpoint.isDirectory()) continue;
        const filePath = path.join(versionDir, endpoint.name, 'zcode-builtin.json');
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtimeMs)) {
            newest = { filePath, mtimeMs: stat.mtimeMs };
          }
        } catch {
          // Missing catalog under this endpoint; keep scanning.
        }
      }
    }
  }

  return newest?.filePath ?? null;
}

/**
 * Resolves every provider-config path for one engine install.
 *
 * Consumers: `resolveZCodeProviderConfigEnv` and the models provider.
 */
export function resolveZCodeProviderConfigPaths(enginePath: string): ProviderConfigPaths {
  const personalCandidate = path.join(getZCodeStorageDir(), 'v2', 'provider_config.json');
  let personal: string | null = null;
  try {
    personal = fs.statSync(personalCandidate).isFile() ? personalCandidate : null;
  } catch {
    personal = null;
  }

  return {
    bundled: findZCodeBundledProviderConfig(enginePath),
    runtime: findZCodeRuntimeProviderConfig(),
    personal,
  };
}

/**
 * Builds the provider-config environment variables for an engine spawn.
 *
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` prefers the refreshed runtime catalog
 * (what the engine would itself refresh) and falls back to the bundled copy,
 * which is what makes a bare spawn resolve providers at all.
 *
 * Consumers: `zcode-engine-supervisor.ts` (the default spawn wrapper).
 */
export function resolveZCodeProviderConfigEnv(enginePath: string): Record<string, string> {
  const { bundled, runtime, personal } = resolveZCodeProviderConfigPaths(enginePath);
  const env: Record<string, string> = {};

  const activeCatalog = runtime ?? bundled;
  if (activeCatalog) {
    env[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV] = activeCatalog;
  }
  if (bundled) {
    env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_ENV] = bundled;
  }
  if (personal) {
    env[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV] = personal;
  }

  return env;
}
