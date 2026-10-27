import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';

const project: Project = {
  projectId: 'project-1',
  displayName: 'My Project',
  fullPath: '/projects/my-project',
};

test('uses the selected session summary as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Fix browser tab title',
    __provider: 'claude',
  };

  assert.equal(getPageTitle(project, session), 'Fix browser tab title');
});

/**
 * This case used to build its session with a `name` field and assert the title
 * came from it. No endpoint sends one — Cursor's synchronizer writes the name
 * it derives into `custom_name`, which every session row surfaces as `summary`
 * — so the fixture proved a contract the backend never produced while real
 * Cursor sessions fell through to the placeholder.
 */
test('a Cursor session title comes from the same field as every other provider', () => {
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Cursor session name',
    __provider: 'cursor',
  };

  assert.equal(getPageTitle(project, session), 'Cursor session name');
});

test('prefers the persisted summary of a Cursor session, as the sessions API returns it', () => {
  // The sessions API carries every provider's custom name as `summary` and never
  // sets `name`, so a renamed Cursor session must not fall through to the placeholder.
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Cursor session renamed',
    __provider: 'cursor',
  };

  assert.equal(getPageTitle(project, session), 'Cursor session renamed');
  // This fork's title helper uses one placeholder for every provider: the
  // Cursor `name` field no endpoint sends was dropped, not re-spelled.
  assert.equal(getPageTitle(project, { id: 'session-2', summary: '', __provider: 'cursor' }), 'New Session');
});

test('falls back to the project title when no session is selected', () => {
  assert.equal(getPageTitle(project, null), 'My Project - CloudCLI');
});

test('falls back to the app title when no project or session is selected', () => {
  assert.equal(getPageTitle(null, null), 'CloudCLI');
});
