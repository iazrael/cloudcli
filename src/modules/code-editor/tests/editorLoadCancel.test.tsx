import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * Loading a large text file can sit on the spinner for a long transfer with no
 * way out on a touchscreen. The loading pane now shows a cancel button that
 * closes the editor, and every load runs on an AbortSignal so the in-flight
 * read is really dropped on close — and on switching to another file.
 */

type LoadOptions = { signal?: AbortSignal };

// The base implementations take the real signatures so mock implementations
// may capture the abort signal the document hook passes through.
const readFile = vi.fn((_projectId: string, _filePath: string, _options?: LoadOptions) =>
  Promise.resolve({ ok: true as const, json: async () => ({ content: 'hello' }) }));
const readExternalFile = vi.fn((_filePath: string, _projectId: string | undefined, _options?: LoadOptions) =>
  Promise.resolve({ ok: true as const, json: async () => ({ content: 'external readme' }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile: vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) })) },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
  readExternalFile,
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value }: { value: string }) {
    return <textarea data-testid="editor" value={value} readOnly />;
  }

  return { default: CodeMirrorStub };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
const otherFile: CodeEditorFile = { name: 'b.txt', path: '/repo/b.txt', projectId: 'p1' };

// A read that only settles when released, capturing the signal each call got.
const holdRead = () => {
  const signals: AbortSignal[] = [];
  let release: (() => void) | null = null;
  readFile.mockImplementation((_projectId: string, _path: string, options?: LoadOptions) => {
    signals.push(options?.signal ?? new AbortController().signal);
    // Never resolves; the rejection exists only so a released read can settle.
    return new Promise<{ ok: true; json: () => Promise<{ content: string }> }>(() => {
      release = () => { throw new Error('released'); };
    });
  });
  return {
    signals,
    release: () => release?.(),
  };
};

test('the loading pane offers a cancel button that closes the editor and aborts the read', async () => {
  const held = holdRead();
  // The owner answers onClose by taking the editor down; only then does the
  // load's cleanup abort the transfer.
  const { unmount } = render(<CodeEditor file={file} onClose={() => unmount()} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

  assert.equal(held.signals[0].aborted, true);
  assert.equal(screen.queryByRole('button', { name: 'Cancel' }), null);
});

test('unmounting the editor aborts the in-flight read', async () => {
  const held = holdRead();
  const { unmount } = render(<CodeEditor file={file} onClose={vi.fn()} />);

  unmount();

  assert.equal(held.signals[0].aborted, true);
});

test('switching files aborts the previous file\'s read', async () => {
  const held = holdRead();
  const { rerender } = render(<CodeEditor file={file} onClose={vi.fn()} />);

  readFile.mockResolvedValueOnce({ ok: true, json: async () => ({ content: 'other file' }) });
  rerender(<CodeEditor file={otherFile} onClose={vi.fn()} />);

  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  assert.equal(editor.value, 'other file');
  assert.equal(held.signals[0].aborted, true);
});

// An aborted read rejects; that rejection must not surface as this pane's load
// error (the editor is gone, or another file owns the pane now).
test('an aborted read is not reported as a load error', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  readFile.mockImplementation((_projectId: string, _path: string, options?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
  const { unmount } = render(<CodeEditor file={file} onClose={vi.fn()} />);

  unmount();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(consoleError.mock.calls.length, 0);
  consoleError.mockRestore();
});

// A read-only external document loads through the other endpoint and must be
// cancellable through it as well.
test('external files load with the abort signal too', async () => {
  const signals: AbortSignal[] = [];
  readExternalFile.mockImplementation(async (_path: string, _projectId: string | undefined, options?: { signal?: AbortSignal }) => {
    signals.push(options?.signal ?? new AbortController().signal);
    return new Promise(() => undefined);
  });
  const externalFile: CodeEditorFile = { name: 'README.md', path: '/Volumes/ext/repo/README.md', isReadOnlyExternal: true };
  const { unmount } = render(<CodeEditor file={externalFile} onClose={vi.fn()} />);

  unmount();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
});

