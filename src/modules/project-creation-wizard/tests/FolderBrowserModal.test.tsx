import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import FolderBrowserModal from '@/modules/project-creation-wizard/FolderBrowserModal';
import type { FolderSuggestion } from '@/shared/types';

const { browseFilesystemFolders } = vi.hoisted(() => ({
  browseFilesystemFolders: vi.fn(),
}));

vi.mock('@/modules/project-creation-wizard/utils/workspaceApi', () => ({
  browseFilesystemFolders,
  createFolderInFilesystem: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const ROOT = '/workspace/root';
const CHILD = `${ROOT}/project-a`;
const childFolder: FolderSuggestion = { path: CHILD, name: 'project-a', type: 'directory' };

const renderModal = () => {
  const onFolderSelected = vi.fn();
  const view = render(
    <FolderBrowserModal
      isOpen
      autoAdvanceOnSelect={false}
      onClose={() => {}}
      onFolderSelected={onFolderSelected}
    />,
  );
  return { view, onFolderSelected };
};

beforeEach(() => {
  browseFilesystemFolders.mockReset();
});

test('opens at the workspace root without a parent link or a selectable root', async () => {
  browseFilesystemFolders.mockResolvedValue({ path: ROOT, suggestions: [childFolder] });

  const { view, onFolderSelected } = renderModal();

  assert.ok(await view.findByText('project-a'));
  // The pathless request is the workspace root — the former `~` placeholder is gone.
  assert.equal(browseFilesystemFolders.mock.calls[0]?.[0], null);
  assert.ok(screen.getByDisplayValue(ROOT));
  assert.equal(screen.queryByText('~'), null);
  assert.equal(screen.queryByText('..'), null);

  const useButton = screen.getByRole('button', { name: 'folderBrowser.useThisFolder' });
  assert.equal(useButton.hasAttribute('disabled'), true);
  fireEvent.click(useButton);
  assert.equal(onFolderSelected.mock.calls.length, 0);
});

test('a subfolder can be selected once entered', async () => {
  browseFilesystemFolders.mockImplementation(async (path: string | null) => (
    path === CHILD
      ? { path: CHILD, suggestions: [] }
      : { path: ROOT, suggestions: [childFolder] }
  ));

  const { view, onFolderSelected } = renderModal();

  fireEvent.click(await view.findByText('project-a'));
  assert.ok(await view.findByText('folderBrowser.noSubfolders'));
  assert.ok(screen.getByDisplayValue(CHILD));
  assert.ok(screen.getByText('..'));

  const useButton = screen.getByRole('button', { name: 'folderBrowser.useThisFolder' });
  assert.equal(useButton.hasAttribute('disabled'), false);
  fireEvent.click(useButton);
  assert.deepEqual(onFolderSelected.mock.calls, [[CHILD, false]]);
});

test('.. returns to the workspace root', async () => {
  browseFilesystemFolders.mockImplementation(async (path: string | null) => (
    path === CHILD
      ? { path: CHILD, suggestions: [] }
      : { path: ROOT, suggestions: [childFolder] }
  ));

  const { view } = renderModal();

  fireEvent.click(await view.findByText('project-a'));
  assert.ok(await view.findByText('folderBrowser.noSubfolders'));

  fireEvent.click(screen.getByText('..'));
  assert.ok(await view.findByText('project-a'));
  assert.ok(screen.getByDisplayValue(ROOT));
  assert.equal(screen.queryByText('..'), null);
});

test('a failed root listing leaves nothing selectable', async () => {
  browseFilesystemFolders.mockRejectedValue(new Error('Directory not accessible'));

  const { view, onFolderSelected } = renderModal();

  assert.ok(await view.findByText('Directory not accessible'));
  const useButton = screen.getByRole('button', { name: 'folderBrowser.useThisFolder' });
  assert.equal(useButton.hasAttribute('disabled'), true);
  fireEvent.click(useButton);
  assert.equal(onFolderSelected.mock.calls.length, 0);
});
