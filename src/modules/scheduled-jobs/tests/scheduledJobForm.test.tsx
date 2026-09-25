import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { ScheduledJob } from '@/shared/types';
import { toLocalDateTimeInputValue } from '@/shared/utils';
import { ScheduledJobForm } from '@/modules/scheduled-jobs/ScheduledJobForm';

function okResponse(data: unknown): Response {
  return { ok: true, json: async () => ({ success: true, data }) } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Locates the schedule select by the one-off option only it carries. */
function scheduleSelect(container: HTMLElement): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll('select'))
    .find((candidate) => candidate.querySelector('option[value="once"]'));
  assert.ok(select, 'the schedule select offers a one-off choice');
  return select as HTMLSelectElement;
}

function renderForm(editingJob: ScheduledJob | null, onSave: (input: Record<string, unknown>) => void) {
  vi.spyOn(api.providers, 'capabilities').mockImplementation(async () => okResponse({ providers: [] }));
  return render(
    <ScheduledJobForm
      projectPath="/workspace/a"
      editingJob={editingJob}
      saving={false}
      error={null}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
}

test('a one-off is saved as runAt, not as a cron expression', () => {
  const onSave = vi.fn();
  const { container } = renderForm(null, onSave);

  fireEvent.change(container.querySelector('input[type="text"]') as HTMLInputElement, {
    target: { value: 'One-off' },
  });
  fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
    target: { value: 'check once' },
  });
  fireEvent.change(scheduleSelect(container), { target: { value: 'once' } });

  const onceInput = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
  assert.ok(onceInput, 'picking the one-off schedule reveals the instant picker');
  fireEvent.change(onceInput, { target: { value: '2027-03-05T09:30' } });

  const buttons = Array.from(container.querySelectorAll('button'));
  fireEvent.click(buttons[buttons.length - 1] as HTMLButtonElement);

  assert.equal(onSave.mock.calls.length, 1);
  const saved = onSave.mock.calls[0][0] as { runAt?: string; cronExpression?: string };
  assert.equal(saved.runAt, new Date('2027-03-05T09:30').toISOString());
  assert.equal(saved.cronExpression, undefined);
});

test('editing a one-off opens on its instant and keeps saving it as runAt', () => {
  const runAt = new Date(2027, 2, 5, 9, 30);
  const job: ScheduledJob = {
    id: 'job-once',
    name: 'One-off',
    provider: 'opencode',
    projectPath: '/workspace/a',
    sessionId: null,
    sessionMode: 'new',
    prompt: 'check once',
    options: {},
    cronExpression: '30 9 5 3 *',
    timezone: 'Europe/Budapest',
    runAt: runAt.toISOString(),
    enabled: true,
    nextRunAt: runAt.toISOString(),
    lastRunAt: null,
    lastStatus: null,
    createdAt: '2026-09-23T00:00:00.000Z',
  };
  const onSave = vi.fn();
  const { container } = renderForm(job, onSave);

  assert.equal(scheduleSelect(container).value, 'once');
  const onceInput = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
  assert.equal(onceInput.value, toLocalDateTimeInputValue(runAt));

  const buttons = Array.from(container.querySelectorAll('button'));
  fireEvent.click(buttons[buttons.length - 1] as HTMLButtonElement);

  const saved = onSave.mock.calls[0][0] as { runAt?: string };
  assert.equal(saved.runAt, runAt.toISOString());
});
