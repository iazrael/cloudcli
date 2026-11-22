import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Virtualizer } from 'virtua';
import type { VirtualizerHandle } from 'virtua';

import type { ChatMessage, Project, ProjectSession, LLMProvider } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import { observeScrollStuck } from '@/shared/diagnostics/scrollScreening';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

/**
 * Pixels rendered beyond each edge of the viewport. virtua's 200px default is
 * sized for cheap rows; transcript rows (markdown, code, tool groups) take long
 * enough to render that an iOS momentum flick, which the compositor advances
 * thousands of pixels without waiting for JS, outruns it and shows a blank band.
 */
const TRANSCRIPT_BUFFER_PX = 1200;

/**
 * Viewports of rows kept mounted around the reading position. virtua applies
 * its buffer only on the side being scrolled toward: reading downward drops
 * everything above the viewport the moment it leaves the edge, so scrolling
 * back a few hundred pixels to re-read lands in unmounted rows, and remounting
 * heavy transcript rows takes seconds on a phone. `keepMounted` is unioned into
 * the mounted range on every render, so a window of indexes slid along behind
 * the scroll offset keeps those rows alive. Retention only postpones unmount
 * (the rows were already mounted) — it never mounts rows ahead of the scroll.
 */
const RETAIN_VIEWPORTS = 3;

/**
 * Minimum time between retention window updates. Each update is one pane
 * render; scrolling fires events far faster than the window needs to slide.
 */
const RETAIN_UPDATE_INTERVAL_MS = 250;

type ChatMessagesPaneProps = {
  /** The scroll container, owned by `useTranscriptViewport`. */
  scrollRef: RefObject<HTMLDivElement>;
  /** virtua's handle, owned by `useTranscriptViewport`. */
  virtualizerRef: RefObject<VirtualizerHandle>;
  onScroll: (offset: number) => void;
  /** True for the commit that prepends older history. */
  shiftOnPrepend: boolean;
  /** The grouped transcript rows, already windowed by the session state. */
  transcriptItems: MessageListItem[];
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  /** The full transcript, for the export menu. */
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  provider: LLMProvider;
  /** Present when the provider supports editing an already-sent message. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Why editing is unavailable right now; renders the edit control disabled with this tooltip. */
  editDisabledReason?: string;
  /** Present when the provider supports forking the session from a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  isLoadingMoreMessages: boolean;
  /** Row a search jump landed on, flashed to orient the reader. */
  highlightedItemIndex: number | null;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
}

/**
 * True when the plain row at `index` is the last assistant message of its
 * turn: no other assistant message stands between it and the next user row
 * (or the end of the list). Tool groups don't count — only prose rows carry
 * the per-turn fork control, so interleaved tool runs can't displace it.
 *
 * Consumed by ChatMessagesPane to decide which single row of a turn renders
 * the fork entry point.
 */
function isTurnFinalAssistantRow(items: MessageListItem[], index: number): boolean {
  const item = items[index];
  if (isToolGroupItem(item) || item.type !== 'assistant') {
    return false;
  }
  for (let later = index + 1; later < items.length; later++) {
    const next = items[later];
    if (isToolGroupItem(next)) {
      continue;
    }
    if (next.type === 'assistant') {
      return false;
    }
    if (next.type === 'user') {
      break;
    }
  }
  return true;
}

/**
 * The transcript. Rows are virtualized by virtua against the scroll container
 * owned by `useTranscriptViewport`: only rows near the viewport are in the
 * DOM, and virtua measures each one as it mounts, correcting the scroll offset
 * so the content the reader is looking at never moves.
 *
 * Row spacing lives on each row (`pt-*`) rather than on the container, so
 * nothing sits between the scroll container's top edge and the first row —
 * a container padding or a flow-level header would offset virtua's whole
 * index-to-offset mapping. The export menu is therefore a zero-height sticky
 * layer, not a flow element.
 */
