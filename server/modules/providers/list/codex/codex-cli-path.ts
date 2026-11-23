import { createRequire } from 'node:module';
import path from 'node:path';

import { probeCliVersion } from '@/shared/utils.js';

/**
 * Extensions of the Codex npm package's launcher. A JS launcher has to run
 * under `process.execPath`; anything else is a native binary or a PATH command
 * that `spawn` executes directly.
 */
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * How to start one Codex CLI.
 *
 * Consumers: `codex-app-server.client.ts` (chat and one-shot app-server
 * processes), `codex-auth.provider.ts` (the version in the auth status),
 * `codex-quota.provider.ts` (rate-limit reads) and `provider-cli.service.ts`
 * (the settings row's "why is there no update" answer).
 */
export type CodexCliLaunchSpec = {
  /** Executable to spawn: `process.execPath` for a JS launcher, otherwise the CLI itself. */
  command: string;
  /** Arguments that precede the subcommand; the launcher path when `command` is node. */
  prefixArgs: string[];
  /** `override` when `CODEX_CLI_PATH` supplied this CLI, `bundled` for the `@openai/codex` dependency. */
  source: 'override' | 'bundled';
  /** Version without probing again: the override's probed version, or the bundled package's version. */
  version: string | null;
};

/** Resolved once per process: the bundled package cannot change without a restart. */
let bundledSpec: CodexCliLaunchSpec | null | undefined;

/**
 * One entry per `CODEX_CLI_PATH` value. Every app-server open resolves a
 * launch spec, and probing `--version` costs a process start; the entry is
 * keyed by the configured value so a changed variable is resolved afresh.
 */
const overrideSpecs = new Map<string, CodexCliLaunchSpec | null>();

/**
 * Resolves the Codex CLI to run: `CODEX_CLI_PATH` when configured, otherwise
 * the `@openai/codex` build this CloudCLI version was verified against.
 *
 * The override is kept only when it runs and is not older than the bundled
 * package: the app-server protocol this code speaks is verified against that
 * version, so a broken or older CLI falls back to the bundled one with a
 * warning instead of failing halfway through a chat. Returns null when neither
 * is available, which every consumer reports as "Codex is not installed".
 *
 * Primary consumer: `resolveCodexLauncher()` in `codex-app-server.client.ts`;
 * the auth and quota providers and the CLI status service call it too.
 */
export function resolveCodexCliLaunchSpec(env: NodeJS.ProcessEnv = process.env): CodexCliLaunchSpec | null {
  const configured = stripWrappingQuotes((env.CODEX_CLI_PATH ?? '').trim());
  if (!configured) {
    return resolveBundledSpec();
  }

  if (overrideSpecs.has(configured)) {
    return overrideSpecs.get(configured) ?? null;
  }
  const spec = resolveOverrideSpec(configured);
  overrideSpecs.set(configured, spec);
  return spec;
}

/**
 * Whether the CLI actually in use came from `CODEX_CLI_PATH`. False when the
 * variable is unset, empty, or its CLI fell back to the bundled build.
 *
 * Consumer: `provider-cli.service.ts`, which reports `external` instead of
 * `bundled` as the reason no update is offered.
 */
export function isCodexCliOverrideActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCodexCliLaunchSpec(env)?.source === 'override';
}

/**
 * Whether `candidate` is a JS launcher that must run under node rather than be
 * executed directly.
 *
 * Consumer: `openCodexAppServer`, which receives a launcher path from the
 * `codexAppServer.resolveLauncher()` test seam and has to pick the spawn shape.
 */
export function isCodexScriptLauncher(candidate: string): boolean {
  return SCRIPT_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

function resolveOverrideSpec(configured: string): CodexCliLaunchSpec | null {
  const spec = buildOverrideSpec(configured);
  const probe = probeCliVersion(spec.command, [...spec.prefixArgs, '--version']);

  if (!probe.installed || probe.exitCode !== 0) {
    const reason = probe.installed ? `it exited with code ${probe.exitCode}` : 'it could not be started';
    return fallbackToBundled(`${configured} was ignored because ${reason}`);
  }

  if (!probe.version) {
    console.warn(`[Codex] Using ${configured} from CODEX_CLI_PATH without a version check: its --version output is not a version.`);
    return spec;
  }

  const bundledVersion = readBundledVersion();
  if (bundledVersion && isOlderVersion(probe.version, bundledVersion)) {
    return fallbackToBundled(
      `${configured} reports ${probe.version}, older than the bundled ${bundledVersion}`,
    );
  }

  return { ...spec, version: probe.version };
}

function buildOverrideSpec(configured: string): CodexCliLaunchSpec {
  if (isCodexScriptLauncher(configured)) {
    return { command: process.execPath, prefixArgs: [configured], source: 'override', version: null };
  }
  // A bare command name is resolved through PATH by spawn, like the CLIs of
  // the other providers.
  return { command: configured, prefixArgs: [], source: 'override', version: null };
}

function resolveBundledSpec(): CodexCliLaunchSpec | null {
  if (bundledSpec !== undefined) {
    return bundledSpec;
  }
  try {
    const launcherPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    bundledSpec = {
      command: process.execPath,
      prefixArgs: [launcherPath],
      source: 'bundled',
      version: readBundledVersion(),
    };
  } catch {
    bundledSpec = null;
  }
  return bundledSpec;
}

/** The version the repository pins; null when the package is missing or malformed. */
function readBundledVersion(): string | null {
  try {
    const manifest = createRequire(import.meta.url)('@openai/codex/package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function fallbackToBundled(reason: string): CodexCliLaunchSpec | null {
  console.warn(`[Codex] CODEX_CLI_PATH ignored: ${reason}; falling back to the bundled build.`);
  return resolveBundledSpec();
}

/** Ordered `major.minor.patch` comparison; a prerelease suffix is ignored. */
function isOlderVersion(candidate: string, reference: string): boolean {
  const parsedCandidate = parseVersion(candidate);
  const parsedReference = parseVersion(reference);
  if (!parsedCandidate || !parsedReference) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsedCandidate[index] !== parsedReference[index]) {
      return parsedCandidate[index] < parsedReference[index];
    }
  }
  return false;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** An operator-supplied path is often pasted with quotes from a shell or config file. */
function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
