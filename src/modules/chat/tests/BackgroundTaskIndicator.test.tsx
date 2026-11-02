import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ActiveBackgroundTask } from '@/shared/types';
import BackgroundTaskIndicator from '@/modules/chat/composer/BackgroundTaskIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => {
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
}));

describe('BackgroundTaskIndicator', () => {
  it('renders nothing when task list is empty', () => {
    const { container } = render(<BackgroundTaskIndicator tasks={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders active background tasks with command and toolName', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'task-1',
        toolName: 'Bash',
        command: 'pnpm run build',
        startedAt: Date.now() - 5000,
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} />);

    expect(screen.getByText(/pnpm run build/)).toBeTruthy();
    expect(screen.getByText(/Bash/)).toBeTruthy();
  });

  it('renders description or taskId when command is not present', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'subagent-abc',
        toolName: 'Task',
        description: 'Searching codebase',
        startedAt: Date.now() - 10000,
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} />);

    expect(screen.getByText(/Searching codebase/)).toBeTruthy();
    expect(screen.getByText(/Task/)).toBeTruthy();
  });

  it('stops every task from the header and one task from its row', () => {
    const onStopTasks = vi.fn();
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'task-1',
        taskId: 'engine-task-1',
        toolName: 'Bash',
        command: 'pnpm run test',
        startedAt: Date.now(),
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} onStopTasks={onStopTasks} />);

    screen.getByTitle('中止后台任务').click();
    expect(onStopTasks).toHaveBeenLastCalledWith();

    screen.getByTitle('停止此任务').click();
    expect(onStopTasks).toHaveBeenLastCalledWith('task-1');
  });

  it('offers no stop for a task the engine cannot stop', () => {
    const onStopTasks = vi.fn();
    const tasks: ActiveBackgroundTask[] = [
      {
        id: 'toolu_shell_1',
        toolName: 'Bash',
        command: 'while true; do ...; done',
        startedAt: Date.now(),
      },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} onStopTasks={onStopTasks} />);

    expect(screen.queryByTitle('中止后台任务')).toBeNull();
    expect(screen.queryByTitle('停止此任务')).toBeNull();
  });

  it('reveals the task whose label is clicked, and stopping it does not reveal', () => {
    // The label region is the jump to the transcript card; the stop button
    // beside it must not trigger that jump.
    const onRevealTask = vi.fn();
    const onStopTasks = vi.fn();
    const task: ActiveBackgroundTask = {
      id: 'toolu_spawn_1',
      taskId: 'task-1',
      toolName: 'Agent',
      description: 'Audit the repo',
      startedAt: Date.now(),
    };

    render(
      <BackgroundTaskIndicator tasks={[task]} onRevealTask={onRevealTask} onStopTasks={onStopTasks} />,
    );

    screen.getByTitle('定位到对应卡片').click();
    expect(onRevealTask).toHaveBeenCalledTimes(1);
    expect(onRevealTask).toHaveBeenCalledWith(task);
    expect(onStopTasks).not.toHaveBeenCalled();

    screen.getByTitle('停止此任务').click();
    expect(onStopTasks).toHaveBeenCalledWith('toolu_spawn_1');
    expect(onRevealTask).toHaveBeenCalledTimes(1);
  });

  it('keeps rows inert when there is nothing to reveal', () => {
    const tasks: ActiveBackgroundTask[] = [
      { id: 'task-1', toolName: 'Bash', command: 'pnpm run build', startedAt: Date.now() },
    ];

    render(<BackgroundTaskIndicator tasks={tasks} />);

    expect(screen.queryByTitle('定位到对应卡片')).toBeNull();
    expect(screen.getByText(/pnpm run build/)).toBeTruthy();
  });
});
