import assert from 'node:assert/strict';

import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import type * as UiPreferencesContext from '@/shared/context/UiPreferencesContext';
import { buildTranscriptExport, downloadPDF, toExportFileStem } from '@/modules/chat/utils/chatExport';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';

const createDiff = createCachedDiffCalculator();
const exportedAt = new Date('2026-08-24T09:30:00.000Z');

const userMessage: ChatMessage = {
  type: 'user',
  content: 'Please rename the helper',
  timestamp: new Date('2026-08-24T09:00:00.000Z'),
} as ChatMessage;

const assistantMessage: ChatMessage = {
  type: 'assistant',
  content: 'Done. Here is the change:\n\n```js\nconst renamed = 1;\n```',
  timestamp: new Date('2026-08-24T09:01:00.000Z'),
} as ChatMessage;

// A tool call is typed `assistant` with empty content, which is exactly why an
// exporter that branches on `type` alone loses all of them.
const editToolMessage: ChatMessage = {
  type: 'assistant',
  content: '',
  isToolUse: true,
  toolName: 'Edit',
  toolInput: JSON.stringify({
    file_path: '/repo/src/helper.js',
    old_string: 'const a = 1;\nconst b = 2;',
    new_string: 'const renamed = 1;\nconst b = 2;\nconst c = 3;',
  }),
  toolResult: { content: 'Applied 1 edit', isError: false },
  timestamp: new Date('2026-08-24T09:00:30.000Z'),
} as unknown as ChatMessage;

const input = {
  messages: [userMessage, editToolMessage, assistantMessage],
  sessionTitle: 'Rename the helper',
  provider: 'claude' as const,
  createDiff,
};

describe('markdown export', () => {
  it('is pure dialogue: tool calls are omitted entirely', async () => {
    const markdown = await buildTranscriptExport('markdown', input, exportedAt);

    expect(markdown).toContain('### You');
    expect(markdown).toContain('Please rename the helper');
    expect(markdown).toContain('### Claude');
    expect(markdown).toContain('const renamed = 1;');

    expect(markdown).not.toContain('`Edit`');
    expect(markdown).not.toContain('/repo/src/helper.js');
    expect(markdown).not.toContain('+const renamed = 1;');
    expect(markdown).not.toContain('Applied 1 edit');
  });

  it('counts only the messages it renders', async () => {
    const markdown = await buildTranscriptExport('markdown', input, exportedAt);

    // User + assistant turn; the Edit tool row between them is omitted.
    expect(markdown).toContain('_2 messages ·');
  });

  it('keeps the user and assistant turns', async () => {
    const zcodeMd = await buildTranscriptExport('markdown', { ...input, provider: 'zcode' }, exportedAt);
    expect(zcodeMd).toContain('### ZCode');

    const agyMd = await buildTranscriptExport('markdown', { ...input, provider: 'antigravity' }, exportedAt);
    expect(agyMd).toContain('### Antigravity');
  });

  it('fences an error block that already contains a fence', async () => {
    const markdown = await buildTranscriptExport('markdown', {
      ...input,
      messages: [{
        type: 'error',
        content: 'output containing ``` a fence',
        timestamp: new Date('2026-08-24T09:02:00.000Z'),
      } as ChatMessage],
    }, exportedAt);

    // A three-backtick fence would be closed early by the payload itself.
    expect(markdown).toContain('````');
  });
});

describe('json export', () => {
  it('carries every message unmodified', async () => {
    const json = JSON.parse(await buildTranscriptExport('json', input, exportedAt));

    assert.equal(json.messageCount, 3);
    assert.equal(json.messages.length, 3);
    assert.equal(json.messages[1].toolName, 'Edit');
    assert.equal(json.title, 'Rename the helper');
  });
});

describe('export filenames', () => {
  it('turns a session title into a safe stem', () => {
    assert.equal(
      toExportFileStem('Fix src/utils/date.ts "properly"', exportedAt),
      'fix-src-utils-date-ts-properly-2026-08-24',
    );
  });

  it('falls back when the title has nothing usable in it', () => {
    assert.equal(toExportFileStem('///', exportedAt), 'conversation-2026-08-24');
  });

  it('bounds a very long title', () => {
    const stem = toExportFileStem('word '.repeat(80), exportedAt);
    assert.ok(stem.length <= 60 + '-2026-08-24'.length);
  });
});

const bashToolMessage: ChatMessage = {
  type: 'assistant',
  content: '',
  isToolUse: true,
  toolName: 'Bash',
  toolInput: JSON.stringify({ command: 'npm test' }),
  toolResult: { content: 'ok 1 - everything passed', isError: false },
  timestamp: new Date('2026-08-24T09:00:45.000Z'),
} as unknown as ChatMessage;

