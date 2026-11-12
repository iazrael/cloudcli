import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';

// The scheduled-jobs barrel initializes i18n, so only `useTranslation` is
// replaced; keys stand in for copy.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function openTaskHalf(onScheduleTask: (schedule: Record<string, unknown>) => void) {
  render(
    <ScheduleMessagePopover
      disabled={false}
      onSchedule={() => {}}
      onScheduleTask={onScheduleTask}
      supportsNativeScheduling={false}
      recurringEnabled
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'schedule.trigger' }));
  fireEvent.click(screen.getByText('composer.recurring'));
}

/** Locates the rotation select by the "every 7 days" option only it carries. */
function rotateSelect(): HTMLSelectElement | undefined {
  return Array.from(document.body.querySelectorAll('select'))
    .find((candidate) => candidate.querySelector('option[value="7"]')) as HTMLSelectElement | undefined;
}

test('a recurring task defaults to no rotation and sends none', () => {
  const onScheduleTask = vi.fn();
  openTaskHalf(onScheduleTask);

  assert.equal(rotateSelect()?.value, '0');
  fireEvent.click(screen.getByText('composer.recurringCreate'));

  const sent = onScheduleTask.mock.calls[0][0] as Record<string, unknown>;
  assert.ok(sent.cronExpression);
  assert.equal('rotateAfterDays' in sent, false);
});

test('a recurring task sends the chosen rotation period', () => {
  const onScheduleTask = vi.fn();
  openTaskHalf(onScheduleTask);

  fireEvent.change(rotateSelect() as HTMLSelectElement, { target: { value: '7' } });
  fireEvent.click(screen.getByText('composer.recurringCreate'));

  const sent = onScheduleTask.mock.calls[0][0] as Record<string, unknown>;
  assert.equal(sent.rotateAfterDays, 7);
});

test('a one-off task offers no rotation', () => {
  openTaskHalf(vi.fn());

  const choiceSelect = Array.from(document.body.querySelectorAll('select'))
    .find((candidate) => candidate.querySelector('option[value="once"]')) as HTMLSelectElement;
  fireEvent.change(choiceSelect, { target: { value: 'once' } });

  assert.equal(rotateSelect(), undefined);
});
