/**
 * Reasoning primitive tests.
 *
 * A reader who unfolds a thought block must keep it unfolded: the block's
 * one-shot auto-close used to re-arm when it was opened after the stream had
 * ended, snapping the content shut a second later so only a second click
 * stuck. These tests pin manual-tap-wins and keep the auto-close for blocks
 * the reader never touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/shared/ui/ReasoningFork';

type ReasoningTreeProps = {
  isStreaming?: boolean;
  defaultOpen?: boolean;
};

function reasoningTree({ isStreaming, defaultOpen }: ReasoningTreeProps) {
  return (
    <Reasoning isStreaming={isStreaming} defaultOpen={defaultOpen}>
      <ReasoningTrigger />
      <ReasoningContent>reasoning text</ReasoningContent>
    </Reasoning>
  );
}

const trigger = () => screen.getByRole('button');

describe('ReasoningFork', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a thought that was unfolded after its stream ended open', () => {
    vi.useFakeTimers();
    const view = render(reasoningTree({ defaultOpen: false, isStreaming: true }));

    // The stream ends while the block is still folded…
    view.rerender(reasoningTree({ defaultOpen: false, isStreaming: false }));
    // …and only then does the reader unfold it.
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a thought unfolded during streaming open when the stream ends', () => {
    vi.useFakeTimers();
    const view = render(reasoningTree({ defaultOpen: false, isStreaming: true }));

    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    view.rerender(reasoningTree({ defaultOpen: false, isStreaming: false }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('still auto-closes a block the reader never touched', () => {
    vi.useFakeTimers();
    const view = render(reasoningTree({ isStreaming: true }));
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    view.rerender(reasoningTree({ isStreaming: false }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});
