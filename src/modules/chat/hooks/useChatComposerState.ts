import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '@/shared/api';
import { createClientRequestId, isEnginePromptCommand } from '@/shared/utils';
import type { MarkSessionProcessing, SessionActivityMap } from '@/shared/types';
import { useProviderCapabilitiesMap } from '@/shared/hooks/useProviderCapabilities';
import { uploadAttachmentFiles } from '@/modules/chat/utils/attachmentUpload';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  clearQueuedCompact,
  clearQueuedMessage,
  readProviderToolsSettings,
  readQueuedCompact,
  readQueuedMessage,
  safeLocalStorage,
  writeQueuedCompact,
  writeQueuedMessage,
  type QueuedSendOptions,
} from '@/modules/chat/utils/chatStorage';
import type {
  ActiveBackgroundTask,
  ChatAttachment,
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '@/shared/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelOption, ProviderQuotaData } from '@/shared/types';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { toTokenBudget } from '@/modules/chat/utils/contextUsage';

import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import type { SlashCommand } from '@/shared/types';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  backgroundTasks?: ActiveBackgroundTask[];
  hasActiveBackgroundTasks?: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  setTokenBudget?: (budget: Record<string, unknown> | null) => void;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  /** Sticks the transcript to the bottom after a send: unpins and settles past the new row's commit. */
  stickToBottomAfterSend: () => void;
  addMessage: (msg: ChatMessage) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

type MentionableFile = {
  name: string;
  path: string;
}

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: ProviderModelOption[];
  defaultModel?: string;
};

/**
 * Quota shapes come from the wire contract; this module used to restate them
 * under different names and had already drifted on `updatedAt`.
 */
