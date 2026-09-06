import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatBuildVersion } from '@/shared/utils';

test('shows the exact-tag describe alone so release day does not read v2.1.0(v2.1.0)', () => {
  assert.equal(formatBuildVersion('2.1.0', 'v2.1.0'), 'v2.1.0');
});

test('shows a drifted describe alone because it already carries the version and hash', () => {
  assert.equal(formatBuildVersion('2.1.0', 'v2.1.0-5-g273e294'), 'v2.1.0-5-g273e294');
});

test('keeps the dirty suffix when the built tree had uncommitted changes', () => {
  assert.equal(formatBuildVersion('2.1.0', 'v2.1.0-dirty'), 'v2.1.0-dirty');
});

test('pairs the package version with the bare --always hash fallback', () => {
  assert.equal(formatBuildVersion('2.1.0', '952954a'), 'v2.1.0(952954a)');
});

test('falls back to the plain package version when no commit was baked in', () => {
  assert.equal(formatBuildVersion('2.1.0', ''), 'v2.1.0');
});

test('renders nothing when neither version nor commit exists (e.g. under tsx tests)', () => {
  assert.equal(formatBuildVersion('', ''), '');
});
