import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { getOpenCodeDatabasePath } from './opencode-data-root.js';

/**
 * Curated OpenCode catalog shipped as CloudCLI defaults.
 *
 * OpenCode routes by `<providerID>/<modelID>`, so this list mirrors the
 * providers `opencode models --verbose` reports: the OpenCode Zen gateway, the
 * OpenCode Go subscription gateway, and the Anthropic and OpenAI providers
 * OpenCode can address directly with the user's own credentials.
 *
 * For the two OpenCode-owned gateways this table is the offline fallback and
 * the source of curated labels: `readLiveOpenCodeCatalog` overlays OpenCode's
 * own model cache on top so new releases appear without a CloudCLI release.
 */
export const OPENCODE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'opencode/gpt-6-astra',
      label: 'GPT 6 Astra',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    { value: 'opencode/gpt-5.6-sol', label: 'GPT 5.6 Sol', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-terra', label: 'GPT 5.6 Terra', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-luna', label: 'GPT 5.6 Luna', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5', label: 'GPT 5.5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5-pro', label: 'GPT 5.5 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4', label: 'GPT 5.4', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-pro', label: 'GPT 5.4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-mini', label: 'GPT 5.4 Mini', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-nano', label: 'GPT 5.4 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex', label: 'GPT 5.3 Codex', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.2', label: 'GPT 5.2', description: 'OpenCode Zen' },
    {
      value: 'opencode/gpt-5.2-codex',
      label: 'GPT 5.2 Codex',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    { value: 'opencode/gpt-5.1', label: 'GPT 5.1', description: 'OpenCode Zen' },
    {
      value: 'opencode/gpt-5.1-codex',
      label: 'GPT 5.1 Codex',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'opencode/gpt-5.1-codex-max',
      label: 'GPT 5.1 Codex Max',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode/gpt-5.1-codex-mini',
      label: 'GPT 5.1 Codex Mini',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
    { value: 'opencode/gpt-5', label: 'GPT 5', description: 'OpenCode Zen' },
    {
      value: 'opencode/gpt-5-codex',
      label: 'GPT 5 Codex',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
    { value: 'opencode/gpt-5-nano', label: 'GPT 5 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/claude-fable-5', label: 'Claude Fable 5', description: 'OpenCode Zen' },
    {
      value: 'opencode/claude-fable-5-1',
      label: 'Claude Fable 5.1',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    { value: 'opencode/claude-opus-5', label: 'Claude Opus 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-5', label: 'Claude Opus 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4', label: 'Claude Sonnet 4', description: 'OpenCode Zen' },
    { value: 'opencode/claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'OpenCode Zen' },
    {
      value: 'opencode/gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'opencode/gemini-3.7-flash',
      label: 'Gemini 3.7 Flash',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
    { value: 'opencode/gemini-3.6-flash', label: 'Gemini 3.6 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3-flash', label: 'Gemini 3 Flash', description: 'OpenCode Zen' },
    {
      value: 'opencode/grok-4.6',
      label: 'Grok 4.6',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    { value: 'opencode/grok-4.5', label: 'Grok 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/grok-build-0.1', label: 'Grok Build 0.1', description: 'OpenCode Zen' },
    {
      value: 'opencode/muse-spark-1.3',
      label: 'Muse Spark 1.3',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opencode/muse-spark-1.2',
      label: 'Muse Spark 1.2',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    { value: 'opencode/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.5-plus', label: 'Qwen3.5 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'OpenCode Zen' },
    {
      value: 'opencode/deepseek-v4-flash-vision-exp',
      label: 'DeepSeek V4 Flash Vision Exp',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    { value: 'opencode/minimax-m3', label: 'MiniMax M3', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.5', label: 'MiniMax M2.5', description: 'OpenCode Zen' },
    {
      value: 'opencode/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opencode/glm-5.3',
      label: 'GLM 5.3',
      description: 'OpenCode Zen',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    { value: 'opencode/glm-5.2', label: 'GLM 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5', label: 'GLM 5', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.5', label: 'Kimi K2.5', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k3', label: 'Kimi K3', description: 'OpenCode Zen' },
    { value: 'opencode/big-pickle', label: 'Big Pickle', description: 'OpenCode Zen · Free' },
    { value: 'opencode/mimo-v2.5-free', label: 'MiMo-V2.5 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/ling-3.0-flash-fin-free', label: 'Ling 3.0 Flash Fin Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/muse-spark-1.3-contributor-free', label: 'Muse Spark 1.3 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/muse-spark-1.2-contributor-free', label: 'Muse Spark 1.2 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/union-alpha', label: 'Union Alpha Free', description: 'OpenCode Zen · Free' },
    {
      value: 'opencode-go/grok-4.6',
      label: 'Grok 4.6',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'opencode-go/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/glm-5.3',
      label: 'GLM 5.3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/glm-5.2',
      label: 'GLM 5.2',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'high' }, { value: 'max' }],
      },
    },
    { value: 'opencode-go/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Go' },
    {
      value: 'opencode-go/gpt-5.6-luna',
      label: 'GPT 5.6 Luna',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'none' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opencode-go/kimi-k3',
      label: 'Kimi K3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'max' }],
      },
    },
    { value: 'opencode-go/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Go' },
    { value: 'opencode-go/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Go' },
    {
      value: 'opencode-go/longcat-2.0',
      label: 'LongCat 2.0',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    },
    { value: 'opencode-go/mimo-v2.5', label: 'MiMo V2.5', description: 'OpenCode Go' },
    { value: 'opencode-go/mimo-v2.5-pro', label: 'MiMo V2.5 Pro', description: 'OpenCode Go' },
    {
      value: 'opencode-go/minimax-m3',
      label: 'MiniMax M3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'thinking' }],
      },
    },
    { value: 'opencode-go/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Go' },
    {
      value: 'opencode-go/muse-spark-1.3-contributor',
      label: 'Muse Spark 1.3 Contributor',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode-go/muse-spark-1.2-contributor',
      label: 'Muse Spark 1.2 Contributor',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode-go/qwen3.8-max',
      label: 'Qwen3.8 Max',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'opencode-go/qwen3.8-flash',
      label: 'Qwen3.8 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      },
    },
    { value: 'opencode-go/qwen3.7-max', label: 'Qwen3.7 Max', description: 'OpenCode Go' },
    { value: 'opencode-go/qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'OpenCode Go' },
    { value: 'opencode-go/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Go' },
    {
      value: 'opencode-go/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4-flash-vision-exp',
      label: 'DeepSeek V4 Flash Vision Exp',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4.1-flash',
      label: 'DeepSeek V4.1 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/hy4-preview',
      label: 'Hy4 Preview',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'high' }],
      },
    },
    {
      value: 'opencode-go/hy3',
      label: 'Hy3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'low' }, { value: 'high' }],
      },
    },
    { value: 'opencode-go/union-alpha', label: 'Union Alpha Free', description: 'OpenCode Go' },
    { value: 'anthropic/claude-opus-5', label: 'Claude Opus 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-5-fast', label: 'Claude Opus 5 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-fable-5', label: 'Claude Fable 5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8-fast', label: 'Claude Opus 4.8 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7-fast', label: 'Claude Opus 4.7 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5-20251101', label: 'Claude Opus 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Anthropic' },
    { value: 'openai/gpt-5.6', label: 'GPT-5.6', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-fast', label: 'GPT-5.6 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-pro', label: 'GPT-5.6 Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-pro', label: 'GPT-5.6 Sol Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-fast', label: 'GPT-5.6 Terra Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-pro', label: 'GPT-5.6 Terra Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-fast', label: 'GPT-5.6 Luna Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-pro', label: 'GPT-5.6 Luna Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.5', label: 'GPT-5.5', description: 'OpenAI' },
    { value: 'openai/gpt-5.5-fast', label: 'GPT-5.5 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-fast', label: 'GPT-5.4 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini-fast', label: 'GPT-5.4 mini Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'OpenAI' },
  ],
  DEFAULT: 'opencode/gpt-5.6-terra',
};

/** Global OpenCode config files, in the order the CLI loads them. */
const OPENCODE_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'];

/** Provider API keys OpenCode reads straight from the environment. */
const OPENCODE_ENV_PROVIDER_IDS: Record<string, string> = {
  OPENCODE_API_KEY: 'opencode',
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
};

const readOpenCodeJsonFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    return readObjectRecord(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    // Missing, unreadable, or comment-bearing (.jsonc) files simply contribute
    // nothing; the auth store is the authoritative source below.
    return null;
  }
};

/**
 * Lists the upstream providers this OpenCode install can actually route to.
 *
 * OpenCode resolves `<providerID>/<modelID>` against the providers the user has
 * connected, and rejects anything else outright - `Model
 * opencode/claude-sonnet-4-6 is not valid` is what a run gets for asking for an
 * OpenCode Zen model on a machine that only has an Anthropic key. The curated
 * catalog spans every provider OpenCode can address, so it has to be narrowed
 * to this machine's providers before it reaches the model picker.
 *
 * Returns null when nothing can be read, so the caller keeps the full catalog
 * rather than leaving the picker empty. Providers declared only in a
 * project-level `opencode.json` are not visible here; the null fallback and the
 * env-key sweep keep those installs on the full list.
 */
const readConnectedOpenCodeProviderIds = async (): Promise<Set<string> | null> => {
  const providerIds = new Set<string>();
  const configDir = path.join(os.homedir(), '.config', 'opencode');

  const auth = await readOpenCodeJsonFile(
    path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
  );
  for (const [providerId, credential] of Object.entries(auth ?? {})) {
    if (readObjectRecord(credential)) {
      providerIds.add(providerId);
    }
  }

  for (const configFile of OPENCODE_CONFIG_FILES) {
    const config = await readOpenCodeJsonFile(path.join(configDir, configFile));
    for (const providerId of Object.keys(readObjectRecord(config?.provider) ?? {})) {
      providerIds.add(providerId);
    }
  }

  for (const [envKey, providerId] of Object.entries(OPENCODE_ENV_PROVIDER_IDS)) {
    if (readOptionalString(process.env[envKey])) {
      providerIds.add(providerId);
    }
  }

  return providerIds.size > 0 ? providerIds : null;
};

/**
 * Narrows the curated catalog to the providers OpenCode can route to.
 *
 * The default has to move with the list: leaving it on an OpenCode Zen model
 * would hand every new session a model the CLI refuses to run.
 */
const filterOpenCodeModelsByProvider = (
  definition: ProviderModelsDefinition,
  connectedProviderIds: Set<string> | null,
): ProviderModelsDefinition => {
  if (!connectedProviderIds) {
    return definition;
  }

  const options = definition.OPTIONS.filter(
    (option) => connectedProviderIds.has(option.value.split('/')[0]),
  );
  if (options.length === 0) {
    return definition;
  }

  return {
    ...definition,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === definition.DEFAULT)
      ? definition.DEFAULT
      : options[0].value,
  };
};

/**
 * One live model entry read from OpenCode's own model catalog cache.
 */
type OpenCodeLiveModel = {
  name: string;
  /** models.dev status flag: only `active` models are still routable. */
  active: boolean;
  /** Effort tiers the runtime accepts, or null when the model has none. */
  effortValues: string[] | null;
};

/** provider id -> model id -> narrowed live model. */
type OpenCodeLiveCatalog = Map<string, Map<string, OpenCodeLiveModel>>;

/** Only OpenCode's own gateways are refreshed from the live cache. */
const LIVE_CATALOG_PROVIDER_IDS = ['opencode', 'opencode-go'] as const;

/** Narrows one models.dev model entry to the display fields the picker consumes. */
const readLiveModel = (model: Record<string, unknown>, modelId: string): OpenCodeLiveModel => {
  let effortValues: string[] | null = null;
  const reasoningOptions = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  for (const option of reasoningOptions) {
    const record = readObjectRecord(option);
    if (!record || record.type !== 'effort' || !Array.isArray(record.values)) {
      continue;
    }
    const values = record.values.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (values.length > 0) {
      effortValues = values;
      break;
    }
  }

  return {
    name: readOptionalString(model.name) ?? modelId,
    active: (readOptionalString(model.status) ?? 'active') === 'active',
    effortValues,
  };
};

/**
 * Memoized reader for OpenCode's own catalog cache.
 *
 * OpenCode refreshes `~/.cache/opencode/models.json` whenever it rebuilds its
 * model registry, so the file already tracks models CloudCLI has not shipped
 * yet. The memo key includes the file identity (path, mtime, size) so a cache
 * refresh is picked up without re-parsing the multi-megabyte file on every
 * picker open.
 */
let liveCatalogMemo: { key: string; catalog: OpenCodeLiveCatalog } | null = null;

/**
 * Reads OpenCode's own catalog cache, narrowed to the two OpenCode gateways.
 *
 * Returns null when the cache is missing, malformed, or carries no data for
 * those providers, so the curated catalog stays authoritative. Supplies
 * `OpenCodeProviderModels.getSupportedModels`.
 */
const readLiveOpenCodeCatalog = async (): Promise<OpenCodeLiveCatalog | null> => {
  const filePath = path.join(os.homedir(), '.cache', 'opencode', 'models.json');

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }

  const cacheKey = `${filePath}:${fileStat.mtimeMs}:${fileStat.size}`;
  if (liveCatalogMemo?.key === cacheKey) {
    return liveCatalogMemo.catalog;
  }

  try {
    const parsed = readObjectRecord(JSON.parse(await readFile(filePath, 'utf8')));
    if (!parsed) {
      return null;
    }

    const catalog: OpenCodeLiveCatalog = new Map();
    for (const providerId of LIVE_CATALOG_PROVIDER_IDS) {
      const models = readObjectRecord(readObjectRecord(parsed[providerId])?.models);
      if (!models) {
        continue;
      }

      const byModelId = new Map<string, OpenCodeLiveModel>();
      for (const [modelId, rawModel] of Object.entries(models)) {
        const model = readObjectRecord(rawModel);
        if (model) {
          byModelId.set(modelId, readLiveModel(model, modelId));
        }
      }
      if (byModelId.size > 0) {
        catalog.set(providerId, byModelId);
      }
    }

    if (catalog.size === 0) {
      return null;
    }

    liveCatalogMemo = { key: cacheKey, catalog };
    return catalog;
  } catch {
    return null;
  }
};

/** Builds one picker option for a model the curated table does not carry yet. */
const toLiveModelOption = (
  providerId: string,
  modelId: string,
  model: OpenCodeLiveModel,
  description: string | undefined,
): ProviderModelOption => ({
  value: `${providerId}/${modelId}`,
  label: model.name,
  description,
  ...(model.effortValues
    ? { effort: { values: model.effortValues.map((value) => ({ value })) } }
    : {}),
});

/**
 * Overlays the live catalog onto the curated definition for OpenCode's gateways.
 *
 * When the cache covers a provider, live data wins for that provider: only
 * models still marked active stay listed, curated entries the registry dropped
 * disappear, and models the cache gained are appended with their live name and
 * effort tiers. Curated labels and effort metadata survive for every model that
 * predates the merge. Providers the cache does not cover, and unreadable
 * caches, keep the curated list untouched.
 */
const mergeLiveOpenCodeCatalog = (
  definition: ProviderModelsDefinition,
  liveCatalog: OpenCodeLiveCatalog,
): ProviderModelsDefinition => {
  const replacedByProvider = new Map<string, ProviderModelOption[]>();

  for (const [providerId, liveModels] of liveCatalog) {
    const curated = definition.OPTIONS.filter(
      (option) => option.value.split('/')[0] === providerId,
    );
    const description = curated[0]?.description;
    const kept = curated.filter((option) => {
      const modelId = option.value.slice(providerId.length + 1);
      return liveModels.get(modelId)?.active === true;
    });
    const added = [...liveModels.entries()]
      .filter(([modelId, model]) => (
        model.active && !curated.some((option) => option.value === `${providerId}/${modelId}`)
      ))
      .map(([modelId, model]) => toLiveModelOption(providerId, modelId, model, description));

    replacedByProvider.set(providerId, [...kept, ...added]);
  }

  if (replacedByProvider.size === 0) {
    return definition;
  }

  const options: ProviderModelOption[] = [];
  const emittedProviders = new Set<string>();
  for (const option of definition.OPTIONS) {
    const providerId = option.value.split('/')[0];
    if (!replacedByProvider.has(providerId)) {
      options.push(option);
    } else if (!emittedProviders.has(providerId)) {
      emittedProviders.add(providerId);
      options.push(...(replacedByProvider.get(providerId) ?? []));
    }
  }

  if (options.length === 0) {
    return definition;
  }

  return {
    ...definition,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === definition.DEFAULT)
      ? definition.DEFAULT
      : options[0].value,
  };
};

