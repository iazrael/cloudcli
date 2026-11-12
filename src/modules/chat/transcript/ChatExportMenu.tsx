import { useState } from 'react';
import { Download, FileJson, FileText, Stethoscope, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, DiffLine } from '@/shared/types';
import { ActionMenu, type ActionMenuItem } from '@/shared/ui/ActionMenu';
import { downloadTranscriptExport, downloadPDF, getAvailableExportFormats, type EXPORT_FORMATS } from '@/modules/chat/utils/chatExport';
import { downloadDiagnosticsReport } from '@/shared/diagnostics/diagnosticsReport';

type ChatExportMenuProps = {
  messages: ChatMessage[];
  sessionTitle?: string;
  provider?: string;
  /** The session the diagnostics report describes; without it the report is frames only. */
  sessionId?: string | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
};

const FORMAT_ICONS: Record<(typeof EXPORT_FORMATS)[number]['id'], LucideIcon> = {
  markdown: FileText,
  html: FileJson,
  pdf: FileJson,
};

/**
 * Used by ChatMessagesPane as the transcript download control above the
 * message list. The menu itself is the shared ActionMenu: a document-level
 * outside-click listener closes it, which a fixed full-screen overlay inside
 * the scroll container could not be trusted to do (stacking contexts and
 * containing blocks quietly break that trick).
 */
export default function ChatExportMenu({ messages, sessionTitle, provider, sessionId, createDiff }: ChatExportMenuProps) {
  const { t } = useTranslation('chat');
  // Whether the side-question asides go into the file (upstream #1673). Off
  // by default, so a plain export matches what the session itself saw; the
  // operator opts in from this option.
  const [includeSideQuestions, setIncludeSideQuestions] = useState(false);

  if (messages.length === 0) {
    return null;
  }

  const handleExport = async (format: 'markdown' | 'html' | 'pdf') => {
    try {
      if (format === 'pdf') {
        await downloadPDF({
          messages,
          sessionTitle: sessionTitle || 'chat',
          provider: provider || 'claude',
          createDiff,
          includeSideQuestions,
        });
      } else {
        await downloadTranscriptExport(format, {
          messages,
          sessionTitle: sessionTitle || 'chat',
          provider: provider || 'claude',
          createDiff,
          includeSideQuestions,
        });
      }
    } catch (error) {
      // ActionMenu drops onSelect's returned promise, so without this the
      // export would fail silently — no download and no sign anything was attempted.
      console.error(`Chat export as ${format} failed`, error);
      window.alert(`Export as ${format} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const items: ActionMenuItem[] = [
    ...getAvailableExportFormats().map((format) => ({
      key: format.id,
      label: format.label,
      icon: FORMAT_ICONS[format.id],
      onSelect: () => void handleExport(format.id),
    })),
    {
      // Not a transcript format: it is what the transcript cannot show —
      // the frames that produced it and the rows the client is holding.
      key: 'diagnostics',
      label: 'Diagnostics (.json)',
      icon: Stethoscope,
      onSelect: () => void downloadDiagnosticsReport(sessionId ?? null),
    },
  ];

  return (
    <ActionMenu
      label="Export chat"
      ariaLabel="Export chat"
      items={items}
      icon={Download}
      iconOnly
      variant="outline"
      size="sm"
      triggerClassName="h-8 w-8 rounded-lg border-border/50 p-0 text-muted-foreground hover:text-foreground"
      header={
        <div className="space-y-1.5 border-b border-border px-3 py-2">
          <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Export as:</div>
          {/*
            The side-question asides are not part of the session, so the file
            leaves them out unless this stays on. It is drawn as a checkbox
            (not a menu item) so it does not close the menu when toggled.
          */}
          <label className="flex cursor-pointer select-none items-center gap-2 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={includeSideQuestions}
              onChange={(event) => setIncludeSideQuestions(event.target.checked)}
            />
            {t('export.includeSideQuestions', { defaultValue: 'Include side questions' })}
          </label>
        </div>
      }
    />
  );
}
