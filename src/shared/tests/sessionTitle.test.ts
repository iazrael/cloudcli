/**
 * The session label is provider-neutral.
 *
 * `getSessionTitle` used to special-case Cursor and read a `name` field, but
 * no endpoint has ever sent one: the Cursor synchronizer derives the session's
 * name from the transcript's first user line and stores it in `custom_name`,
 * which every session row surfaces as `summary` like any other provider's.
 * The branch therefore fell through to the placeholder for every Cursor
 * session while the real name sat unread in `summary`.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ProjectSession } from '@/shared/types';
import { getSessionTitle } from '@/shared/utils';

test('a Cursor session is labelled from the same field as every other provider', () => {
  const session: ProjectSession = {
    id: 'sess-1',
    __provider: 'cursor',
    summary: 'refactor the merge helper',
  };

  assert.equal(getSessionTitle(session), 'refactor the merge helper');
});

test('a session with no label yet falls back to the placeholder', () => {
  assert.equal(getSessionTitle({ id: 'sess-2', __provider: 'cursor' }), 'New Session');
  assert.equal(getSessionTitle({ id: 'sess-3', __provider: 'claude' }), 'New Session');
});

test('other providers keep reading their summary', () => {
  const session: ProjectSession = {
    id: 'sess-4',
    __provider: 'claude',
    summary: 'explain the timeline merge',
  };

  assert.equal(getSessionTitle(session), 'explain the timeline merge');
});
