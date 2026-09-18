import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { test, vi } from 'vitest';

import ChangesView from '@/modules/git-panel/changes/ChangesView';
import { i18n } from '@/modules/i18n';
import type { GitDiffMap, GitStatusResponse } from '@/shared/types';

/**
 * A working tree with hundreds of changes used to fetch every file's diff up
 * front and keep all of them mounted behind a CSS-collapsed container, which
 * exhausted mobile browser memory. Diffs must load — and render — one expanded
 * row at a time.
 */

const gitStatus: GitStatusResponse = {
  branch: 'main',
  hasCommits: true,
  modified: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  staged: [],
};

const everyDiff: GitDiffMap = {
  'src/a.ts': '@@ -1 +1 @@\n-old a\n+new a',
  'src/b.ts': '@@ -1 +1 @@\n-old b\n+new b',
  'src/c.ts': '@@ -1 +1 @@\n-old c\n+new c',
};

function renderChangesView(gitDiff: GitDiffMap, onFetchFileDiff: (filePath: string) => Promise<void>) {
  const noop = async () => {};
  return render(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(ChangesView, {
        isMobile: false,
        projectPath: '/tmp/project',
        gitStatus,
        gitDiff,
        isLoading: false,
        wrapText: true,
        isCreatingInitialCommit: false,
        onWrapTextChange: () => {},
        onCreateInitialCommit: async () => true,
        onOpenFile: noop,
        onDiscardFile: noop,
        onDeleteFile: noop,
        onStageFiles: async () => true,
        onUnstageFiles: async () => true,
        onCommitChanges: async () => true,
        onRequestConfirmation: () => {},
        onExpandedFilesChange: () => {},
        onFetchFileDiff,
      }),
    ),
  );
}

function expandToggles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('button[title]')).filter(
    (button) => button.getAttribute('title') === i18n.t('git:item.expandDiff'),
  ) as HTMLElement[];
}

test('no diff is requested until a file row is expanded', () => {
  const onFetchFileDiff = vi.fn(async () => {});

  renderChangesView({}, onFetchFileDiff);

  assert.equal(onFetchFileDiff.mock.calls.length, 0);
});

test('expanding one row requests only that file diff', () => {
  const onFetchFileDiff = vi.fn(async () => {});

  const { container } = renderChangesView({}, onFetchFileDiff);
  fireEvent.click(expandToggles(container)[1]);

  assert.deepEqual(
    onFetchFileDiff.mock.calls.map(([filePath]) => filePath),
    ['src/b.ts'],
  );
});

test('collapsed rows keep their diff out of the DOM', () => {
  const onFetchFileDiff = vi.fn(async () => {});

  const { container } = renderChangesView(everyDiff, onFetchFileDiff);
  assert.equal(container.querySelectorAll('.diff-viewer').length, 0);

  fireEvent.click(expandToggles(container)[0]);

  const renderedDiffs = container.querySelectorAll('.diff-viewer');
  assert.equal(renderedDiffs.length, 1);
  assert.match(renderedDiffs[0].textContent ?? '', /new a/);
});
