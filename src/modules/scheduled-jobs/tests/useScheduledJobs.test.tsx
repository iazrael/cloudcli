import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { useScheduledJobs } from '@/modules/scheduled-jobs/hooks/useScheduledJobs';
import type { ScheduledJob } from '@/shared/types';

function okResponse(data: unknown): Response {
  return { ok: true, json: async () => ({ success: true, data }) } as unknown as Response;
}

const JOB_A: ScheduledJob = {
  id: 'job-a',
  name: 'Nightly',
  provider: 'opencode',
  projectPath: '/workspace/a',
  sessionId: 'session-a',
  sessionMode: 'reuse',
  prompt: 'run checks',
  options: {},
  cronExpression: '30 9 * * *',
  timezone: 'Asia/Shanghai',
  enabled: true,
  nextRunAt: '2026-09-22T01:30:00.000Z',
  lastRunAt: null,
  lastStatus: null,
  createdAt: '2026-09-21T00:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('loads the jobs for the requested scope', async () => {
  vi.spyOn(api.scheduledJobs, 'list').mockImplementation(async () => okResponse([JOB_A]));

  const { result } = renderHook(() => useScheduledJobs({ sessionId: 'session-a' }));

  await waitFor(() => assert.equal(result.current.jobs.length, 1));
  assert.equal(result.current.loading, false);
  assert.equal(result.current.jobs[0].name, 'Nightly');
});

test('switching scope clears the previous scope\'s jobs immediately', async () => {
  vi.spyOn(api.scheduledJobs, 'list').mockImplementation(async () => okResponse([JOB_A]));

  const { result, rerender } = renderHook(
    ({ sessionId }) => useScheduledJobs({ sessionId }),
    { initialProps: { sessionId: 'session-a' } },
  );
  await waitFor(() => assert.equal(result.current.jobs.length, 1));

  rerender({ sessionId: 'session-b' });

  // The old scope's jobs must not linger while the new scope loads.
  assert.equal(result.current.jobs.length, 0);
});

test('creating a job posts the draft and refreshes the list', async () => {
  const list = vi.spyOn(api.scheduledJobs, 'list').mockImplementation(async () => okResponse([JOB_A]));
  const create = vi.spyOn(api.scheduledJobs, 'create').mockImplementation(async () => okResponse(JOB_A));

  const { result } = renderHook(() => useScheduledJobs({ projectPath: '/workspace/a' }));
  await waitFor(() => assert.equal(result.current.loading, false));

  await act(async () => {
    await result.current.createJob({
      name: 'Nightly',
      prompt: 'run checks',
      sessionMode: 'new',
      provider: 'opencode',
      projectPath: '/workspace/a',
      cronExpression: '30 9 * * *',
      timezone: 'Asia/Shanghai',
    });
  });

  assert.equal(create.mock.calls.length, 1);
  assert.equal(create.mock.calls[0][0].cronExpression, '30 9 * * *');
  // Once on mount, once after the create.
  assert.equal(list.mock.calls.length, 2);
});
