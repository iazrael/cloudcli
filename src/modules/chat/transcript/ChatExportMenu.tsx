import { Download, FileJson, FileText, type LucideIcon } from 'lucide-react';

import type { ChatMessage, DiffLine } from '@/shared/types';
import { ActionMenu, type ActionMenuItem } from '@/shared/ui/ActionMenu';
import { downloadTranscriptExport, downloadPDF, getAvailableExportFormats, type EXPORT_FORMATS } from '@/modules/chat/utils/chatExport';

type ChatExportMenuProps = {
  messages: ChatMessage[];
  sessionTitle?: string;
  provider?: string;
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
export default function ChatExportMenu({ messages, sessionTitle, provider, createDiff }: ChatExportMenuProps) {
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
        });
      } else {
        await downloadTranscriptExport(format, {
          messages,
          sessionTitle: sessionTitle || 'chat',
          provider: provider || 'claude',
          createDiff,
        });
      }
    } catch (error) {
      // ActionMenu drops onSelect's returned promise, so without this the
      // export would fail silently — no download and no sign anything was attempted.
      console.error(`Chat export as ${format} failed`, error);
      window.alert(`Export as ${format} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const items: ActionMenuItem[] = getAvailableExportFormats().map((format) => ({
    key: format.id,
    label: format.label,
    icon: FORMAT_ICONS[format.id],
    onSelect: () => void handleExport(format.id),
  }));

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
      header={<div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Export as:</div>}
    />
  );
}
