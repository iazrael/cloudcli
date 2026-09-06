import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { StreamingMarkdown } from '@/modules/chat/transcript/StreamingMarkdown';

/**
 * Pins the streaming render contract: the settled prefix and the pending tail
 * render as two memo bodies inside one prose container, and a tick that only
 * grows the tail must not re-render the settled body — its markdown parse is
 * the expense this component exists to skip.
 */

const { renderCounts } = vi.hoisted(() => ({
  renderCounts: new Map<string, number>(),
}));

vi.mock('@/modules/chat/transcript/Markdown', async () => {
  const React = await import('react');
  return {
    Markdown: ({ children }: { children: string }) => (
      <div data-testid="markdown-static">{children}</div>
    ),
    MarkdownBody: React.memo(function MarkdownBody({ children }: { children: string }) {
      renderCounts.set(children, (renderCounts.get(children) ?? 0) + 1);
      return <div data-testid="markdown-body">{children}</div>;
    }),
  };
});

afterEach(() => {
  renderCounts.clear();
});

const SETTLED = '# Title\n\nIntro paragraph is done\n\n';

describe('StreamingMarkdown', () => {
  it('renders a message with no safe boundary as one pending body', () => {
    const view = render(<StreamingMarkdown className="prose">{'one block, still writing'}</StreamingMarkdown>);

    expect(view.getAllByTestId('markdown-body')).toHaveLength(1);
    expect(view.getAllByTestId('markdown-body')[0].textContent).toBe('one block, still writing');
    expect(view.container.firstElementChild?.className).toBe('prose');
  });

  it('keeps the settled body un-re-rendered while only the tail grows', () => {
    const view = render(<StreamingMarkdown className="prose">{`${SETTLED}And the tail`}</StreamingMarkdown>);

    const bodies = view.getAllByTestId('markdown-body');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].textContent).toBe(SETTLED);
    expect(bodies[1].textContent).toBe('And the tail');

    view.rerender(<StreamingMarkdown className="prose">{`${SETTLED}And the tail keeps growing`}</StreamingMarkdown>);

    expect(view.getAllByTestId('markdown-body')).toHaveLength(2);
    expect(view.getAllByTestId('markdown-body')[0].textContent).toBe(SETTLED);
    expect(view.getAllByTestId('markdown-body')[1].textContent).toBe('And the tail keeps growing');
    expect(renderCounts.get(SETTLED)).toBe(1);
    expect(renderCounts.get('And the tail')).toBe(1);
    expect(renderCounts.get('And the tail keeps growing')).toBe(1);
  });

  it('absorbs the tail into the settled half once a block completes', () => {
    const view = render(<StreamingMarkdown className="prose">{'Para A\n\nPara B'}</StreamingMarkdown>);
    expect(view.getAllByTestId('markdown-body').map((body) => body.textContent)).toEqual([
      'Para A\n\n',
      'Para B',
    ]);

    view.rerender(<StreamingMarkdown className="prose">{'Para A\n\nPara B\n\n'}</StreamingMarkdown>);

    const bodies = view.getAllByTestId('markdown-body');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].textContent).toBe('Para A\n\nPara B\n\n');
  });

  it('keeps an unclosed fence entirely in the pending half', () => {
    const content = '```ts\nconst x = 1';
    const view = render(<StreamingMarkdown className="prose">{content}</StreamingMarkdown>);

    const bodies = view.getAllByTestId('markdown-body');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].textContent).toBe('```ts\nconst x = 1');
  });
});
