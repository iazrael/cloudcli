/**
 * ZCode Provider Config Location
 *
 * The embedded CLI locates its built-in provider config by walking five levels
 * up from its own entry file. That assumption holds for ZCode's source layout
 * but not for the packaged app, where `Resources/glm/zcode.cjs` walks up to the
 * filesystem root and the lookup dies with "无法定位 CLI ZCode Built-in Provider
 * Config" before the app-server ever starts.
 *
 * The engine short-circuits that whole derivation when both
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
 * are set, so we resolve the packaged locations ourselves and hand them over.
 *
 * @module zcode-provider-config
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getZCodeStorageDir } from './zcode-data-root.js';

const BUILTIN_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';
const PERSONAL_CONFIG_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

const BUILTIN_CONFIG_FILE = 'zcode-builtin.json';

/**
 * Built-in config locations relative to the engine's own directory, in the
 * engine's own preference order: its co-located `provider/` directory first,
 * then the packaged `Resources/config/` sibling, then the source-layout path
 * the engine itself attempts.
 */
const BUILTIN_RELATIVE_CANDIDATES = [
  path.join('provider', BUILTIN_CONFIG_FILE),
  path.join('..', 'config', 'provider', BUILTIN_CONFIG_FILE),
  path.join('..', '..', '..', '..', '..', 'config', 'provider', BUILTIN_CONFIG_FILE),
];

function findBuiltinConfig(enginePath: string): string | null {
  const engineDir = path.dirname(path.resolve(enginePath));
  for (const relative of BUILTIN_RELATIVE_CANDIDATES) {
    const candidate = path.resolve(engineDir, relative);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Candidate absent; try the next layout.
    }
  }
  return null;
}

/**
 * Resolves the provider-config environment overrides for an engine spawn.
 *
 * Returns an empty record when the caller already set the variables (an
 * explicit override always wins) or when no built-in config can be found —
 * in that case the engine keeps its own resolution and its own error message,
 * rather than being handed a path that does not exist.
 */
export function resolveZCodeProviderConfigEnv(
  enginePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (env[BUILTIN_CONFIG_ENV]?.trim() && env[PERSONAL_CONFIG_ENV]?.trim()) return {};

  const builtinConfig = findBuiltinConfig(enginePath);
  if (!builtinConfig) return {};

  return {
    [BUILTIN_CONFIG_ENV]: env[BUILTIN_CONFIG_ENV]?.trim() || builtinConfig,
    [PERSONAL_CONFIG_ENV]:
      env[PERSONAL_CONFIG_ENV]?.trim() || path.join(getZCodeStorageDir(), 'v2', 'provider_config.json'),
  };
}
