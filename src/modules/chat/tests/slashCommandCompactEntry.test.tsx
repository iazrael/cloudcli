import assert from 'node:assert/strict';
import { createRef } from 'react';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project, SlashCommand } from '@/shared/types';

/**
 * Both the shared project list and the composer can contribute `/compact`
 * for a compacting provider; the `/` menu must still offer it exactly once.
 */

const projectCommands = vi.fn<() => SlashCommand[]>();

vi.mock('@/shared/hooks/useProjectSlashCommands', () => ({
  useProjectSlashCommands: () => ({ commands: projectCommands(), isLoading: false, error: null }),
}));

const project: Project = {
  projectId: 'p1',
  displayName: 'Triage',
  fullPath: '/work/triage-repo',
};

const renderMenu = async () => {
  const { useSlashCommands } = await import('@/modules/chat/hooks/useSlashCommands');
  const textareaRef = createRef<HTMLTextAreaElement>();
  const { result } = renderHook(() => useSlashCommands({
    selectedProject: project,
    provider: 'claude',
    input: '',
    setInput: () => undefined,
    textareaRef,
    onExecuteCommand: () => undefined,
    supportsCompaction: true,
  }));
  act(() => result.current.handleToggleCommandMenu());
  return result.current.filteredCommands.map((command) => command.name);
};

test('offers /compact once when the shared list already carries it', async () => {
  projectCommands.mockReturnValue([
    { name: '/help', description: 'Show help', namespace: 'builtin', type: 'built-in' },
    { name: '/compact', description: 'Summarize', namespace: 'builtin', type: 'engine' },
  ]);

  const names = await renderMenu();
  assert.equal(names.filter((name) => name === '/compact').length, 1);
});

test('still offers /compact when the shared list has none yet', async () => {
  projectCommands.mockReturnValue([]);

  const names = await renderMenu();
  assert.deepEqual(names, ['/compact']);
});