function ChatMessagesPane({
  scrollRef,
  virtualizerRef,
  onScroll,
  shiftOnPrepend,
  transcriptItems,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  provider,
  onEditMessage,
  editDisabledReason,
  onForkFromMessage,
  isLoadingMoreMessages,
  highlightedItemIndex,
  createDiff,
  onFileOpen,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  // 真实聊天入口统一提供项目身份与会话记录的运行工作树，普通消息、流式消息和工具结果都继承它们。
  const markdownWorkspace = useMemo(
    () => ({ projectId: selectedProject.projectId, worktreePath: selectedSession?.worktreePath ?? null }),
    [selectedProject.projectId, selectedSession?.worktreePath],
  );

  // Rows [lo, hi] retained around the last tracked reading position, fed to
  // keepMounted so virtua unions them into the mounted range (see
  // RETAIN_VIEWPORTS above). Null before the first scroll.
  const [retainedRange, setRetainedRange] = useState<[number, number] | null>(null);
  const lastRetainUpdateRef = useRef(0);

  // A session switch replaces transcriptItems wholesale; stale indexes would
  // pin the wrong rows until the next scroll, so drop the window instead. The
  // reset runs during render (React's derived-state pattern) so the very first
  // render of the new session is already clean.
  const sessionId = selectedSession?.id ?? null;
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setRetainedRange(null);
  }

  const trackRetention = useCallback(
    (offset: number) => {
      const virtualizer = virtualizerRef.current;
      if (!virtualizer) return;
      const now = Date.now();
      if (now - lastRetainUpdateRef.current < RETAIN_UPDATE_INTERVAL_MS) return;
      const viewportSize = virtualizer.viewportSize;
      const count = transcriptItems.length;
      if (!viewportSize || count === 0) return;
      lastRetainUpdateRef.current = now;

      const anchor = virtualizer.findItemIndex(offset);
      const retainPx = viewportSize * RETAIN_VIEWPORTS;
      let lo = anchor;
      // getItemOffset is ascending, so walk out while the previous row starts
      // inside the window. Offsets of never-measured rows are estimates; that
      // only skews the window size, never correctness.
      while (lo > 0 && virtualizer.getItemOffset(lo - 1) > offset - retainPx) lo--;
      const windowEnd = offset + viewportSize + retainPx;
      let hi = anchor;
      while (hi < count - 1 && virtualizer.getItemOffset(hi + 1) < windowEnd) hi++;

      // Returning the previous range when it is unchanged skips the render.
      setRetainedRange((previous) =>
        previous && previous[0] === lo && previous[1] === hi ? previous : [lo, hi],
      );
    },
    [transcriptItems.length, virtualizerRef],
  );

  const handlePaneScroll = useCallback(
    (offset: number) => {
      trackRetention(offset);
      onScroll(offset);
    },
    [onScroll, trackRetention],
  );

  const keepMounted = useMemo(() => {
    if (!retainedRange) return undefined;
    const [lo, hi] = retainedRange;
    const indexes: number[] = [];
    for (let index = lo; index <= hi; index++) indexes.push(index);
    return indexes;
  }, [retainedRange]);

  // Screens the touches that should have scrolled the transcript but did not,
  // so a report taken after "the list won't scroll" says which cause it was.
  useEffect(() => {
    const pane = scrollRef.current;
    return pane ? observeScrollStuck(pane) : undefined;
  }, [scrollRef]);

  // Stable, deterministic keys for the rows rendered this pass.
  //
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every
  // store update, so caching keys by object identity minted a brand-new key
  // for the *same* logical message on each prepend, remounting rows and
  // throwing away their measured heights. Deriving keys purely from this
  // render's ordered rows (intrinsic key, disambiguated by occurrence index on
  // collision) yields the same key for the same row order, so React preserves
  // the DOM nodes and virtua keeps its measurements.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of transcriptItems) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [transcriptItems]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // The row preceding each item, which MessageComponent uses for grouping
  // decisions, and the turn anchor it belongs to. Precomputed per commit
  // because virtua renders rows out of order and by index, so a row cannot
  // learn its predecessor from the render loop the way a full map could.
  const rowContext = useMemo(() => {
    const previousMessages: (ChatMessage | null)[] = [];
    const turnAnchors: (ChatMessage | null)[] = [];
    let previous: ChatMessage | null = null;
    let currentTurnAnchor: ChatMessage | null = null;

    for (const item of transcriptItems) {
      previousMessages.push(previous);
      if (isToolGroupItem(item)) {
        turnAnchors.push(currentTurnAnchor);
        previous = item.messages[item.messages.length - 1] || previous;
        continue;
      }
      if (item.type === 'user' && item.transcriptAnchorId) {
        currentTurnAnchor = item;
      }
      turnAnchors.push(currentTurnAnchor);
      previous = item;
    }

    return { previousMessages, turnAnchors };
  }, [transcriptItems]);

  const renderRow = useCallback((item: MessageListItem, index: number) => {
    const rowKey = isToolGroupItem(item)
      ? `tool-group-${getMessageKey(item.messages[0])}`
      : getMessageKey(item);
    const highlightClass = index === highlightedItemIndex ? ' search-highlight-flash' : '';

    return (
      <div
        key={rowKey}
        data-anchor-id={rowKey}
        className={`pt-3 sm:pt-4${highlightClass}`}
      >
        {isToolGroupItem(item) ? (
          <ToolGroupContainer
            group={item}
            prevMessage={rowContext.previousMessages[index]}
            createDiff={createDiff}
            getMessageKey={getMessageKey}
            onFileOpen={onFileOpen}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
          />
        ) : (
          <MessageComponent
            message={item}
            prevMessage={rowContext.previousMessages[index]}
            turnAnchorMessage={rowContext.turnAnchors[index]}
            isTurnFinalAssistant={isTurnFinalAssistantRow(transcriptItems, index)}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            isThinkingStreaming={
              isProcessing && index === transcriptItems.length - 1 && Boolean(item.isThinking)
            }
            selectedProject={selectedProject}
            provider={provider}
            onEditMessage={onEditMessage}
            editDisabledReason={editDisabledReason}
            onForkFromMessage={onForkFromMessage}
          />
        )}
      </div>
    );
  }, [
    createDiff,
    getMessageKey,
    highlightedItemIndex,
    isProcessing,
    onEditMessage,
    editDisabledReason,
    onFileOpen,
    onForkFromMessage,
    provider,
    rowContext,
    selectedProject,
    showRawParameters,
    showThinking,
    transcriptItems,
  ]);

  return (
    <div
      ref={scrollRef}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {/* Zero-height so it adds no offset ahead of the virtualized rows. */}
      <div className="pointer-events-none sticky top-3 z-10 flex h-0 justify-end pr-4 sm:pr-4">
        <div className="pointer-events-auto">
          <ChatExportMenu
            messages={chatMessages}
            sessionTitle={selectedSession?.title}
            provider={selectedSession?.provider || provider}
            sessionId={selectedSession?.id ?? null}
            createDiff={createDiff}
          />
        </div>
      </div>

      {/* Older-history spinner floats over the top edge, for the same reason. */}
      {isLoadingMoreMessages && (
        <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-center">
          <div className="mt-2 flex items-center space-x-2 rounded-full bg-background/90 px-3 py-1 shadow-sm">
            <div className="h-3 w-3 animate-spin rounded-full border-b-2 border-gray-400" />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('session.loading.olderMessages')}
            </p>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-[54.25rem] px-4">
        <MarkdownWorkspaceContext.Provider value={markdownWorkspace}>
          <Virtualizer
            ref={virtualizerRef}
            scrollRef={scrollRef}
            shift={shiftOnPrepend}
            bufferSize={TRANSCRIPT_BUFFER_PX}
            keepMounted={keepMounted}
            onScroll={handlePaneScroll}
            data={transcriptItems}
          >
            {renderRow}
          </Virtualizer>
        </MarkdownWorkspaceContext.Provider>
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
