import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FileContextMenu from '@/modules/file-tree/FileContextMenu';

const fileItem: { name: string; type: 'file'; path: string } = { name: 'notes.md', type: 'file', path: '/proj/notes.md' };

function renderRow(callbacks: { onClick?: () => void; onDelete?: () => void } = {}) {
  return render(
    <FileContextMenu item={fileItem} onDelete={callbacks.onDelete}>
      <div onClick={callbacks.onClick}>notes.md</div>
    </FileContextMenu>,
  );
}

function pressAndHold(row: HTMLElement, x = 100, y = 200) {
  fireEvent.touchStart(row, { touches: [{ clientX: x, clientY: y }] });
  // The menu opens from the timer callback, so the clock must advance inside act.
  act(() => {
    vi.advanceTimersByTime(500);
  });
  fireEvent.touchEnd(row);
}

describe('FileContextMenu touch long press', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the menu with the delete action after a 500ms press', () => {
    renderRow();

    pressAndHold(screen.getByText('notes.md'));

    expect(screen.getByRole('menu')).toBeDefined();
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('does not open when the finger lifts before the threshold', () => {
    renderRow();

    fireEvent.touchStart(screen.getByText('notes.md'), { touches: [{ clientX: 100, clientY: 200 }] });
    vi.advanceTimersByTime(200);
    fireEvent.touchEnd(screen.getByText('notes.md'));
    vi.advanceTimersByTime(500);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not open when the finger moves away (scrolling)', () => {
    renderRow();

    fireEvent.touchStart(screen.getByText('notes.md'), { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(screen.getByText('notes.md'), { touches: [{ clientX: 100, clientY: 300 }] });
    vi.advanceTimersByTime(500);
    fireEvent.touchEnd(screen.getByText('notes.md'));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not click the row through after a long press', () => {
    const onClick = vi.fn();
    renderRow({ onClick });

    pressAndHold(screen.getByText('notes.md'));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('still opens from a right click like on desktop', () => {
    renderRow();

    fireEvent.contextMenu(screen.getByText('notes.md'));

    expect(screen.getByRole('menu')).toBeDefined();
  });
});
