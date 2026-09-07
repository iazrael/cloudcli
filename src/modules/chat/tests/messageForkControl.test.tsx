import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { I18nextProvider } from 'react-i18next';

import type * as UiPreferencesContext from '@/shared/context/UiPreferencesContext';
import { i18n } from '@/modules/i18n';
import type { ChatMessage } from '@/shared/types';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';

// Markdown reads theme preferences through this hook; the real reducer reads
// localStorage, pointless in jsdom. Stub the hook, keep the real module.
vi.mock('@/shared/context/UiPreferencesContext', async (importOriginal) => {
  const actual = await importOriginal<typeof UiPreferencesContext>();
  return {
    ...actual,
    useUiPreferences: () => ({ uiPreferences: { theme: 'light' }, setUiPreferences: () => undefined }),
  };
});

const createDiff = () => [];

const userMessage = {
  type: 'user',
  content: '开工',
  transcriptAnchorId: 'anchor-1',
  timestamp: new Date('2026-09-07T05:11:00.000Z'),
} as unknown as ChatMessage;

const thinkingMessage = {
  type: 'assistant',
  content: '先想想怎么改。',
  isThinking: true,
  timestamp: new Date('2026-09-07T05:11:15.000Z'),
} as unknown as ChatMessage;

const midTextMessage = {
  type: 'assistant',
  content: '两件事：改监听，再用浏览器验证。',
  timestamp: new Date('2026-09-07T05:11:16.000Z'),
} as unknown as ChatMessage;

const finalTextMessage = {
  type: 'assistant',
  content: '完成了，浏览器验证通过。',
  timestamp: new Date('2026-09-07T05:12:00.000Z'),
} as unknown as ChatMessage;

function renderRow(message: ChatMessage, prevMessage: ChatMessage | null, isTurnFinalAssistant?: boolean) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MessageComponent
        message={message}
        prevMessage={prevMessage}
        turnAnchorMessage={userMessage}
        isTurnFinalAssistant={isTurnFinalAssistant}
        createDiff={createDiff}
        showThinking
        provider="claude"
        onForkFromMessage={vi.fn()}
      />
    </I18nextProvider>,
  );
}

describe('per-turn fork control placement', () => {
  it('renders no fork row under a turn-leading thinking block', () => {
    const { container } = renderRow(thinkingMessage, userMessage, false);
    expect(container.textContent).toContain('先想想怎么改。');
    expect(screen.queryByTitle('Fork from here')).toBeNull();
  });

  it('renders no fork on an intermediate prose segment', () => {
    const { container } = renderRow(midTextMessage, thinkingMessage, false);
    expect(container.textContent).toContain('两件事');
    expect(screen.queryByTitle('Fork from here')).toBeNull();
  });

  it('renders exactly one fork on the final assistant row, targeting the turn anchor', () => {
    const onForkFromMessage = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <MessageComponent
          message={finalTextMessage}
          prevMessage={midTextMessage}
          turnAnchorMessage={userMessage}
          isTurnFinalAssistant
          createDiff={createDiff}
          showThinking
          provider="claude"
          onForkFromMessage={onForkFromMessage}
        />
      </I18nextProvider>,
    );
    const fork = screen.getByTitle('Fork from here');
    fireEvent.click(fork);
    expect(onForkFromMessage).toHaveBeenCalledTimes(1);
    expect(onForkFromMessage).toHaveBeenCalledWith(userMessage);
  });
});
