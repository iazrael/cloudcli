import os from 'node:os';

import { query, type ModelInfo, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  AppError,
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  readOptionalString,
  readJsonlRecords,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

const ADJUSTABLE_EFFORT = {
  default: 'high',
  values: [
    { value: 'low' },
    { value: 'medium' },
    { value: 'high' },
    { value: 'xhigh' },
    { value: 'max' },
    ULTRACODE_EFFORT_OPTION,
  ],
};

/**
 * The runtime's effort check falls back to this list when the installed Claude Code cannot
 * be asked for its model list; the picker never shows it. It mirrors the CLI's `/model`
 * picker, which no longer lists separate 1M-context variants.
 */
export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: ADJUSTABLE_EFFORT,
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: ADJUSTABLE_EFFORT,
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: ADJUSTABLE_EFFORT,
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: ADJUSTABLE_EFFORT,
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
  ],
  DEFAULT: 'default',
};

const invalidCatalog = () => new AppError('Claude Code returned an invalid or empty model list.', {
  code: 'CLAUDE_MODEL_CATALOG_INVALID', statusCode: 502,
});

/** Claude Code 2.1.303 also reports the concrete model each entry runs; the SDK types predate it. */
export type ClaudeCliModel = ModelInfo & { resolvedModel?: string };

/**
 * A pinned version id (`claude-opus-4-8`) resolves to itself; a picker entry is an alias
 * (`opus` -> `claude-opus-5-5`) or carries a suffix (`claude-fable-5-1[1m]`).
 */
const isPinnedVersion = (model: ClaudeCliModel): boolean => model.resolvedModel === model.value;

/**
 * Turns the CLI's model list into the picker catalog, keeping its order and wording. The CLI
 * may append every pinned version after its `/model` entries; those are dropped so the picker
 * matches the CLI's own, and a pinned id stays reachable as a custom model.
 */
export const buildClaudeModelsDefinition = (models: ClaudeCliModel[]): ProviderModelsDefinition => {
  const pickerModels = models.filter((model) => !isPinnedVersion(model));
  const options = new Map<string, ProviderModelOption>();
  for (const model of pickerModels.length ? pickerModels : models) {
    const value = readOptionalString(model.value);
    const label = readOptionalString(model.displayName);
    if (!value || !label) throw invalidCatalog();
    const levels = model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [];
    const values = levels.map((level) => ({ value: level as string }));
    if (levels.includes('xhigh')) values.push(ULTRACODE_EFFORT_OPTION);
    const description = readOptionalString(model.description);
    if (options.has(value)) continue;
    options.set(value, {
      value, label,
      ...(description ? { description } : {}),
      ...(values.length
        ? { effort: { ...(levels.includes('high') ? { default: 'high' } : {}), values } }
        : {}),
    });
  }
  const first = options.values().next().value;
  if (!first) throw invalidCatalog();
  return { OPTIONS: [...options.values()], DEFAULT: options.has('default') ? 'default' : first.value };
};

const MODEL_LIST_TIMEOUT_MS = 20_000;

type ClaudeModelQuery = (params: Parameters<typeof query>[0]) => Pick<ReturnType<typeof query>, 'supportedModels' | 'close'>;

/**
 * Asks the same Claude Code binary conversations run on for its model list. The prompt
 * stream never yields, so no turn starts and Claude Code writes no session transcript;
 * the process is closed as soon as the initialize handshake has answered. Measured on
 * 2.1.303: without `disableAllHooks` the user's SessionStart hooks run, and without
 * `strictMcpConfig` every configured and plugin MCP server is launched.
 */
export const fetchClaudeCliModels = async (
  createQuery: ClaudeModelQuery = query,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<ClaudeCliModel[]> => {
  let releasePrompt = () => {};
  const idlePrompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        releasePrompt = () => resolve({ done: true, value: undefined });
      }),
    }),
  };
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const instance = createQuery({
    prompt: idlePrompt,
    options: {
      cwd: os.tmpdir(),
      env: { ...process.env },
      // Without user settings the CLI lists every model id instead of the `/model` picker.
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      mcpServers: {},
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      instance.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Claude Code did not list its models within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    instance.close();
    releasePrompt();
  }
};

type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  let latest: ProviderCurrentActiveModel | null = null;
  // A long session's transcript can be hundreds of megabytes; stream it and
  // keep only the last match instead of building the whole file string.
  for await (const event of readJsonlRecords(jsonlPath)) {
    const model = extractClaudeEventModel(event as ClaudeInitEvent, sessionId);
    if (model) {
      latest = { model };
    }
  }
  return latest;
};

export class ClaudeProviderModels implements IProviderModels {
  private cachedModels: ProviderModelsDefinition | null = null;
  private cacheExpiry = 0;
  private pending: Promise<ProviderModelsDefinition> | null = null;
  private lastFailure: unknown = null;

  constructor(private readonly fetchCliModels: () => Promise<ClaudeCliModel[]> = fetchClaudeCliModels) {}

  /**
   * Every send validates its effort against this list, so an expired list is returned at
   * once and refreshed behind it; only the first load waits for the CLI. A failed first
   * load is an error, so the picker offers a retry instead of the built-in guess, which
   * would make the page reset a saved choice the guess does not contain.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (this.cachedModels) {
      if (Date.now() >= this.cacheExpiry && !this.pending) void this.refresh().catch(() => {});
      return this.cachedModels;
    }
    if (this.pending) return this.pending;
    // A CLI that just failed (or hung for the full timeout) is not asked again inside the back-off.
    if (this.lastFailure && Date.now() < this.cacheExpiry) throw this.lastFailure;
    return this.refresh();
  }

  private refresh(): Promise<ProviderModelsDefinition> {
    this.pending = this.fetchCliModels().then((models) => {
      this.cachedModels = buildClaudeModelsDefinition(models);
      this.cacheExpiry = Date.now() + 5 * 60_000;
      this.lastFailure = null;
      return this.cachedModels;
    }).catch((error: unknown) => {
      console.error('[Claude] Model list refresh failed:', error);
      this.cacheExpiry = Date.now() + 30_000;
      this.lastFailure = error;
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Only the default id is read here, so the built-in list stands in when the CLI is unreachable. */
  private async defaultActiveModel(): Promise<ProviderCurrentActiveModel> {
    const models = await this.getSupportedModels().catch(() => CLAUDE_PREDEFINED_MODELS);
    return buildDefaultProviderCurrentActiveModel(models);
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return this.defaultActiveModel();
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return this.defaultActiveModel();
  }
}
