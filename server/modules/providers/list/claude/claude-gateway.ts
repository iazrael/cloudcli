/**
 * Claude Gateway
 *
 * Which endpoint the Claude CLI is configured to call. Only OpenCode's
 * inference gateway keeps a local models.dev catalog, so the context-window
 * fallback that reads that catalog must be gated on this answer: a user who
 * later points Claude Code at Anthropic or another gateway must not inherit
 * OpenCode's cached numbers.
 *
 * The base URL is read the way the CLI sees it: the server process env first,
 * then the user's `~/.claude/settings.json` env block. Project-level settings
 * are not consulted — a base URL is an account-level choice in practice, and
 * the window reader also runs for history pages that have no project cwd.
 *
 * Consumers: `claude-runtime.provider` and `claude-usage` (the window reader).
 *
 * @module claude-gateway
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJsonRecord, readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** Base URLs change at human pace; this only avoids re-reading settings per frame. */
const DETECTION_TTL_MS = 30_000;

type GatewayCache = {
  expiresAt: number;
  isOpenCode: boolean;
};

let gatewayCache: GatewayCache | null = null;

function readSettingsBaseUrl(): string | null {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const env = readObjectRecord(readJsonRecord(fs.readFileSync(settingsPath, 'utf8'))?.env) ?? {};
    return readOptionalString(env.ANTHROPIC_BASE_URL) ?? null;
  } catch {
    return null;
  }
}

function isOpenCodeHost(baseUrl: string | null): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/**
 * Whether the Claude CLI currently calls the OpenCode inference gateway.
 * Consumer: the context-window fallback, which only then reads OpenCode's
 * cached models.dev catalog.
 */
export function isOpenCodeGateway(): boolean {
  const now = Date.now();
  if (gatewayCache && gatewayCache.expiresAt > now) {
    return gatewayCache.isOpenCode;
  }
  const baseUrl = readOptionalString(process.env.ANTHROPIC_BASE_URL) ?? readSettingsBaseUrl();
  const isOpenCode = isOpenCodeHost(baseUrl);
  gatewayCache = { expiresAt: now + DETECTION_TTL_MS, isOpenCode };
  return isOpenCode;
}

/**
 * Drops the cached answer. Consumer: tests that switch the configured
 * endpoint between cases.
 */
export function clearClaudeGatewayCache(): void {
  gatewayCache = null;
}