describe('html export', () => {
  it('renders the real tool card rather than an empty section', async () => {
    const html = await buildTranscriptExport('html', input, exportedAt);

    // The diff viewer's own markup, not a re-implementation of it.
    expect(html).toContain('/repo/src/helper.js');
    expect(html).toContain('const renamed = 1;');
    // The `+N -M` badge the transcript shows on an edit.
    expect(html).toContain('2 lines added, 1 removed');
  });

  it('is a standalone document carrying the app’s own styles', async () => {
    const html = await buildTranscriptExport('html', input, exportedAt);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Rename the helper</title>');
    expect(html).toContain('3 messages');
    // No network dependency: everything is inline.
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('includes tool output that the live view only reveals on demand', async () => {
    const html = await buildTranscriptExport(
      'html',
      { ...input, messages: [bashToolMessage] },
      exportedAt,
    );

    expect(html).toContain('npm test');
    // A document has no chevron to click, so output that is merely present but
    // collapsed to zero height is output the reader can never reach.
    expect(html).toContain('ok 1 - everything passed');
    expect(html).not.toContain('grid-rows-[0fr]');
  });

  it('folds tool sections as native <details> the reader can expand', async () => {
    const html = await buildTranscriptExport('html', input, exportedAt);

    // No JavaScript in the file: the fold must be a native element.
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    // The Edit card's own markup (diff, badge) renders inside the fold.
    expect(html).toContain('2 lines added, 1 removed');
    expect(html).not.toContain('grid-rows-[0fr]');
  });

  it('expands failed tool groups while everything else stays folded', async () => {
    const failingBash: ChatMessage = {
      ...bashToolMessage,
      toolResult: { content: 'command not found', isError: true },
    } as unknown as ChatMessage;

    // Two consecutive Bash rows form a group; its failure opens the fold.
    const html = await buildTranscriptExport(
      'html',
      { ...input, messages: [bashToolMessage, failingBash] },
      exportedAt,
    );

    expect(html).toContain('<details open');
    expect(html).toContain('command not found');
  });

  it('folds sections the screen opens by default (todo checklist)', async () => {
    // TodoWrite is defaultOpen on screen — the export must still fold it:
    // caller defaults are a live-view concern, not a document concern.
    const todoWrite: ChatMessage = {
      type: 'assistant',
      content: '',
      isToolUse: true,
      toolName: 'TodoWrite',
      toolInput: JSON.stringify({ todos: [{ content: 'fix the export', status: 'completed', activeForm: 'fixing the export' }] }),
      toolResult: { content: 'ok', isError: false },
      timestamp: new Date('2026-08-24T09:03:00.000Z'),
    } as unknown as ChatMessage;

    const html = await buildTranscriptExport('html', {
      ...input,
      messages: [todoWrite],
    }, exportedAt);

    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });

  it('renders assistant markdown instead of escaping it', async () => {
    const html = await buildTranscriptExport('html', input, exportedAt);

    // The fenced block became real markup; the fence characters are gone.
    expect(html).toContain('<code');
    expect(html).not.toContain('```js');
  });

  it('escapes a session title that contains markup', async () => {
    const html = await buildTranscriptExport(
      'html',
      { ...input, sessionTitle: '<img src=x onerror=alert(1)>' },
      exportedAt,
    );

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('thinking content in exports', () => {
  const thinkingMessage: ChatMessage = {
    type: 'assistant',
    content: 'pondering the approach',
    isThinking: true,
    timestamp: new Date('2026-08-24T09:00:10.000Z'),
  } as ChatMessage;

  const assistantWithReasoning: ChatMessage = {
    type: 'assistant',
    content: 'Here is the answer.',
    reasoning: 'weighing option A',
    timestamp: new Date('2026-08-24T09:01:00.000Z'),
  } as ChatMessage;

  const thinkingInput = {
    ...input,
    messages: [thinkingMessage, assistantWithReasoning],
  };

  it('omits thinking rows and reasoning from markdown', async () => {
    const markdown = await buildTranscriptExport('markdown', thinkingInput, exportedAt);

    expect(markdown).not.toContain('pondering the approach');
    expect(markdown).not.toContain('weighing option A');
    expect(markdown).not.toContain('Reasoning');
    expect(markdown).toContain('Here is the answer.');
  });

  it('keeps thinking rows and reasoning in html, folded shut', async () => {
    const html = await buildTranscriptExport('html', thinkingInput, exportedAt);

    // The document is the complete record: thinking stays, as a closed fold.
    expect(html).toContain('pondering the approach');
    expect(html).toContain('weighing option A');
    expect(html).toContain('Here is the answer.');
  });
});

describe('pdf export', () => {
  it('writes the transcript document into a print window', async () => {
    const written: string[] = [];
    const fakeWindow = {
      document: {
        write: (html: string) => written.push(html),
        close: () => undefined,
      },
      print: () => undefined,
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);
    vi.useFakeTimers();

    try {
      await downloadPDF(input);
      vi.runAllTimers();

      assert.equal(openSpy.mock.calls.length, 1);
      assert.equal(written.length, 1);
      // The same complete document the HTML export produces, including the
      // print-time expansion that keeps folded sections out of a frozen PDF.
      expect(written[0]).toContain('<details');
      expect(written[0]).toContain("window.addEventListener('beforeprint'");
      expect(written[0]).toContain('<title>Rename the helper</title>');
    } finally {
      vi.useRealTimers();
      openSpy.mockRestore();
    }
  });

  it('alerts when the popup is blocked instead of failing silently', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

    try {
      await downloadPDF(input);
      expect(alertSpy.mock.calls.length).toBe(1);
    } finally {
      openSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });
});

// The theme hook runs for real: the export's static render tree must provide
// every context the live transcript reads (theme included), or exporting a
// conversation that contains any code block rejects with no user-visible error.
vi.mock('@/shared/context/UiPreferencesContext', async (importOriginal) => {
  // Keep the real provider so buildTranscriptHtml's wrapper works; only the
  // hook is stubbed (its reducer reads localStorage, pointless in jsdom).
  const actual = await importOriginal<typeof UiPreferencesContext>();
  return {
    ...actual,
    useUiPreferences: () => ({ uiPreferences: { theme: 'light' }, setUiPreferences: () => undefined }),
  };
});
