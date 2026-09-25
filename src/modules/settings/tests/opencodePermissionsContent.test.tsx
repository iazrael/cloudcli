import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test, vi } from 'vitest';

import type { AgentCategory, AgentContextByProvider } from '@/shared/types';
import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';

// The MCP panel is a separate category; its barrel is stubbed to keep the
// import graph light. The skills stub exposes a sentinel so the category's
// rendering can be asserted without loading the real panel.
vi.mock('@/modules/mcp', () => ({ McpServers: () => null }));
vi.mock('@/modules/skills', () => ({
  ProviderSkills: () => React.createElement('div', { 'data-skills-panel': 'true' }),
}));

const agentContextById = {
  claude: { authStatus: { installed: true, authenticated: true }, onLogin: () => {} },
  cursor: { authStatus: { installed: true, authenticated: true }, onLogin: () => {} },
  codex: { authStatus: { installed: true, authenticated: true }, onLogin: () => {} },
  opencode: { authStatus: { installed: true, authenticated: true }, onLogin: () => {} },
  zcode: { authStatus: { installed: true, authenticated: true }, onLogin: () => {} },
  antigravity: { authStatus: { installed: true, authenticated: true }, onLogin: () => {} },
} as unknown as AgentContextByProvider;

const buildProps = (selectedCategory: AgentCategory) => ({
  selectedAgent: 'opencode' as const,
  selectedCategory,
  agentContextById,
  claudePermissions: { permissionMode: 'default' as const, allowedTools: [], disallowedTools: [] },
  onClaudePermissionsChange: () => {},
  cursorPermissions: { skipPermissions: false, allowedCommands: [], disallowedCommands: [] },
  onCursorPermissionsChange: () => {},
  codexPermissionMode: 'default' as const,
  onCodexPermissionModeChange: () => {},
  antigravityPermissionMode: 'default' as const,
  onAntigravityPermissionModeChange: () => {},
  zcodePermissionMode: 'default' as const,
  onZcodePermissionModeChange: () => {},
  opencodePermissionMode: 'plan' as const,
  onOpenCodePermissionModeChange: () => {},
  projects: [],
});

/**
 * Regression coverage for the OpenCode permissions panel rendering empty: the
 * category used to have no content branch, so selecting it showed a blank
 * panel while every other provider rendered its mode cards.
 */
test('renders OpenCode permission mode options in the permissions category', () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentCategoryContentSection, buildProps('permissions')),
  );

  const modeInputs = markup.match(/name="opencodePermissionMode"/g) ?? [];
  assert.equal(modeInputs.length, 4);
  // The stored mode must be the selected one, so the panel reflects state.
  assert.match(markup, /name="opencodePermissionMode"[^>]*checked/);
});

/** OpenCode has a writable native skill directory, so the skills category must render for it. */
test('renders the skills panel in the OpenCode skills category', () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentCategoryContentSection, buildProps('skills')),
  );

  assert.match(markup, /data-skills-panel/);
});

test('renders nothing for a category that does not belong to the OpenCode permissions panel', () => {
  const markup = renderToStaticMarkup(
    React.createElement(AgentCategoryContentSection, buildProps('account')),
  );

  assert.equal(markup.includes('opencodePermissionMode'), false);
});
