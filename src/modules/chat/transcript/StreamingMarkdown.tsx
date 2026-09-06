import { useMemo } from 'react';

import { MarkdownBody } from '@/modules/chat/transcript/Markdown';
import { splitStreamingMarkdown } from '@/modules/chat/utils/streamingMarkdown';

type StreamingMarkdownProps = {
  children: string;
  className?: string;
};

/**
 * Used by MessageComponent to render an assistant reply that is still streaming
 * in. The accumulated text is cut at the last safe block boundary; the settled
 * half is byte-stable between ticks, so its MarkdownBody memo hit skips the
 * re-parse and each 100ms tick only re-parses the pending tail. Both halves
 * render as direct children of one prose container, so block spacing matches a
 * single-document render.
 */
export function StreamingMarkdown({ children, className }: StreamingMarkdownProps) {
  const { settled, pending } = useMemo(() => splitStreamingMarkdown(children), [children]);
  return (
    <div className={className}>
      {settled ? <MarkdownBody>{settled}</MarkdownBody> : null}
      {pending ? <MarkdownBody>{pending}</MarkdownBody> : null}
    </div>
  );
}