/**
 * Canonicalizes OpenCode's stored session model into the
 * `<providerID>/<modelID>` value the picker and `opencode run --model` expect.
 *
 * OpenCode persists `session.model` as `{ id, providerID, variant }`. Reading
 * only `id` dropped the gateway prefix, so the value was recorded back on the
 * session (and passed to `--model`) as a bare model id, which the CLI then read
 * as a provider id and failed to resume. Records that only carry a model id
 * still degrade to the bare value.
 */
const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  const modelId = readOptionalString(record.id)
    ?? readOptionalString(record.modelID)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value);
  if (!modelId) {
    return null;
  }

  const providerId = readOptionalString(record.providerID) ?? readOptionalString(record.providerId);
  return providerId ? `${providerId}/${modelId}` : modelId;
};

/** Provider registry model adapter for OpenCode predefined models and session metadata. */
export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const liveCatalog = await readLiveOpenCodeCatalog();
    const definition = liveCatalog
      ? mergeLiveOpenCodeCatalog(OPENCODE_PREDEFINED_MODELS, liveCatalog)
      : OPENCODE_PREDEFINED_MODELS;
    return filterOpenCodeModelsByProvider(definition, await readConnectedOpenCodeProviderIds());
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    // OpenCode's `session` table is keyed by its own session id, so the stable
    // app id has to be translated first; sessions discovered on disk store the
    // provider id in both columns and resolve to themselves.
    const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(providerSessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the curated default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
