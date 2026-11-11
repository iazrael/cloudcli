import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for #1367: a file added after the composer last looked (an
 * upload, an agent edit, a terminal command) must be offered by the `@`
 * dropdown, without a page reload or a project switch. The dropdown searches
 * the server for the typed query, so each settled query sees the current files.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

// What the server would answer for these file names.
const searchResponse = (names: string[]) => ({
  ok: true,
  json: async () => ({
    results: names.map((name) => ({ type: 'file', name, path: `${ROOT}/${name}`, relativePath: name })),
    truncated: false,
    indexIncomplete: false,
  }),
});

// The project's files right now; the fake server filters them like the real one.
let projectFiles: string[] = [];
const answerFromProject = async (_projectId: string, { query }: { query: string }) =>
  searchResponse(projectFiles.filter((name) => name.toLowerCase().includes(query.toLowerCase())));

// A search response the test resolves by hand, to hold a request in flight.
const deferredSearch = () => {
  let resolve: (names: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof searchResponse>>((resolvePromise) => {
    resolve = (names) => resolvePromise(searchResponse(names));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const queries = () => searchFiles.mock.calls.map(([, params]) => (params as { query: string }).query);

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

beforeEach(() => {
  searchFiles.mockReset();
  searchFiles.mockImplementation(answerFromProject);
  projectFiles = ['a.txt'];
});

test('a file added after the last search shows up in the next one', async () => {
  const { type, shownNames } = renderMentions();

  type('@');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  projectFiles = ['a.txt', 'uploaded.txt'];
  type('@ ');
  type('@ @upl');

  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
});

test('no search goes out before `@` is typed', async () => {
  renderMentions();

  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 150));
  assert.equal(searchFiles.mock.calls.length, 0);
});

test('typing the query quickly sends one search for the settled text, not one per keystroke', async () => {
  projectFiles = ['a.txt', 'b.txt'];
  const { type, shownNames } = renderMentions();

  type('@a');
  type('@a.');
  type('@a.t');

  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.deepEqual(queries(), ['a.t']);
});

test('the previous list stays visible while the next search is in flight', async () => {
  const { type, shownNames } = renderMentions();
  type('@');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  const pending = deferredSearch();
  searchFiles.mockReturnValueOnce(pending.promise);
  type('@n');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.deepEqual(shownNames(), ['a.txt']);

  await act(async () => {
    pending.resolve(['new.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['new.txt']));
});

test('an older search that lands after a newer one cannot overwrite it', async () => {
  const olderSearch = deferredSearch();
  const newerSearch = deferredSearch();
  searchFiles.mockReturnValueOnce(olderSearch.promise);
  searchFiles.mockReturnValueOnce(newerSearch.promise);

  const { type, shownNames } = renderMentions();
  type('@o');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@ne');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));

  // The newer request superseded the older one.
  const olderSignal = (searchFiles.mock.calls[0][2] as { signal: AbortSignal }).signal;
  assert.equal(olderSignal.aborted, true);

  await act(async () => {
    newerSearch.resolve(['newer.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['newer.txt']));

  await act(async () => {
    olderSearch.resolve(['older.txt']);
  });
  assert.deepEqual(shownNames(), ['newer.txt']);
});

test('a search that lands after Escape dismissed the dropdown does not re-open it', async () => {
  const pending = deferredSearch();
  searchFiles.mockReturnValueOnce(pending.promise);

  const { result, type, shownNames } = renderMentions();
  type('mail me at foo@');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  assert.equal(result.current.showFileDropdown, true);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });
  assert.equal(result.current.showFileDropdown, false);

  // Let the search, which brings files, finish completely.
  await act(async () => {
    pending.resolve(['a.txt', 'new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  // Still dismissed, so the next Enter reaches the composer and sends the message.
  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
  assert.equal(searchFiles.mock.calls.length, 1);

  // Typing on inside the query re-opens the dropdown, which searches again.
  projectFiles = ['a.txt', 'new.txt'];
  type('mail me at foo@ne');
  await waitFor(() => assert.deepEqual(shownNames(), ['new.txt']));
  assert.equal(searchFiles.mock.calls.length, 2);
});

test('Escape while the search is pending stops it from showing the dropdown', async () => {
  const pending = deferredSearch();
  searchFiles.mockReturnValueOnce(pending.promise);

  const { result, type } = renderMentions();
  type('mail foo@zz');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });

  // The search brings a matching file.
  await act(async () => {
    pending.resolve(['zz-new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
});
