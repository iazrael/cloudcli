import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  countLoadedProjectSessions,
  mergeExpandedSessionPages,
  projectsHaveChanges,
  removeSessionFromProject,
} from '@/modules/project-workspace/utils/projectsMerge';
import type { Project } from '@/shared/types';

/**
 * The project-list merge utilities decide what a refresh is allowed to do to
 * the sidebar state. The two load-bearing behaviors: a fresh payload that
 * covers a project completely must be able to SHRINK the list (sessions the
 * server archived or deleted used to be resurrected by the deeper-page union,
 * which is why "archive now" left stale rows that even the refresh button
 * could not remove), while a genuinely paginated payload must not clobber
 * rows the client already loaded from deeper pages.
 */

const makeProject = (projectId: string, sessionIds: string[], total?: number): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/tmp/${projectId}`,
  sessions: sessionIds.map((id) => ({ id, summary: id, lastActivity: '2026-09-06T10:00:00.000Z' })),
  sessionMeta: {
    hasMore: total === undefined ? false : sessionIds.length < total,
    total: total ?? sessionIds.length,
  },
});

test('a refresh that covers the project drops rows the server no longer returns', () => {
  const previous = [makeProject('p', ['s1', 's2', 's3', 's4', 's5'])];
  // Two of the five sessions were archived server-side: the fresh payload
  // carries all 3 remaining rows (total = 3), so it is authoritative.
  const incoming = [makeProject('p', ['s1', 's2', 's3'])];

  const merged = mergeExpandedSessionPages(previous, incoming);

  assert.deepEqual(merged[0]?.sessions?.map((session) => session.id), ['s1', 's2', 's3']);
  assert.equal(merged[0]?.sessionMeta?.total, 3);
  assert.equal(merged[0]?.sessionMeta?.hasMore, false);
  // The change is visible to the identity-stability check, so state updates.
  assert.equal(projectsHaveChanges(previous, merged), true);
});

test('a refresh that leaves the union unchanged keeps the previous state identity', () => {
  const previous = [makeProject('p', ['s1', 's2', 's3'])];
  const incoming = [makeProject('p', ['s1', 's2', 's3'])];

  const merged = mergeExpandedSessionPages(previous, incoming);

  assert.equal(projectsHaveChanges(previous, merged), false);
});

test('a paginated refresh still restores rows already loaded from deeper pages', () => {
  // The client loaded 30 rows (say the user expanded the project); the fresh
  // payload only carries the first page — rows s1..s20 in their fresh form —
  // of a still-larger total.
  const previous = [makeProject('p', Array.from({ length: 30 }, (_, i) => `s${i + 1}`), 45)];
  const incoming = [makeProject('p', Array.from({ length: 20 }, (_, i) => `s${i + 1}`), 45)];

  const merged = mergeExpandedSessionPages(previous, incoming);
  const mergedSessions = merged[0]?.sessions ?? [];

  // First page comes from the fresh payload, deeper rows survive the merge.
  assert.equal(mergedSessions.length, 30);
  assert.deepEqual(mergedSessions.map((session) => session.id), Array.from({ length: 30 }, (_, i) => `s${i + 1}`));
  assert.equal(merged[0]?.sessionMeta?.total, 45);
  assert.equal(merged[0]?.sessionMeta?.hasMore, true);
});

test('a fresh payload without a usable total falls back to the union (conservative)', () => {
  const previous = [makeProject('p', ['s1', 's2', 's3'])];
  const incoming = [{ ...makeProject('p', ['s1']), sessionMeta: undefined }] as Project[];

  const merged = mergeExpandedSessionPages(previous, incoming);

  assert.deepEqual(merged[0]?.sessions?.map((session) => session.id), ['s1', 's2', 's3']);
});

test('an initial fetch (no previous state) adopts the payload as-is', () => {
  const incoming = [makeProject('p', ['s1', 's2'])];

  assert.equal(mergeExpandedSessionPages([], incoming), incoming);
});

test('removeSessionFromProject shrinks the list and total, and is a no-op when absent', () => {
  const project = makeProject('p', ['s1', 's2', 's3'], 7);

  const updated = removeSessionFromProject(project, 's2');

  assert.deepEqual(updated.sessions?.map((session) => session.id), ['s1', 's3']);
  assert.equal(updated.sessionMeta?.total, 6);
  assert.equal(updated.sessionMeta?.hasMore, true);
  assert.equal(countLoadedProjectSessions(updated), 2);

  // Removing an id the project never had must not allocate new state.
  assert.equal(removeSessionFromProject(project, 'missing'), project);
});

test('a batch removal only touches projects that actually held the sessions', () => {
  const held = makeProject('held', ['s1', 's2']);
  const untouched = makeProject('untouched', ['u1', 'u2']);
  const projects = [held, untouched];
  const removedIds = ['s2'];

  let changed = false;
  const nextProjects = projects.map((project) => {
    let nextProject = project;
    for (const removedId of removedIds) {
      nextProject = removeSessionFromProject(nextProject, removedId);
    }
    if (nextProject !== project) {
      changed = true;
    }
    return nextProject;
  });

  assert.equal(changed, true);
  assert.equal(nextProjects[0] === held, false);
  // The untouched project keeps its identity so memoized sidebar rows re-render nothing.
  assert.equal(nextProjects[1] === untouched, true);
});
