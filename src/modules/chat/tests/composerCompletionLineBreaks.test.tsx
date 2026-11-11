import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * A slash-command or `@` file pick replaces the token being typed, and the
 * token ends at the first whitespace of any kind — not just a space. When the
 * token was followed by a line break, the completion used to search for the
 * next space instead and dropped every character up to it ("\nfoo" of
 * "\nfoo bar"), or kept the `@` dropdown open across lines.
 */

const jsonResponse = (payload: unknown) => ({ ok: true, json: async () => payload });

const listCommands = vi.fn();
const listSkills = vi.fn();
const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    commands: { list: (...args: unknown[]) => listCommands(...args) },
    providers: { skills: (...args: unknown[]) => listSkills(...args) },
    searchFiles: (...args: unknown[]) => searchFiles(...args),
  },
}));

const { useSlashCommands } = await import('@/modules/chat/hooks/useSlashCommands');
const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

beforeEach(() => {
  localStorage.clear();
  listCommands.mockReset();
  listSkills.mockReset();
  searchFiles.mockReset();
  listCommands.mockResolvedValue(jsonResponse({
    builtIn: [{ name: '/help', description: 'Show help', namespace: 'builtin' }],
    custom: [{ name: '/echo', description: 'Echo', namespace: 'project', path: '.claude/commands/echo.md' }],
  }));
  listSkills.mockResolvedValue(jsonResponse({ success: true, data: { skills: [] } }));
  searchFiles.mockResolvedValue(jsonResponse({
    results: [{ type: 'file', name: 'upload.txt', path: `${ROOT}/upload.txt`, relativePath: 'upload.txt' }],
    truncated: false,
    indexIncomplete: false,
  }));
});

test('picking a slash command keeps the lines typed after the partial name', async () => {
  const typed = '/ec\nfoo bar';
  const caret = '/ec'.length;
  const setInputCalls: string[] = [];
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.value = typed;
  textarea.setSelectionRange(caret, caret);
  const textareaRef = { current: textarea } as RefObject<HTMLTextAreaElement>;

  const { result } = renderHook(() => useSlashCommands({
    selectedProject: project,
    provider: 'claude',
    input: typed,
    setInput: (value) => { setInputCalls.push(value as string); },
    textareaRef,
    onExecuteCommand: () => undefined,
  }));
  await waitFor(() => assert.equal(result.current.slashCommandsCount, 2));
  act(() => { result.current.handleCommandInputChange(typed, caret); });
  await waitFor(() => assert.deepEqual(result.current.filteredCommands.map((command) => command.name), ['/echo']));

  // Tab completes the highlighted command into the input.
  act(() => {
    result.current.handleCommandMenuKeyDown(
      { key: 'Tab', preventDefault: () => undefined } as unknown as KeyboardEvent<HTMLTextAreaElement>,
    );
  });

  assert.deepEqual(setInputCalls, ['/echo foo bar']);
});

const renderMentions = (input: string, caret: number) => {
  const setInput = vi.fn();
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ text }: { text: string }) => useFileMentions({ selectedProject: project, input: text, setInput, textareaRef }),
    { initialProps: { text: '' } },
  );
  const type = async () => {
    hook.rerender({ text: input });
    act(() => { hook.result.current.setCursorPosition(caret); });
  };
  return { ...hook, setInput, type };
};

test('picking an @ file keeps the lines typed after the query', async () => {
  const typed = '@upl\nfoo bar';
  const { result, setInput, type } = renderMentions(typed, '@upl'.length);
  await type();
  await waitFor(() => assert.equal(result.current.filteredFiles.length, 1));

  act(() => { result.current.selectFile(result.current.filteredFiles[0]); });

  assert.equal(setInput.mock.calls.at(-1)?.[0], 'upload.txt \nfoo bar');
});

test('a line break ends the @ query and closes the dropdown', async () => {
  const typed = '@upl\nmore';
  const { result, type } = renderMentions(typed, typed.length);
  await type();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.equal(result.current.showFileDropdown, false);
});
