import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ComposerOverflowMenu from '@/modules/chat/composer/ComposerOverflowMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      if (options?.defaultValue) return options.defaultValue;
      return key;
    },
  }),
}));

// The schedule utils come through the scheduled-jobs barrel, whose panel
// exports drag the real i18n config into the test; the menu only needs the
// cron builders, so stub the barrel here.
vi.mock('@/modules/scheduled-jobs', () => ({
  buildCronExpression: vi.fn(() => '0 9 * * *'),
  readLocalTimezone: vi.fn(() => 'UTC'),
}));

const baseProps = {
  tokenBudget: null,
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 97,
  onToggleCommandMenu: vi.fn(),
  canSchedule: true,
  onScheduleMessage: vi.fn(),
  onScheduleTask: vi.fn(),
  supportsNativeScheduling: false,
  recurringEnabled: true,
};

describe('ComposerOverflowMenu', () => {
  it('renders the trigger closed and opens the panel on click', () => {
    render(<ComposerOverflowMenu {...baseProps} />);

    expect(screen.queryByText('input.showAllCommands')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    expect(screen.getByText('input.showAllCommands')).toBeTruthy();
    expect(screen.getByText('97')).toBeTruthy();
  });

  it('always shows the usage row, with numbers only when the budget carries a window', () => {
    const { rerender } = render(<ComposerOverflowMenu {...baseProps} tokenBudget={{ used: 87_000, total: 400_000 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    expect(screen.getByText('input.contextUsage')).toBeTruthy();
    expect(screen.getByText('87K / 400K')).toBeTruthy();

    // Without a budget the row stays (it is the only route to the breakdown
    // on phones) but the numbers and bar drop out.
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' })); // close
    rerender(<ComposerOverflowMenu {...baseProps} tokenBudget={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    expect(screen.getByText('input.contextUsage')).toBeTruthy();
    expect(screen.queryByText('87K / 400K')).toBeNull();
  });

  it('opens the token usage detail from the usage row', () => {
    const onShowTokenUsage = vi.fn();
    render(<ComposerOverflowMenu {...baseProps} tokenBudget={{ used: 87_000, total: 400_000 }} onShowTokenUsage={onShowTokenUsage} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    fireEvent.click(screen.getByText('input.contextUsage'));
    expect(onShowTokenUsage).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('input.contextUsage')).toBeNull(); // panel closed
  });

  it('opens the command menu from the panel', () => {
    const onToggleCommandMenu = vi.fn();
    render(<ComposerOverflowMenu {...baseProps} onToggleCommandMenu={onToggleCommandMenu} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    fireEvent.click(screen.getByText('input.showAllCommands'));
    expect(onToggleCommandMenu).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('input.showAllCommands')).toBeNull();
  });

  it('disables scheduled send without a draft', () => {
    render(<ComposerOverflowMenu {...baseProps} canSchedule={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    expect(screen.getByRole('menuitem', { name: 'schedule.trigger' }).hasAttribute('disabled')).toBe(true);
  });

  it('switches to the schedule view and back', () => {
    render(<ComposerOverflowMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    fireEvent.click(screen.getByText('schedule.trigger'));
    expect(screen.getByText('schedule.in.30')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'schedule.heading' })); // the back row
    expect(screen.getByText('input.showAllCommands')).toBeTruthy();
  });

  it('closes on outside pointer down', () => {
    render(<ComposerOverflowMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'input.moreTools' }));
    fireEvent(document, new Event('pointerdown', { bubbles: true }));
    expect(screen.queryByText('input.showAllCommands')).toBeNull();
  });

  it('closes on Escape and refocuses the trigger', () => {
    render(<ComposerOverflowMenu {...baseProps} />);
    const trigger = screen.getByRole('button', { name: 'input.moreTools' });
    fireEvent.click(trigger);
    expect(screen.getByText('input.showAllCommands')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('input.showAllCommands')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
