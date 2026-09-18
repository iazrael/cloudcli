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

test('falls back to the project title when no session is selected', () => {
  assert.equal(getPageTitle(project, null), 'My Project - CloudCLI UI');
});

test('falls back to the app title when no project or session is selected', () => {
  assert.equal(getPageTitle(null, null), 'CloudCLI UI');
});