export type {
  ProviderQuotaBucket as QuotaBucket,
  ProviderQuotaData,
  ProviderQuotaGroup as QuotaGroup,
  ProviderQuotaResetCredit,
} from '@/shared/types';

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  /** Engine-reported context-window percentage (Claude); otherwise derived from used/total. */
  percentage?: number;
  /** The session was just compacted, so current occupancy is unknown until the next turn. */
  compacted?: boolean;
  /** UTF-8 size of the compaction summary, the only size available while `compacted`. */
  summaryBytes?: number;
  /** Session-lifetime totals for providers whose `tokenUsage.used` is the current context occupancy (codex, opencode). */
  cumulative?: {
    used?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  provider?: string;
  model?: string;
  quota?: ProviderQuotaData;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

/**
 * Thrown by the submit path when a message could not be handed to the backend.
 * `handleSubmit` catches it in one place, restores the composer's contents and
 * renders a single error row — no failure branch is allowed to drop the user's
 * text silently.
 */
class ComposerSubmitError extends Error {}

/**
 * How much of the first message the session gateway is given.
 *
 * The backend only reads it to title the session from its first few words, so
 * shipping the whole message just inflated the request that the user is
 * waiting on — a long paste used to upload tens of kilobytes before the send
 * could even start.
 */
const SESSION_TITLE_SOURCE_CHARS = 200;

type SubmitOptions = {
  /**
   * Send the text as a chat message even when it starts with "/" (or is
   * "help"). Set only for the re-submit of a custom command's expanded body:
   * like the Claude Code CLI, that body is never read as a command again, so a
   * body that opens with its own or another command's name cannot loop or
   * run that command instead of being sent.
   */
  skipCommandInterception?: boolean;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

export type QueuedDraft = {
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  backgroundTasks = [],
  hasActiveBackgroundTasks = false,
  processingSessions,
  canAbortSession,
  tokenBudget,
  setTokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  stickToBottomAfterSend,
  addMessage,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const { t } = useTranslation();
  // Backend-owned capability for the active provider; while the matrix is
  // loading the `/compact` entry simply stays hidden.
  const { capabilities: providerCapabilities } = useProviderCapabilitiesMap();
  const supportsCompaction = providerCapabilities?.[provider]?.supportsCompaction ?? false;
  // A busy session only holds a new message back when sending would kill the
  // work in flight; how far the engine takes input is its own capability.
  // Until the matrix loads, everything queues.
  const inputWhileBusy = providerCapabilities?.[provider]?.inputWhileBusy ?? 'queue';
  const backgroundWorkQueuesInput = Boolean(hasActiveBackgroundTasks) && inputWhileBusy === 'queue';
  const turnQueuesInput = isLoading && inputWhileBusy !== 'always';
  const queuesInput = turnQueuesInput || backgroundWorkQueuesInput;
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, number>>(new Map());
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      isForced?: boolean,
      submitOptions?: SubmitOptions,
    ) => Promise<boolean>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  const sessionKeyRef = useRef(sessionKey);
  const processingSessionsRef = useRef<SessionActivityMap | undefined>(processingSessions);
  sessionKeyRef.current = sessionKey;
  processingSessionsRef.current = processingSessions;

  // Every programmatic input write goes through the same pair of stores a send
  // reads: the state (for the render) and inputValueRef (so an immediate Enter
  // submits the new text, not a stale value). setInput and the ref are both
  // stable, so this callback never changes identity.
  const updateInput = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, []);
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: updateInput,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  /**
   * The session whose `/compact` is parked until its running turn ends.
   * Compaction is a run of its own, so the gateway refuses it while any run
   * holds the session; parking it — rather than surfacing that refusal — is
   * what lets the user ask mid-turn and have it happen automatically.
   */
  const [pendingCompactSession, setPendingCompactSession] = useState<string | null>(() => (
    typeof window !== 'undefined' && sessionKey && readQueuedCompact(sessionKey)
      ? sessionKey
      : null
  ));
  const pendingCompact = Boolean(sessionKey) && pendingCompactSession === sessionKey;

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          const costData = (data || {}) as CostCommandData;
          setCommandModalPayload({
            kind: 'cost',
            data: costData,
          });
          if (costData.compacted) {
            // Occupancy is unknown until the next turn, but the summary that
            // replaced the conversation still has a measurable size.
            setTokenBudget?.(toTokenBudget({ compacted: true, summaryBytes: costData.summaryBytes }));
          } else if (costData.tokenUsage && setTokenBudget) {
            setTokenBudget({
              used: costData.tokenUsage.used,
              total: costData.tokenUsage.total,
              inputTokens: costData.tokenBreakdown?.input,
              outputTokens: costData.tokenBreakdown?.output,
              breakdown: costData.tokenBreakdown,
              ...(costData.percentage ? { percentage: costData.percentage } : {}),
              ...(costData.cumulative ? { cumulative: costData.cumulative } : {}),
            });
          }
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage, setTokenBudget],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    updateInput(commandContent);

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    // The expanded body is the message itself: it skips slash-command interception.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent(), undefined, undefined, { skipCommandInterception: true });
      }
    }, 0);
  }, [addMessage, updateInput]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      // `/compact` is a runtime action, not a transcript command: it never
      // reaches /api/commands/execute. The provider runtime consumes it over
      // the chat socket, streams progress, and the terminal `complete`
      // refreshes the transcript with the summary.
      if (command.name === '/compact') {
        const targetSessionId = currentSessionId || selectedSession?.id || null;
        if (!targetSessionId) {
          addMessage({
            type: 'assistant',
            content: t('chat:misc.compactNoSession', {
              defaultValue: 'Start a conversation before compacting its context.',
            }),
            timestamp: Date.now(),
          });
          return;
        }

        const compactOptions = {
          model: currentProviderModel,
          effort: currentProviderEffort,
        };

        // Compaction is a run of its own — it cannot ride the turn in flight
        // the way a message can, so the gateway would answer RUN_IN_PROGRESS.
        // Park the request instead and let the turn-end flush dispatch it.
        if (isLoading && targetSessionId === sessionKey) {
          writeQueuedCompact(targetSessionId, { options: compactOptions });
          setPendingCompactSession(targetSessionId);
          if (!options?.preserveInput) {
            updateInput('');
          }
          return;
        }

        sendMessage({
          type: 'chat.compact',
          sessionId: targetSessionId,
          options: compactOptions,
        });
        onSessionProcessing?.(targetSessionId, { statusText: null, canInterrupt: false });
        if (!options?.preserveInput) {
          updateInput('');
        }
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // Everything typed after the command name is its argument text, line
        // breaks included (`[\s\S]`, unlike `.`), trimmed as the Claude Code CLI
        // does. `$ARGUMENTS` gets it verbatim; `$1`, `$2`, … get its tokens.
        // The name must open the input and end at whitespace or the end: a pick
        // from the slash menu passes the whole composer, where the name may
        // appear later or inside a longer word ("see /echo2 …" has no arguments).
        const commandMatch = effectiveInput
          .trimStart()
          .match(new RegExp(`^${escapeRegExp(command.name)}(?=\\s|$)([\\s\\S]*)`));
        const rawArgs = commandMatch ? commandMatch[1].trim() : '';
        const args = rawArgs ? rawArgs.split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            // Multi-line argument text verbatim, so `$ARGUMENTS` keeps the
            // line breaks the split tokens lose.
            rawArgs,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            updateInput('');
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      isLoading,
      provider,
      selectedProject,
      selectedSession?.id,
      sessionKey,
      addMessage,
      tokenBudget,
      updateInput,
      currentProviderEffort,
      onSessionProcessing,
      sendMessage,
      t,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
    supportsCompaction,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // A submit is only "in flight" for the window between the click and the
  // backend accepting the message — uploading attachments and allocating the
  // session id both live there. The ref is the gate (readable synchronously,
  // so two clicks in the same tick cannot both pass); the state drives the
  // button's spinner. Both are keyed by draft scope: a brand-new chat still
  // waiting for its session id must not block a send from another session the
  // user switched to meanwhile.
  const submittingScopesRef = useRef(new Set<string>());
  const [submittingScopes, setSubmittingScopes] = useState<ReadonlySet<string>>(() => new Set());
  const isSubmitting = submittingScopes.has(draftScope ?? '');

  /**
   * Empties everything the composer shows about the message being submitted.
   * Called the instant a submit is accepted, so the click is acknowledged
   * before any network work starts.
   */
  const clearComposerForSubmit = useCallback(() => {
    updateInput('');
    setAttachedFiles([]);
    setUploadingFiles(new Map());
    setFileErrors(new Map());
    resetCommandMenuState();
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    if (selectedProjectId) {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [resetCommandMenuState, selectedProjectId, updateInput]);

  /** Puts a failed submit's text and attachments back so nothing is lost. */
  const restoreComposerAfterFailedSubmit = useCallback((content: string, attachments: File[]) => {
    updateInput(content);
    setAttachedFiles(attachments);
  }, [updateInput]);

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const storedToolsSettings = readProviderToolsSettings(provider);
    // Claude's skip-permissions checkbox is retired: its stale stored flag must
    // not keep overriding the mode choice, so only the tool lists leave the
    // client. Other providers still pass their stored settings through as-is.
    const toolsSettings = provider === 'claude'
      ? {
          allowedTools: Array.isArray(storedToolsSettings.allowedTools) ? storedToolsSettings.allowedTools : [],
          disallowedTools: Array.isArray(storedToolsSettings.disallowedTools) ? storedToolsSettings.disallowedTools : [],
        }
      : Object.keys(storedToolsSettings).length > 0
        ? storedToolsSettings
        : {
            allowedTools: [],
            disallowedTools: [],
            skipPermissions: false,
          };

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: 'skipPermissions' in toolsSettings ? Boolean(toolsSettings.skipPermissions) : false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  /**
   * Submits the composer's message. Resolves to whether this call was taken:
   * `false` means nothing was sent (empty message, or another submit already
   * in flight), which is how a caller that owns the message — the queued-draft
   * flush — knows to keep its draft instead of dropping it.
   */
  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      isForced?: boolean,
      submitOptions?: SubmitOptions,
    ): Promise<boolean> => {
      event.preventDefault();
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return false;
      }

      // Every repeat of an in-flight submit — a second click, Enter pressed
      // again, a queued flush landing mid-send — stops here. Without this the
      // duplicate re-ran the whole path, and because the session id is only
      // known once the first POST returns, each repeat allocated its own
      // conversation.
      // The scopes are captured, not re-read: a new chat's scope switches from
      // `project:<id>` to its session id when the id lands mid-submit. That id
      // joins the held scopes below, so the chat stays latched under its new
      // scope too, and the release frees exactly what was taken.
      const submitScope = draftScope ?? '';
      if (submittingScopesRef.current.has(submitScope)) {
        return false;
      }
      const heldScopes = [submitScope];
      submittingScopesRef.current.add(submitScope);
      setSubmittingScopes(new Set(submittingScopesRef.current));
      // The one send identity the backend dedupes on. It covers what the latch
      // cannot: a retried fetch, or a second tab replaying the same submit.
      const clientRequestId = createClientRequestId();
      // Emptied up front rather than after the awaits, so the send is visible
      // immediately and the button stops looking dead. A queued flush carries
      // its own copy of the message and must leave the composer alone — the
      // user may already be typing the next one.
      if (!queuedSubmission) {
        clearComposerForSubmit();
      }

      try {
        // Intercept slash commands only when "/" is the first input character.
        // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
        // Pure local commands (built-in modals, help, etc.) execute immediately without queueing.
        const commandInput = currentInput.trimEnd();
        const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
        if (!submitOptions?.skipCommandInterception && (commandInput.startsWith('/') || isHelpAlias)) {
          // The name ends at the first whitespace of any kind, so "/cmd" followed
          // by a line break still runs /cmd (the Claude Code CLI splits the same way).
          const firstWhitespace = commandInput.search(/\s/);
          const commandName = isHelpAlias
            ? '/help'
            : firstWhitespace > 0 ? commandInput.slice(0, firstWhitespace) : commandInput;
          const matchedCommand =
            slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
            (commandName === '/help'
              ? ({
                  name: '/help',
                  description: 'Show help documentation for Claude Code',
                  namespace: 'builtin',
                  metadata: { type: 'builtin' },
                } as SlashCommand)
              : undefined);
          // Skills and engine commands such as `/compact` go to the engine as text.
          if (matchedCommand && !isEnginePromptCommand(matchedCommand)) {
            executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
            recordSentMessage(currentInput);
            return true;
          }
        }

        // The session is busy with work this engine cannot take a message during:
        // stash it instead of sending it.
        // Upload attached files now so the queued record contains durable image
        // descriptors that can be sent even if another session is open later.
        if (queuesInput && !isForced) {
          // A run can restart in the tiny gap between scheduling and flushing a
          // queued submission. Put the same durable draft back without uploading
          // its files again.
          if (queuedSubmission) {
            queuedDraftSessionRef.current = sessionKey;
            setQueuedDraft(queuedSubmission);
            return true;
          }

          const queuedOptions = buildSendOptions(currentInput);
          const queuedSessionKey = sessionKey;
          let uploadedAttachments: unknown[] = [];
          try {
            uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Queued file upload failed:', error);
            throw new ComposerSubmitError(`Failed to upload files: ${message}`);
          }

          // If there is already a queued draft, append new content rather than silently overwriting it
          const existingDraft = queuedDraft;
          const mergedContent = existingDraft?.content
            ? `${existingDraft.content}\n\n${currentInput}`
            : currentInput;
          const mergedAttachments = existingDraft?.attachments
            ? [...existingDraft.attachments, ...currentAttachments]
            : currentAttachments;
          const mergedUploadedAttachments = existingDraft?.uploadedAttachments
            ? [...existingDraft.uploadedAttachments, ...uploadedAttachments]
            : uploadedAttachments;

          const durableDraft: QueuedDraft = {
            content: mergedContent,
            attachments: mergedAttachments,
            uploadedAttachments: mergedUploadedAttachments,
            options: queuedOptions,
          };
          if (queuedSessionKey) {
            // Write the claim ticket synchronously after upload; this closes the
            // gap before React's persistence effect runs.
            writeQueuedMessage(queuedSessionKey, {
              content: durableDraft.content,
              options: durableDraft.options,
              attachments: durableDraft.uploadedAttachments,
            });
          }

          // Recorded under the session the message was queued FOR, and before
          // the session-switch return below — the queued text must be
          // recallable even when it dispatches without this composer.
          recordSentMessage(currentInput, queuedSessionKey);

          // The upload is asynchronous. If the user changed sessions while it
          // was running, persist/send against the session where Queue was
          // pressed rather than putting the draft into the newly opened chat.
          if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
            if (
              processingSessionsRef.current
              && !processingSessionsRef.current.has(queuedSessionKey)
            ) {
              clearQueuedMessage(queuedSessionKey);
              sendMessage({
                type: 'chat.send',
                sessionId: queuedSessionKey,
                content: durableDraft.content,
                options: {
                  ...(durableDraft.options ?? {}),
                  attachments: durableDraft.uploadedAttachments ?? [],
                },
              });
              onSessionProcessing?.(queuedSessionKey, { statusText: null, canInterrupt: true });
            }
            return true;
          }

          queuedDraftSessionRef.current = queuedSessionKey;
          setQueuedDraft(durableDraft);
          return true;
        }

        const messageContent = currentInput;

        let uploadedAttachments = previouslyUploadedAttachments;
        if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
          try {
            uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('File upload failed:', error);
            throw new ComposerSubmitError(`Failed to upload files: ${message}`);
          }
        }

        const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
        const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

        // The conversation always has a stable backend-allocated session id
        // BEFORE the first websocket send: brand-new chats allocate one here
        // via the session gateway. There is no client-visible session-id
        // handoff later — this id stays valid for the conversation's lifetime.
        let targetSessionId = selectedSession?.id || currentSessionId || null;
        if (!targetSessionId) {
          let createdSessionName = sessionSummary;
          try {
            const response = await authenticatedFetch('/api/providers/sessions', {
              method: 'POST',
              body: JSON.stringify({
                provider,
                projectPath: resolvedProjectPath,
                initialMessage: messageContent.slice(0, SESSION_TITLE_SOURCE_CHARS),
                clientRequestId,
              }),
            });
            if (!response.ok) {
              throw new Error(`Failed to create session (${response.status})`);
            }
            const body = await response.json();
            targetSessionId = body?.data?.sessionId || null;
            // A blank server name would leave the session unlabeled, so the local
            // summary stays the fallback unless a real name comes back.
            const returnedSessionName = typeof body?.data?.sessionName === 'string'
              ? body.data.sessionName.trim()
              : '';
            if (returnedSessionName) {
              createdSessionName = returnedSessionName;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Session creation failed:', error);
            throw new ComposerSubmitError(`Failed to start a new session: ${message}`);
          }

          if (!targetSessionId) {
            throw new ComposerSubmitError('Failed to start a new session: no session id returned.');
          }

          heldScopes.push(targetSessionId);
          submittingScopesRef.current.add(targetSessionId);
          setSubmittingScopes(new Set(submittingScopesRef.current));

          onSessionEstablished?.(targetSessionId, {
            provider,
            project: selectedProject,
            summary: createdSessionName,
          });
        }

        const attachmentRecords = uploadedAttachments as ChatAttachment[];
        const userMessage: ChatMessage = {
          type: 'user',
          content: currentInput,
          images: attachmentRecords.filter(isImageAttachment),
          files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
          timestamp: new Date(),
          // Tags this echo as the replacement, so the truncation the server
          // broadcasts a moment later cuts the turns being replaced without
          // taking the message the user just sent with them.
          ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
        };

        addMessage(userMessage);
        // Mark this request as processing in the per-session activity map (the
        // single source of truth the indicator derives from). The id is always
        // concrete at this point — no pending placeholder exists anymore.
        onSessionProcessing?.(targetSessionId, {
          statusText: null,
          canInterrupt: true,
        });

        stickToBottomAfterSend();

        // One message shape for every provider. The backend resolves the
        // provider, project path, and provider-native resume id from the
        // session row; `options` only carries composer-level preferences.
        sendMessage({
          // Replacing an already-sent message is its own frame: it changes the
          // shape of the conversation, so the server validates it separately.
          type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
          sessionId: targetSessionId,
          ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
          content: messageContent,
          options: {
            ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
            ...(isForced ? { forceInterrupt: true } : {}),
            attachments: uploadedAttachments,
          },
        });
        setEditingAnchorId(null);

        // Recorded under the (possibly just-allocated) session id, so the first
        // message of a new chat lands in the history of the session the user is
        // navigated to. Queued drafts were recorded when they were queued; the
        // consecutive-duplicate check keeps this second call a no-op.
        recordSentMessage(currentInput, targetSessionId);
      } catch (error) {
        // One place turns a failed submit back into an editable message, and
        // exactly one error row is rendered. Nothing is dropped silently.
        if (queuedSubmission) {
          // Back to the queue it came from; the composer may hold newer text.
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
        } else {
          restoreComposerAfterFailedSubmit(currentInput, currentAttachments);
        }
        addMessage({
          type: 'error',
          content: error instanceof ComposerSubmitError
            ? error.message
            : `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: new Date(),
        });
      } finally {
        for (const scope of heldScopes) {
          submittingScopesRef.current.delete(scope);
        }
        setSubmittingScopes(new Set(submittingScopesRef.current));
      }

      return true;
    },
    [
      selectedSession,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      executeCommand,
      queuesInput,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      recordSentMessage,
      clearComposerForSubmit,
      restoreComposerAfterFailedSubmit,
      stickToBottomAfterSend,
      selectedProject,
      sendMessage,
      sessionKey,
      draftScope,
      addMessage,
      slashCommands,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Once the in-flight turn ends, replay the queued draft through the normal
  // submit path. A `/compact` parked during that turn goes first: it is a run
  // of its own, so the queued draft has to wait behind the compaction. The
  // draft itself is passed directly so submission never depends on React
  // committing restored attachment state first.
  const wasBusyRef = useRef(queuesInput);
  const flushSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = queuesInput;

    // A session switch changes which session `isLoading` describes, so this
    // transition says nothing about the queued draft's own session. Never
    // flush across it — the swap effect below replaces `queuedDraft` with the
    // new session's saved draft right after this.
    if (flushSessionKeyRef.current !== sessionKey) {
      flushSessionKeyRef.current = sessionKey;
      return;
    }

    // A manual submit in flight owns the latch; flushing now would be refused.
    // This effect re-runs when it finishes, which is the retry. `isLoading` is
    // checked on its own because the gateway refuses a `/compact` while any
    // run is live, even on providers that take messages mid-turn.
    if (queuesInput || isLoading || isSubmitting || (!queuedDraft && !pendingCompact)) {
      return;
    }

    // Turn just ended in this session: flush immediately. Otherwise this is a
    // saved draft restored into an apparently idle session — hold it briefly
    // so the `chat_subscribed` ack can flip `isLoading` if a run is actually
    // still live (the cleanup below cancels the send in that case).
    const delay = wasBusy ? 0 : 750;
    const timer = setTimeout(() => {
      // A parked `/compact` claims this turn-end: the storage key is the claim
      // ticket shared with the app-level auto-send, so an empty key means the
      // request was already dispatched and must not be sent twice.
      if (sessionKey) {
        const parkedCompact = readQueuedCompact(sessionKey);
        if (parkedCompact) {
          clearQueuedCompact(sessionKey);
          setPendingCompactSession((current) => (current === sessionKey ? null : current));
          sendMessage({
            type: 'chat.compact',
            sessionId: sessionKey,
            options: {
              model: currentProviderModel,
              effort: currentProviderEffort,
              ...parkedCompact.options,
            },
          });
          // Dispatching marks the session processing, so the queued draft (if
          // any) flushes when the compaction's own run completes.
          onSessionProcessing?.(sessionKey, { statusText: null, canInterrupt: false });
          return;
        }
        if (pendingCompact) {
          // The request was claimed elsewhere, so there is nothing left to run.
          setPendingCompactSession((current) => (current === sessionKey ? null : current));
        }
      }

      if (!queuedDraft) {
        return;
      }

      // The saved key is the claim ticket shared with the app-level auto-send
      // (which handles sessions that finish while not viewed). If it's gone,
      // the message was already dispatched — don't send it twice.
      if (sessionKey && !readQueuedMessage(sessionKey)) {
        setQueuedDraft(null);
        return;
      }
      setQueuedDraft(null);
      // The draft travels as an argument — the composer is never loaded with
      // it, so whatever the user is typing survives the flush.
      const submitted = handleSubmitRef.current?.(createFakeSubmitEvent(), queuedDraft);
      void submitted?.then((accepted) => {
        if (!accepted) {
          // Refused after this effect already cleared the queue: nobody took
          // the message, so put it back rather than losing it silently.
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedDraft);
        }
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [
    queuesInput,
    isLoading,
    isSubmitting,
    queuedDraft,
    pendingCompact,
    sessionKey,
    currentProviderModel,
    currentProviderEffort,
    sendMessage,
    onSessionProcessing,
  ]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    updateInput(queuedDraft.content);
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft, updateInput]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  const forceSendQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    const draft = queuedDraft;
    setQueuedDraft(null);
    if (sessionKey) {
      clearQueuedMessage(sessionKey);
    }
    const submitted = handleSubmitRef.current?.(createFakeSubmitEvent(), draft, true);
    void submitted?.then((accepted) => {
      if (!accepted) {
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft(draft);
      }
    });
  }, [queuedDraft, sessionKey]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. updateInput mirrors
  // the value into inputValueRef synchronously so handleSubmit reads the new text.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    updateInput(next);
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [updateInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (
      queuedDraft
      && (queuedDraft.content.trim() || (queuedDraft.uploadedAttachments?.length ?? 0) > 0)
    ) {
      writeQueuedMessage(sessionKey, {
        content: queuedDraft.content,
        options: queuedDraft.options,
        attachments: queuedDraft.uploadedAttachments,
      });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  // The parked `/compact` follows the session the same way: it belongs to the
  // session it was requested for, not to whichever composer is mounted now.
  useEffect(() => {
    setPendingCompactSession(
      sessionKey && readQueuedCompact(sessionKey) ? sessionKey : null,
    );
  }, [sessionKey]);

  const cancelPendingCompact = useCallback(() => {
    if (sessionKey) {
      clearQueuedCompact(sessionKey);
    }
    setPendingCompactSession((current) => (current === sessionKey ? null : current));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      updateInput(newValue);
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition, updateInput],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    updateInput('');
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState, updateInput]);

  const handleAbortSession = useCallback(() => {
    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // Stop aborts the turn only, as Esc does in Claude Code; background tasks
    // are stopped from the task strip. Once the turn has ended there is no run
    // to abort, but a finished task can still wake the model with a turn of
    // its own, which `chat.abort` interrupts as well.
    if (!canAbortSession && !processingSessions?.get(targetSessionId)?.background) {
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, processingSessions, selectedSession?.id, sendMessage]);

  /**
   * Stops background tasks by id: the one launched by `toolUseId`, or every
   * task the session still has running when it is omitted.
   */
  const handleStopBackgroundTasks = useCallback((toolUseId?: string) => {
    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      return;
    }
    const tasks = processingSessions?.get(targetSessionId)?.tasks ?? [];
    for (const task of tasks) {
      if (toolUseId && task.toolUseId !== toolUseId) {
        continue;
      }
      sendMessage({ type: 'chat.stop-task', sessionId: targetSessionId, taskId: task.taskId });
    }
  }, [currentSessionId, processingSessions, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    updateInput(message.content || '');
    textareaRef.current?.focus();
  }, [updateInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    updateInput('');
  }, [updateInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    /** True while a submitted message is being uploaded or allocated a session. */
    isSubmitting,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    forceSendQueuedDraft,
    /** True while a `/compact` waits for the running turn to end. */
    pendingCompact,
    cancelPendingCompact,
    backgroundTasks,
    hasActiveBackgroundTasks,
    backgroundWorkQueuesInput,
    /** True while the session is busy with work a new message would have to wait for. */
    queuesInput,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handleStopBackgroundTasks,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
