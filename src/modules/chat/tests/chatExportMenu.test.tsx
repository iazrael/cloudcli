import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ChatMessage } from '@/shared/types';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';

const userMessage: ChatMessage = {
  type: 'user',
  content: 'hello',
  timestamp: new Date('2026-09-08T09:00:00.000Z'),
} as ChatMessage;

const props = {
  messages: [userMessage],
  sessionTitle: 'A conversation',
  provider: 'claude',
  createDiff: () => [],
};

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Export chat' }));
}

describe('ChatExportMenu', () => {
  it('lists every format the environment can deliver', () => {
    render(<ChatExportMenu {...props} />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Markdown (.md)' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Web Page (.html)' })).toBeTruthy();
    // jsdom reports the desktop (non-standalone) mode, so PDF is offered.
    expect(screen.getByRole('menuitem', { name: 'PDF (Print to File)' })).toBeTruthy();
  });

  it('hides the print-only PDF option inside the installed PWA', () => {
    // The print flow needs a real popup; standalone mode cannot open one.
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);

    try {
      render(<ChatExportMenu {...props} />);
      openMenu();

      expect(screen.getByRole('menuitem', { name: 'Markdown (.md)' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: 'PDF (Print to File)' })).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closes when the user clicks anywhere else on the page', () => {
    render(<ChatExportMenu {...props} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Markdown (.md)' })).toBeTruthy();

    // A mousedown outside the menu — the route the old overlay approach kept
    // missing under the chat pane's stacking contexts.
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menuitem', { name: 'Markdown (.md)' })).toBeNull();
  });

  it('renders nothing without messages', () => {
    const { container } = render(<ChatExportMenu {...props} messages={[]} />);

    expect(container.firstChild).toBeNull();
  });
});
