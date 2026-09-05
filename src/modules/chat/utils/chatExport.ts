import type { ChatMessage, LLMProvider, Project, DiffLine } from '@/shared/types';
import { buildTranscriptHtml } from '@/modules/chat/export/buildTranscriptHtml';
import { buildTranscriptMarkdown } from '@/modules/chat/export/buildTranscriptMarkdown';

/**
 * Helper to download a blob as a file.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Get all export formats available.
 */
export const EXPORT_FORMATS = [
  { id: 'markdown', label: 'Markdown (.md)', ext: '.md' },
  { id: 'html', label: 'Web Page (.html)', ext: '.html' },
  { id: 'pdf', label: 'PDF (Print to File)', ext: '.pdf' },
] as const;

// ─── Unified transcript export (upstream API) ───────────────────────────────

export type TranscriptExportFormat = 'html' | 'markdown' | 'json';

export type TranscriptExportInput = {
  messages: ChatMessage[];
  sessionTitle: string;
  provider: LLMProvider | string;
  selectedProject?: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
};

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
  if (format === 'json') {
    return `${JSON.stringify(
      {
        title: input.sessionTitle,
        provider: input.provider,
        exportedAt: exportedAt.toISOString(),
        messageCount: input.messages.length,
        messages: input.messages,
      },
      null,
      2,
    )}\n`;
  }

  if (format === 'markdown') {
    return buildTranscriptMarkdown({
      messages: input.messages,
      sessionTitle: input.sessionTitle,
      provider: input.provider,
      exportedAt,
      createDiff: input.createDiff,
    });
  }

  return buildTranscriptHtml({
    messages: input.messages,
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

  downloadBlob(new Blob([content], { type: EXPORT_MIME_TYPES[format] }), filename);
}

/**
 * Opens the transcript document in a new window and brings up the browser's
 * print dialog — "Save as PDF" from there produces the archive copy. The
 * document's beforeprint listener expands every folded section first, so the
 * frozen PDF cannot silently lose collapsed content.
 */
export async function downloadPDF(input: TranscriptExportInput): Promise<void> {
  const exportedAt = new Date();
  const html = await buildTranscriptHtml({
    messages: input.messages,
    createDiff: input.createDiff,
    provider: input.provider,
    selectedProject: input.selectedProject,
    sessionTitle: input.sessionTitle,
    exportedAt,
  });

  const win = window.open('', '', 'width=900,height=700');
  if (!win) {
    window.alert('PDF export could not start because the browser blocked the popup. Allow popups and try again.');
    return;
  }

  win.document.write(html);
  win.document.close();
  // Delay the dialog until the written document has settled.
  setTimeout(() => {
    win.print();
  }, 250);
}
