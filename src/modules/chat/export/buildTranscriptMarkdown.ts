import type { ChatMessage, DiffLine, LLMProvider } from '@/shared/types';

type BuildTranscriptMarkdownInput = {
  messages: ChatMessage[];
  sessionTitle: string;
  provider: LLMProvider | string;
  exportedAt: Date;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  antigravity: 'Antigravity',
};

/** Fenced blocks need a longer fence than anything they contain. */
function fence(content: string): string {
  const longestRun = [...content.matchAll(/`{3,}/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    2,
  );
  return '`'.repeat(longestRun + 1);
}

function codeBlock(content: string, language = ''): string {
  const marker = fence(content);
  return `${marker}${language}\n${content}\n${marker}`;
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

/**
 * Renders a transcript as Markdown that reads well in a plain text editor and
 * on any Markdown host. It is pure dialogue — thinking and tool activity are
 * the process, not the conversation, and the HTML/JSON exports are the
 * complete record. Errors stay: they are conversation-level events.
 */
export function buildTranscriptMarkdown(input: BuildTranscriptMarkdownInput): string {
  const providerLabel = PROVIDER_LABELS[String(input.provider)] ?? 'Assistant';
  const sections: string[] = [];

  // Counted after filtering so the header describes the document, not the
  // session — a reader told "387 messages" over twenty dialogue rows would
  // think the export was truncated.
  let renderedCount = 0;

  for (const message of input.messages) {
    if (message.isThinking || message.isToolUse) {
      continue;
    }

    if (message.type === 'user') {
      sections.push('', `### You`, '', readString(message.content));
      if (message.images?.length) {
        sections.push('', `_${message.images.length} image attachment(s)_`);
      }
      if (message.files?.length) {
        sections.push('', `_Attached: ${message.files.map((file) => file.name).join(', ')}_`);
      }
      renderedCount += 1;
      continue;
    }

    if (message.type === 'error') {
      sections.push('', '### Error', '', codeBlock(readString(message.content)));
      renderedCount += 1;
      continue;
    }

    const content = readString(message.content);
    if (!content.trim()) {
      continue;
    }

    sections.push('', `### ${providerLabel}`, '', content);
    renderedCount += 1;
  }

  const header = [
    `# ${input.sessionTitle}`,
    '',
    `_${renderedCount} messages · exported ${input.exportedAt.toLocaleString()}_`,
    '',
    '---',
  ];

  return `${[...header, ...sections].join('\n').replace(/\n{4,}/g, '\n\n\n')}\n`;
}
