import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import type { ScheduledMessage } from '@/shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The barrel's ScheduledJobsPanel export drags xterm into jsdom; the list only
// reads describeSchedule from it.
vi.mock('@/modules/scheduled-jobs', () => ({
  describeSchedule: () => ({ key: '', params: {} }),
}));

const PENDING: ScheduledMessage = {
  id: 'sm-1',
  sessionId: 'session-a',
  content: 'send this later',
  options: {},
  scheduledFor: '2026-11-13T02:58:59.000Z',
  status: 'pending',
  failureReason: null,
  createdAt: '2026-11-12T22:30:00.000Z',
};

const FAILED: ScheduledMessage = {
  ...PENDING,
  id: 'sm-2',
  status: 'failed',
  failureReason: 'engine unavailable',
};

describe('ScheduledMessageList', () => {
  it('renders a pending message with recall and cancel actions', () => {
    const onRecall = vi.fn();
    const onCancel = vi.fn();

    render(
      <ScheduledMessageList
        scheduledMessages={[PENDING]}
        scheduledJobs={[]}
        onRecall={onRecall}
        onCancel={onCancel}
        onDeleteJob={vi.fn()}
      />,
    );

    expect(screen.getByText('send this later')).toBeTruthy();

    // Recall hands the row back so the caller can restore its text.
    fireEvent.click(screen.getByTitle('schedule.recall'));
    expect(onRecall).toHaveBeenCalledWith(PENDING);
    expect(onCancel).not.toHaveBeenCalled();

    // The plain cancel stays available next to it.
    fireEvent.click(screen.getByTitle('schedule.cancel'));
    expect(onCancel).toHaveBeenCalledWith(PENDING.id);
    expect(onRecall).toHaveBeenCalledTimes(1);
  });

  it('offers recall on a failed message too', () => {
    const onRecall = vi.fn();
    const onCancel = vi.fn();

    render(
      <ScheduledMessageList
        scheduledMessages={[FAILED]}
        scheduledJobs={[]}
        onRecall={onRecall}
        onCancel={onCancel}
        onDeleteJob={vi.fn()}
      />,
    );

    expect(screen.getByText('send this later')).toBeTruthy();
    fireEvent.click(screen.getByTitle('schedule.recall'));
    expect(onRecall).toHaveBeenCalledWith(FAILED);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
