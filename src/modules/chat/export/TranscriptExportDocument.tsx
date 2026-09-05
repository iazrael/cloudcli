import { I18nextProvider } from 'react-i18next';

import { i18n } from '@/modules/i18n';
import type { ChatMessage, DiffLine, LLMProvider, Project } from '@/shared/types';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';

type TranscriptExportDocumentProps = {
  messages: ChatMessage[];
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  provider: LLMProvider | string;
  selectedProject?: Project | null;
};

/**
 * The transcript, rendered for a document instead of a screen.
 *
 * It deliberately mounts the same `MessageComponent` / `ToolGroupContainer`
 * tree the chat pane uses. Every previous export was a second formatter that
 * only knew about `msg.type`, which is why tool calls — the bulk of an agent
 * transcript — came out as empty sections. Rendering the real components means
 * the export cannot fall behind the UI: a new tool renderer appears in it for
 * free.
 *
 * Rendered by `buildTranscriptHtml` through `renderToStaticMarkup`, so there
 * are no effects and no interactivity — anything the components hide behind
 * open state is force-shown via `TranscriptRenderContext`.
 */
export function TranscriptExportDocument({
  messages,
  createDiff,
  provider,
  selectedProject,
}: TranscriptExportDocumentProps) {
  // Everything renders, folded: the exported document is the complete record
  // of the conversation. Process content — thinking blocks, tool groups —
  // renders as native <details> collapsed by default (failures open), so the
  // record stays complete without burying the dialogue in noise.
  const grouped = groupConsecutiveTools(messages, true);

  // Derived per item from the preceding entry rather than accumulated in the
  // render loop, so the component body never reassigns a variable after render.
  const previousMessageOf = (index: number): ChatMessage | null => {
    if (index === 0) return null;
    const prev = grouped[index - 1];
    return isToolGroupItem(prev) ? prev.messages[prev.messages.length - 1] ?? null : prev;
  };

  return (
    <I18nextProvider i18n={i18n}>
      <TranscriptRenderContext.Provider value={{ isExporting: true }}>
        <div className="chat-export-transcript">
          {grouped.map((item, index) => {
            if (isToolGroupItem(item)) {
              return (
                <ToolGroupContainer
                  key={`group-${index}`}
                  group={item}
                  prevMessage={previousMessageOf(index)}
                  createDiff={createDiff}
                  getMessageKey={(message: ChatMessage) => String(message.timestamp)}
                  showRawParameters={false}
                  showThinking
                  selectedProject={selectedProject}
                  provider={provider}
                />
              );
            }

            return (
              <MessageComponent
                key={`message-${index}`}
                message={item}
                prevMessage={previousMessageOf(index)}
                createDiff={createDiff}
                showRawParameters={false}
                showThinking
                selectedProject={selectedProject}
                provider={provider}
              />
            );
          })}
        </div>
      </TranscriptRenderContext.Provider>
    </I18nextProvider>
  );
}
