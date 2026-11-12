import type { ChatMessage, LLMProvider, Project, DiffLine } from '@/shared/types';
import { collectStoredOutputAssets, saveOrShareBlob } from '@/shared/utils';
import { api } from '@/shared/api';
import { buildTranscriptHtml } from '@/modules/chat/export/buildTranscriptHtml';
import { buildTranscriptMarkdown } from '@/modules/chat/export/buildTranscriptMarkdown';

/**
 * Get all export formats available.
 */
export const EXPORT_FORMATS = [
  { id: 'markdown', label: 'Markdown (.md)', ext: '.md' },
  { id: 'html', label: 'Web Page (.html)', ext: '.html' },
  { id: 'pdf', label: 'PDF (Print to File)', ext: '.pdf' },
] as const;

/**
 * The PDF export prints from a window.open popup, and a popup only exists
 * outside the installed app: in standalone mode iOS "opens" it by navigating
 * the current webview, replacing the whole app with a page that has no way
 * back. Offer the option only where a print window can actually appear.
 */
export function isPrintExportSupported(): boolean {
  return !window.matchMedia?.('(display-mode: standalone)').matches;
}

/** The export formats this environment can actually deliver. */
export function getAvailableExportFormats() {
  return isPrintExportSupported()
    ? EXPORT_FORMATS
    : EXPORT_FORMATS.filter((format) => format.id !== 'pdf');
}

// ─── Unified transcript export (upstream API) ───────────────────────────────

export type TranscriptExportFormat = 'html' | 'markdown' | 'json';

export type TranscriptExportInput = {
  messages: ChatMessage[];
  sessionTitle: string;
  provider: LLMProvider | string;
  selectedProject?: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  /**
   * Keep side question asides in the file (upstream #1673). Off by default:
   * an aside is not part of the session, so a default export matches what
   * the session itself saw, and the operator opts in from the export menu.
   */
  includeSideQuestions?: boolean;
};

/** True when the export should drop the side question aside rows and the rows that pair with them. */
function isSideQuestionRow(message: ChatMessage): boolean {
  return Boolean(message.sideQuestion);
}

const EXPORT_EXTENSIONS: Record<TranscriptExportFormat, string> = {
  html: 'html',
  markdown: 'md',
  json: 'json',
};

const EXPORT_MIME_TYPES: Record<TranscriptExportFormat, string> = {
  html: 'text/html;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  json: 'application/json;charset=utf-8',
};

/** Makes a session title safe to use as a filename. */
export function toExportFileStem(sessionTitle: string, exportedAt: Date): string {
  const date = exportedAt.toISOString().slice(0, 10);
  const slug = sessionTitle
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  return slug ? `${slug}-${date}` : `conversation-${date}`;
}


/** Builds the file's text without downloading it, so it can be asserted on. */
export async function buildTranscriptExport(
  format: TranscriptExportFormat,
  input: TranscriptExportInput,
  exportedAt: Date,
): Promise<string> {
  const messages = input.includeSideQuestions
    ? input.messages
    : input.messages.filter((message) => !isSideQuestionRow(message));

  if (format === 'json') {
    const references = collectStoredOutputAssets(JSON.stringify(messages));
    const assets = await api.assets.embedForExport(references);
    return `${JSON.stringify(
      {
        title: input.sessionTitle,
        provider: input.provider,
        exportedAt: exportedAt.toISOString(),
        messageCount: messages.length,
        messages,
        ...(references.length > 0 ? { assets } : {}),
      },
      null,
      2,
    )}\n`;
  }

  if (format === 'markdown') {
    return buildTranscriptMarkdown({
      messages,
      sessionTitle: input.sessionTitle,
      provider: input.provider,
      exportedAt,
      createDiff: input.createDiff,
    });
  }

  return buildTranscriptHtml({
    messages,
    createDiff: input.createDiff,
    provider: input.provider,
    selectedProject: input.selectedProject,
    sessionTitle: input.sessionTitle,
    exportedAt,
  });
}

export async function downloadTranscriptExport(
  format: TranscriptExportFormat,
  input: TranscriptExportInput,
): Promise<void> {
  const exportedAt = new Date();
  const content = await buildTranscriptExport(format, input, exportedAt);
  const filename = `${toExportFileStem(input.sessionTitle, exportedAt)}.${EXPORT_EXTENSIONS[format]}`;

  await saveOrShareBlob(new Blob([content], { type: EXPORT_MIME_TYPES[format] }), filename);
}

/**
 * Opens the transcript document in a new window and brings up the browser's
 * print dialog — "Save as PDF" from there produces the archive copy. The
 * document's beforeprint listener expands every folded section first, so the
 * frozen PDF cannot silently lose collapsed content.
 */
export async function downloadPDF(input: TranscriptExportInput): Promise<void> {
  // Open before any await: Safari only lets a window.open through while it is
  // still inside the click's user-gesture window, and building the document
  // first (the react-dom/server load included) can outlast it — the first
  // click was being swallowed by the popup blocker, the second one worked.
  const win = window.open('', '', 'width=900,height=700');
  if (!win) {
    window.alert('PDF export could not start because the browser blocked the popup. Allow popups and try again.');
    return;
  }

  const exportedAt = new Date();
  let html: string;
  try {
    html = await buildTranscriptHtml({
      messages: input.messages,
      createDiff: input.createDiff,
      provider: input.provider,
      selectedProject: input.selectedProject,
      sessionTitle: input.sessionTitle,
      exportedAt,
    });
  } catch (error) {
    // Don't leave the already-opened window sitting there blank.
    win.close();
    throw error;
  }

  win.document.write(html);
  win.document.close();
  // Delay the dialog until the written document has settled.
  setTimeout(() => {
    win.print();
  }, 250);
}
