import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { LLMProvider, ProjectSession } from '@/shared/types';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { saveClaudePermissions } from '@/modules/chat/utils/chatStorage';

vi.mock('@/shared/api', () => ({
  authenticatedFetch: vi.fn(() => new Promise<Response>(() => {})),
  api: {
    user: {
      savePreferences: vi.fn(async () => new Response(null, { status: 204 })),
    },
  },
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({
    capabilities: {
      claude: { permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'], defaultPermissionMode: 'default' },
      cursor: { permissionModes: ['default', 'acceptEdits'], defaultPermissionMode: 'default' },
      codex: { permissionModes: ['default', 'acceptEdits', 'bypassPermissions'], defaultPermissionMode: 'default' },
      opencode: { permissionModes: ['default', 'plan'], defaultPermissionMode: 'default' },
      zcode: { permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'], defaultPermissionMode: 'default' },
      antigravity: { permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'], defaultPermissionMode: 'default' },
    },
  }),
}));

const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');

type HookProps = {
  selectedSession: ProjectSession | null;
  newSessionTrigger: number;
};

function renderProviderState(provider: LLMProvider, props?: Partial<HookProps>) {
  localStorage.setItem('selected-provider', provider);
  const initialProps: HookProps = {
    selectedSession: null,
    newSessionTrigger: 0,
    ...props,
  };

  return renderHook(
    ({ selectedSession, newSessionTrigger }: HookProps) => useChatProviderState({
      selectedSession,
      selectedProject: null,
      newSessionTrigger,
    }),
    { initialProps },
  );
}

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

afterEach(() => {
  resetUserPreferences();
});

test('新 Codex 会话读取设置页保存的权限模式', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });

  const { result } = renderProviderState('codex');
  await act(async () => {});

  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('切换提供商时读取各自的设置值且不串值', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });
  writeUserPreference('zcodePermissions', { permissionMode: 'plan' });

  const { result } = renderProviderState('codex');
  await act(async () => {});
  assert.equal(result.current.permissionMode, 'acceptEdits');

  await act(async () => {
    result.current.setProvider('zcode');
  });
  assert.equal(result.current.permissionMode, 'plan');
});

test('已有会话的权限选择优先于提供商设置', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });
  localStorage.setItem('permissionMode-session-1', 'bypassPermissions');

  const { result } = renderProviderState('codex', {
    selectedSession: { id: 'session-1', __provider: 'codex' } as ProjectSession,
  });
  await act(async () => {});

  assert.equal(result.current.permissionMode, 'bypassPermissions');
});

test('草稿会话手动选择在分配会话 ID 后继续生效', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });

  const { result, rerender } = renderProviderState('codex');
  await act(async () => {
    result.current.selectPermissionMode('bypassPermissions');
  });
  await act(async () => {
    result.current.persistPermissionModeForSession('session-new');
  });

  rerender({
    selectedSession: { id: 'session-new', __provider: 'codex' } as ProjectSession,
    newSessionTrigger: 0,
  });
  await act(async () => {});

  assert.equal(result.current.permissionMode, 'bypassPermissions');
  assert.equal(localStorage.getItem('permissionMode-session-new'), 'bypassPermissions');
});

test('再次新建对话会清除草稿覆盖并恢复设置值', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });

  const { result, rerender } = renderProviderState('codex');
  await act(async () => {
    result.current.selectPermissionMode('bypassPermissions');
  });
  assert.equal(result.current.permissionMode, 'bypassPermissions');

  rerender({ selectedSession: null, newSessionTrigger: 1 });
  await act(async () => {});

  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('设置值不受提供商支持时回退到能力默认值', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'plan' });

  const { result } = renderProviderState('codex');
  await act(async () => {});

  assert.equal(result.current.permissionMode, 'default');
});

test('设置页保存后会刷新当前空白新会话', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'default' });
  const { result } = renderProviderState('codex');
  await act(async () => {});

  await act(async () => {
    writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });
  });

  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('新 Claude 会话读取设置页保存的权限模式', async () => {
  writeUserPreference('claudePermissions', {
    permissionMode: 'auto',
    allowedTools: [],
    disallowedTools: [],
  });

  const { result } = renderProviderState('claude');
  await act(async () => {});

  assert.equal(result.current.permissionMode, 'auto');
});

test('会话内授权保存工具清单时保留已存的权限模式', () => {
  writeUserPreference('claudePermissions', {
    permissionMode: 'auto',
    allowedTools: [],
    disallowedTools: [],
  });

  saveClaudePermissions({
    allowedTools: ['Bash(git log:*)'],
    disallowedTools: [],
  });

  const stored = readUserPreference<{ permissionMode?: string; allowedTools?: string[] }>('claudePermissions', {});
  assert.equal(stored.permissionMode, 'auto');
  assert.deepEqual(stored.allowedTools, ['Bash(git log:*)']);
});
