import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

import { useAskSideQuestion } from '@/modules/chat/hooks/useSideQuestions';

import { api, ApiRequestError, authenticatedFetch } from '@/shared/api';
import { MAX_ATTACHMENT_COUNT } from '@/shared/constants';
import { createClientRequestId, isEnginePromptCommand, isImageAttachment } from '@/shared/utils';
import type { MarkSessionProcessing, SessionActivityMap } from '@/shared/types';
import { uploadAttachmentFiles } from '@/modules/chat/utils/attachmentUpload';
import { createAttachmentUploadQueue } from '@/modules/chat/utils/attachmentUploadQueue';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import { readProviderToolsSettings, safeLocalStorage } from '@/modules/chat/utils/chatStorage';
import {
  appendQueuedMessage,
  clearQueuedMessage,
  getChatDraftSessionGeneration,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
  type StoredQueuedMessage,
} from '@/shared/chatDrafts';
import type {
  ActiveBackgroundTask,
  BackgroundSendChoice,
  BackgroundSendPrompt,
  ChatAttachment,
  PendingSteer,
  ChatMessage,
  ComposerAttachmentBlock,
  ComposerAttachmentItem,
  ComposerAttachmentQueue,
  PendingPermissionRequest,
  PermissionMode,
  QueuedSendOptions,
  SteerOutcome,
  SessionEstablishedContext,
  UploadedComposerAttachment,
} from '@/shared/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelOption, ProviderQuotaData } from '@/shared/types';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';

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
  /**
   * Whether a new message has to wait (be queued). Defaults to "busy at all";
   * the chat passes false during background work whose runtime takes the next
   * turn alongside it (Claude's held process).
   */
  isInputBlocked?: boolean;
  /** Live websocket connectivity; unknown counts as connected. */
  isConnected?: boolean;
  backgroundTasks?: ActiveBackgroundTask[];
  hasActiveBackgroundTasks?: boolean;
  /** From the capability matrix: whether the provider can take a message into a running turn (`chat.steer`). Gates the composer's Steer affordance. */
  supportsSteering?: boolean;
  /** From the capability matrix: whether a side question can be asked beside this session (`chat.side_question`). Gates the composer's side-question affordance. */
  supportsSideQuestions?: boolean;
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
  /**
   * The modal opened on click and `/api/commands/execute` has not answered.
   * `data` holds what the browser already knew (only `/cost` has any).
   */
  pending?: boolean;
};

/** Built-in commands whose answer is shown in the command modal, by modal kind. */
const BUILTIN_MODAL_COMMAND_KINDS: Record<string, CommandModalKind> = {
  '/help': 'help',
  '/models': 'models',
  '/cost': 'cost',
  '/status': 'status',
};

/**
 * What the `/cost` modal can show before the server answers: the composer's
 * own provider, model and token count. Usage is left out when the composer has
 * none, so the modal says it is reading instead of showing 0.
 */
function buildLocalCostData(
  provider: string,
  model: string,
  tokenBudget: Record<string, unknown> | null,
): CostCommandData {
  const data: CostCommandData = { provider, model };
  const breakdown = tokenBudget?.breakdown && typeof tokenBudget.breakdown === 'object'
    ? tokenBudget.breakdown as Record<string, unknown>
    : null;
  const input = Number(tokenBudget?.inputTokens ?? breakdown?.input) || 0;
  const output = Number(tokenBudget?.outputTokens ?? breakdown?.output) || 0;
  const used = Math.max(Number(tokenBudget?.used) || 0, input + output);
  if (used <= 0) {
    return data;
  }
  data.tokenUsage = { used, total: Number(tokenBudget?.total) || 0 };
  if (input + output > 0) {
    data.tokenBreakdown = { input, output };
  }
  return data;
}

/**
 * Thrown by the submit path when a message could not be handed to the backend.
 * `handleSubmit` catches it in one place, restores the composer's contents and
 * renders a single error row — no failure branch is allowed to drop the user's
 * text silently.
 */
class ComposerSubmitError extends Error {}

/**
 * A phone or tablet types through an on-screen keyboard: its return key is
 * labelled "new line", and Shift+Enter — the desktop combination for a newline
 * in Enter-to-send mode — cannot be typed on it at all. `(pointer: coarse)`
 * marks exactly those primary inputs; a touch laptop keeps its fine primary
 * pointer and with it the desktop Enter behaviour.
 */
function isSoftKeyboardEnvironment(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * A v4 UUID for a steered message. The id becomes the message's transcript
 * uuid, so it must be a real one. `crypto.randomUUID` only exists in secure
 * contexts, and the app is often opened over plain http on a LAN address
 * (a phone on the same network), so this falls back to `getRandomValues`.
 */
const createSteerMessageId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Whether a live user message is the echo of the steered message with this id. */
const isEchoOfSteer = (echoId: string, messageId: string): boolean => (
  // A text-only message is echoed under its own id; one with images is split
  // into parts named `<id>_text_<n>` / `<id>_images`.
  echoId === messageId || echoId.startsWith(`${messageId}_`)
);

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
   * Send the message into the session's running turn (steering) instead of
   * queueing or starting a new one. The composer's Steer affordance sets it;
   * like Queue it goes through the submit's upload and validation and only
   * diverges once the message is ready to leave the composer.
   */
  steerIntoTurn?: boolean;
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

export type QueuedDraft = {
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Stored with the message so the
   * server sends it with the model and permission settings it was queued under,
   * whichever page (if any) is open by then.
   */
  options?: QueuedSendOptions;
};

/** The JSON-safe part of a queued draft, as the server stores and sends it. */
const toStoredQueuedMessage = (draft: QueuedDraft): StoredQueuedMessage => ({
  content: draft.content,
  options: draft.options,
  attachments: draft.uploadedAttachments,
});

const isSameQueuedMessage = (a: StoredQueuedMessage, b: StoredQueuedMessage): boolean => (
  a.content === b.content
  && JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null)
  && JSON.stringify(a.attachments ?? []) === JSON.stringify(b.attachments ?? [])
);

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

/** Pairs a queued draft's files with their stored descriptors, so putting them back needs no upload. */
const toUploadedAttachments = (files: File[], draft: QueuedDraft): UploadedComposerAttachment[] => (
  files.map((file, index) => ({ file, uploaded: draft.uploadedAttachments?.[index] }))
);

/** Uploads one attachment for the queue, in a request of its own so a timeout costs only this file. */
const uploadComposerAttachment: Parameters<typeof createAttachmentUploadQueue>[0] = async (file, options) => (
  (await uploadAttachmentFiles([file], options))[0]
);

const deriveAttachmentBlock = (items: readonly ComposerAttachmentItem[]): ComposerAttachmentBlock => {
  if (items.some(({ status }) => status === 'queued' || status === 'uploading')) return 'uploading';
  return items.some(({ status }) => status !== 'done') ? 'failed' : null;
};

const recoverQueuedFiles = async (draft: QueuedDraft): Promise<File[]> => {
  const uploads = draft.uploadedAttachments ?? [];
  if (uploads.length === 0 || draft.attachments.length === uploads.length) return draft.attachments;
  return Promise.all(uploads.map(async (entry) => {
    const descriptor = typeof entry === 'string' ? { path: entry } : entry as ChatAttachment;
    const storedName = descriptor?.path?.split(/[\\/]/).pop();
    if (!storedName) throw new Error('The queued attachment has no stored filename');
    const response = await api.assets.file(storedName);
    if (!response.ok) throw new Error(`Cannot restore queued attachment (${response.status})`);
    return new File([await response.arrayBuffer()], descriptor.name || storedName, {
      type: descriptor.mimeType || response.headers.get('Content-Type') || 'application/octet-stream',
    });
  }));
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
  isInputBlocked,
  isConnected,
  backgroundTasks = [],
  hasActiveBackgroundTasks = false,
  supportsSteering = false,
  supportsSideQuestions = false,
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
  const { t } = useTranslation('chat');
  const draftGenerationRef = useRef(getChatDraftSessionGeneration());
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      const scope = selectedSession?.id || currentSessionId || `project:${selectedProject.projectId}`;
      return readDraftText(scope) || safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  // The queue owns attachments across scopes because an upload must survive a
  // session switch and a send must read its state synchronously.
  const [attachmentQueue] = useState<ComposerAttachmentQueue>(() => createAttachmentUploadQueue(uploadComposerAttachment));
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);
  // Which modal opening an `/api/commands/execute` answer may still fill.
  // Opening a modal bumps it; closing bumps it again, so a late answer neither
  // reopens a modal the user dismissed nor overwrites the composer's tokens.
  const commandModalRequestRef = useRef(0);

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
  sessionKeyRef.current = sessionKey;
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const inputOwnerRef = useRef(draftScope);
  // The queue's list for the open chat. Only structure and status changes reach
  // here; percents go straight to the thumbnail.
  const attachments = useSyncExternalStore(
    attachmentQueue.subscribe,
    () => attachmentQueue.getItems(draftScope ?? ''),
  );
  const attachmentBlock = useMemo(() => deriveAttachmentBlock(attachments), [attachments]);

  // Every programmatic input write goes through the same pair of stores a send
  // reads: the state (for the render) and inputValueRef (so an immediate Enter
  // submits the new text, not a stale value). setInput and the ref are both
  // stable, so this callback never changes identity.
  const updateInput = useCallback((value: SetStateAction<string>) => {
    if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return;
    const next = typeof value === 'function' ? value(inputValueRef.current) : value;
    setInput(next);
    inputValueRef.current = next;
    if (draftScopeRef.current) writeDraftText(draftScopeRef.current, next);
  }, []);
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

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
            pending: false,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
            pending: false,
          });
          break;

        case 'cost': {
          const costData = (data || {}) as CostCommandData;
          setCommandModalPayload({
            kind: 'cost',
            data: costData,
            pending: false,
          });
          if (costData.tokenUsage && setTokenBudget) {
            setTokenBudget({
              used: costData.tokenUsage.used,
              total: costData.tokenUsage.total,
              inputTokens: costData.tokenBreakdown?.input,
              outputTokens: costData.tokenBreakdown?.output,
              breakdown: costData.tokenBreakdown,
            });
          }
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
            pending: false,
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
    commandModalRequestRef.current += 1;
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

      // A built-in modal command opens its modal now, not after the round trip:
      // on a slow link that wait was seconds with nothing on screen.
      const modalKind = command.namespace === 'builtin' ? BUILTIN_MODAL_COMMAND_KINDS[command.name] : undefined;
      const modalRequestId = modalKind ? ++commandModalRequestRef.current : null;
      const ownsModal = () => modalRequestId === commandModalRequestRef.current;
      if (modalKind) {
        setCommandModalPayload({
          kind: modalKind,
          data: modalKind === 'cost' ? buildLocalCostData(provider, currentProviderModel, tokenBudget) : {},
          pending: true,
        });
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
          if (!modalKind || ownsModal()) {
            handleBuiltInCommand(result);
          }
          if (!options?.preserveInput) {
            updateInput('');
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        if (modalKind) {
          if (!ownsModal()) {
            return;
          }
          // The cost modal already shows the composer's own numbers; a failed
          // refresh only ends its loading state. The others have nothing to show.
          if (modalKind === 'cost') {
            setCommandModalPayload((current) => current && { ...current, pending: false });
            return;
          }
          setCommandModalPayload(null);
        }
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
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
      updateInput,
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
    setInput: updateInput,
    textareaRef,
    onExecuteCommand: executeCommand,
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
    setInput: updateInput,
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
    attachmentQueue.add(draftScopeRef.current ?? '', files);
  }, [attachmentQueue]);

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
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // A submit is only "in flight" for the window between the click and the
  // backend accepting the message, which covers queueing it and allocating the
  // session id. The ref is the gate (readable synchronously,
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
  const restoreComposerAfterFailedSubmit = useCallback((
    content: string,
    attachments: UploadedComposerAttachment[],
    ownerScope: string,
  ) => {
    if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return;
    attachmentQueue.restore(ownerScope, attachments);
    if (draftScopeRef.current !== ownerScope) {
      const restored = [content, readDraftText(ownerScope)].filter((part) => part.trim()).join('\n\n');
      writeDraftText(ownerScope, restored);
      return;
    }
    updateInput([content, inputValueRef.current].filter((part) => part.trim()).join('\n\n'));
  }, [attachmentQueue, updateInput]);

  // Sending over background work asks first. The dialog is rendered by the
  // composer; the submit awaits the user's choice through this resolver.
  const [backgroundSendPrompt, setBackgroundSendPrompt] = useState<BackgroundSendPrompt | null>(null);
  const backgroundSendResolverRef = useRef<((choice: BackgroundSendChoice) => void) | null>(null);

  const askBeforeSendingOverBackgroundWork = useCallback(
    (work: string[]) => new Promise<BackgroundSendChoice>((resolve) => {
      // Only one prompt at a time: a stale one is answered "cancel".
      backgroundSendResolverRef.current?.('cancel');
      backgroundSendResolverRef.current = resolve;
      setBackgroundSendPrompt({ work });
    }),
    [],
  );

  const resolveBackgroundSendPrompt = useCallback((choice: BackgroundSendChoice) => {
    const resolve = backgroundSendResolverRef.current;
    backgroundSendResolverRef.current = null;
    setBackgroundSendPrompt(null);
    resolve?.(choice);
  }, []);

  // An unmounted composer cannot answer; let the pending submit finish.
  useEffect(() => () => {
    backgroundSendResolverRef.current?.('cancel');
    backgroundSendResolverRef.current = null;
  }, []);


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
   * `false` means nothing was sent (empty message, an unfinished attachment, or
   * another submit already in flight), which is how a caller that owns the message — the queued-draft
   * flush — knows to keep its draft instead of dropping it.
   */
  // Messages this tab sent into a running turn that the agent has not read
  // yet. Each is a card above the composer until its echo reaches the
  // transcript; the run ending without it puts the text back in the composer,
  // and a refusal (the turn had already ended) queues it as the next turn.
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  // Read by the outcome handler, which the realtime listener calls between
  // renders: a refusal can follow an acceptance before React re-renders.
  // Written only through `updatePendingSteers` below, with the state.
  const pendingSteersRef = useRef(pendingSteers);

  // Every change to the pending steers goes through here so the ref the
  // outcome handler reads is never behind the state.
  const updatePendingSteers = useCallback((update: (current: PendingSteer[]) => PendingSteer[]) => {
    const next = update(pendingSteersRef.current);
    pendingSteersRef.current = next;
    setPendingSteers(next);
  }, []);

  // Sends a message into the session's running turn (`chat.steer`): the agent
  // reads it at its next tool call, without the turn stopping. It leaves the
  // composer at once, as a sent message does, and waits as a card until the
  // agent reads it. Attachments must already be uploaded.
  const steerIntoRunningTurn = useCallback(
    (message: { content: string; attachments: File[]; uploadedAttachments: unknown[] }, steerSessionKey: string) => {
      const messageId = createSteerMessageId();
      updatePendingSteers((current) => [...current, {
        messageId,
        sessionKey: steerSessionKey,
        content: message.content,
        attachments: message.attachments,
        uploadedAttachments: message.uploadedAttachments,
        status: 'sending',
      }]);
      sendMessage({
        type: 'chat.steer',
        sessionId: steerSessionKey,
        messageId,
        content: message.content,
        options: { attachments: message.uploadedAttachments },
      });
      recordSentMessage(message.content, steerSessionKey);

      if (sessionKeyRef.current === steerSessionKey) {
        clearComposerForSubmit();
      } else if (readDraftText(steerSessionKey) === message.content) {
        // The user changed sessions during the upload; the composer they left
        // must not still hold the message as its draft.
        writeDraftText(steerSessionKey, '');
      }
    },
    [clearComposerForSubmit, recordSentMessage, sendMessage, updatePendingSteers],
  );

  /**
   * Settles a steered message as the realtime handler reports on it. Used by
   * ChatInterface, which hands it to the realtime handler.
   */
  const handleSteerOutcome = useCallback(
    (_sessionId: string, messageId: string, outcome: SteerOutcome) => {
      if (outcome === 'delivered') {
        if (pendingSteersRef.current.some((steer) => isEchoOfSteer(messageId, steer.messageId))) {
          updatePendingSteers((current) => current.filter((steer) => !isEchoOfSteer(messageId, steer.messageId)));
        }
        return;
      }

      const steer = pendingSteersRef.current.find((candidate) => candidate.messageId === messageId);
      if (!steer) {
        return;
      }
      if (outcome === 'accepted') {
        updatePendingSteers((current) => current.map((candidate) => (
          candidate.messageId === messageId ? { ...candidate, status: 'accepted' } : candidate
        )));
        return;
      }

      // Refused: the turn had already ended when it arrived. The user meant it
      // for this conversation now, so it queues as the next turn — the
      // server-side queue sends it as soon as the session is idle.
      updatePendingSteers((current) => current.filter((candidate) => candidate.messageId !== messageId));
      void (async () => {
        try {
          const response = await appendQueuedMessage(steer.sessionKey, {
            content: steer.content,
            options: buildSendOptions(steer.content),
            attachments: steer.uploadedAttachments,
          });
          const durableDraft: QueuedDraft = {
            content: response.queuedMessage.content,
            options: response.queuedMessage.options,
            uploadedAttachments: response.queuedMessage.attachments,
            attachments: steer.attachments,
          };
          if (sessionKeyRef.current === steer.sessionKey) {
            queuedDraftSessionRef.current = steer.sessionKey;
            setQueuedDraft((previous) => ({
              ...durableDraft,
              attachments: response.appended && previous
                ? [...previous.attachments, ...steer.attachments]
                : steer.attachments,
            }));
          }
        } catch (error) {
          // The queue refused too (rare); put the message back so nothing
          // typed is lost.
          if (sessionKeyRef.current === steer.sessionKey) {
            restoreComposerAfterFailedSubmit(
              steer.content,
              steer.attachments.map((file) => ({ file, uploaded: null as unknown })),
              steer.sessionKey,
            );
          }
          addMessage({ type: 'error', content: `Failed to queue the message: ${error instanceof Error ? error.message : String(error)}`, timestamp: new Date() });
        }
      })();
    },
    [addMessage, buildSendOptions, restoreComposerAfterFailedSubmit, updatePendingSteers],
  );

  // The run ended with a steered message the server took but the agent never
  // read — the user stopped the run, or it failed. Nothing will send it now,
  // so it goes back into the composer (ahead of anything typed since) rather
  // than vanishing or being sent behind the user's back after a stop.
  const wasLoadingRef = useRef(isLoading);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;
    if (!wasLoading || isLoading || !sessionKey) {
      return;
    }
    const unread = pendingSteersRef.current.filter(
      (steer) => steer.sessionKey === sessionKey && steer.status === 'accepted',
    );
    if (unread.length === 0) {
      return;
    }
    updatePendingSteers((current) => current.filter((steer) => !unread.includes(steer)));
    const restored = [...unread.map((steer) => steer.content), inputValueRef.current]
      .filter((part) => part.trim())
      .join('\n\n');
    setInput(restored);
    inputValueRef.current = restored;
    if (sessionKey) {
      attachmentQueue.restore(sessionKey, unread.flatMap((steer) => steer.attachments).map((file) => ({ file, uploaded: null as unknown })));
      writeDraftText(sessionKey, restored);
    }
  }, [attachmentQueue, isLoading, sessionKey, setInput, updatePendingSteers]);

  // Cards belong to the session they were sent into; switching away drops
  // them (the messages themselves are already the run's, on the server).
  useEffect(() => {
    if (pendingSteersRef.current.some((steer) => steer.sessionKey !== sessionKey)) {
      updatePendingSteers((current) => current.filter((steer) => steer.sessionKey === sessionKey));
    }
  }, [sessionKey, updatePendingSteers]);

  // Only the open session's cards are shown.
  const visiblePendingSteers = useMemo(
    () => pendingSteers.filter((steer) => steer.sessionKey === sessionKey),
    [pendingSteers, sessionKey],
  );

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      isForced?: boolean,
      submitOptions?: SubmitOptions,
    ): Promise<boolean> => {
      event.preventDefault();
      if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return false;
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      // Read from the queue, not from render state, so an Enter in the same
      // tick as an upload change sees the truth. A queued flush brings its own
      // stored attachments and is not held by what the composer is uploading.
      const submitScope = draftScope ?? '';
      const composerAttachments = queuedSubmission ? [] : attachmentQueue.getItems(submitScope);
      const currentAttachments = queuedSubmission?.attachments ?? composerAttachments.map(({ file }) => file);
      const uploadedAttachments = queuedSubmission?.uploadedAttachments
        ?? composerAttachments.map(({ uploaded }) => uploaded);
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && uploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return false;
      }

      // The one gate every send path passes: button, Enter, voice and expanded commands.
      if (!queuedSubmission && !attachmentQueue.isReady(submitScope)) {
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
      if (submittingScopesRef.current.has(submitScope)) {
        return false;
      }
      const heldScopes = [submitScope];
      submittingScopesRef.current.add(submitScope);
      setSubmittingScopes(new Set(submittingScopesRef.current));
      // The one send identity the backend dedupes on. It covers what the latch
      // cannot: a retried fetch, or a second tab replaying the same submit.
      const clientRequestId = createClientRequestId();
      // False only when the submit failed and its message went back where it came from.
      let accepted = true;
      // Emptied up front rather than after the awaits, so the send is visible
      // immediately and the button stops looking dead. A queued flush carries
      // its own copy of the message and must leave the composer alone — the
      // user may already be typing the next one.
      // `/btw <question>` never becomes a turn: checked before the queue take
      // and the composer clear below, so a refusal (unsupported provider, a
      // brand-new chat with no session yet) leaves the typed text and any
      // attachments exactly as they were — and the raw `/btw …` text is never
      // sent as a turn or queued. A queued re-dispatch never carries this
      // prefix, so it is skipped.
      if (!queuedSubmission && !submitOptions?.skipCommandInterception) {
        const btwMatch = currentInput.trim().match(/^\/btw(?:\s+([\s\S]*))?$/i);
        if (btwMatch) {
          askSideQuestionFromComposer(sessionKey, btwMatch[1] ?? '');
          return true;
        }
      }

      let takenAttachments: UploadedComposerAttachment[] = [];
      if (!queuedSubmission) {
        takenAttachments = attachmentQueue.take(submitScope)
          .map(({ file, uploaded }) => ({ file, uploaded }));
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

        // A turn or background work is already in flight: stash this message
        // instead of sending it. It carries stored descriptors, so it can be
        // sent even if another session is open later.
        // Steering sends the message into the running turn instead of after
        // it, when the composer's Steer affordance asked for that and the
        // provider can take it. A slash command is a turn of its own, so it
        // always waits in the queue.
        if (
          submitOptions?.steerIntoTurn === true
          && supportsSteering
          && Boolean(sessionKey)
          && !currentInput.trimStart().startsWith('/')
        ) {
          steerIntoRunningTurn({
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
          }, sessionKey as string);
          return true;
        }

        // Set when the user picked "send anyway" over running background work:
        // the direct send below then carries forceInterrupt, matching the
        // queued card's force-send button.
        let sendAnyway = false;
        const isBusy = isInputBlocked ?? (isLoading || Boolean(hasActiveBackgroundTasks));
        if (isBusy && !isForced) {
          // A run can restart in the tiny gap between scheduling and flushing a
          // queued submission. Put the same durable draft back.
          if (queuedSubmission) {
            queuedDraftSessionRef.current = sessionKey;
            setQueuedDraft(queuedSubmission);
            return true;
          }

          // Sending over background work asks first: a new turn stops that
          // work. A reply still producing output keeps queueing silently —
          // the prompt is only for the turn-ended, work-still-running window —
          // and once something is queued, further inputs append unasked.
          const targetActivity = sessionKey ? processingSessions?.get(sessionKey) : undefined;
          const replyInFlight = Boolean(targetActivity && !targetActivity.background);
          if (!replyInFlight && hasActiveBackgroundTasks && !queuedDraft) {
            const work = targetActivity?.tasks
              ? ownBackgroundTasks(targetActivity.tasks).map((task) => describeBackgroundTask(task, t))
              : backgroundTasks.map((task) => task.command || task.description || task.toolName);
            const choice = await askBeforeSendingOverBackgroundWork(work);
            if (choice === 'cancel') {
              restoreComposerAfterFailedSubmit(currentInput, takenAttachments, submitScope);
              return true;
            }
            sendAnyway = choice === 'send';
          }

          if (!sendAnyway) {
            const queuedOptions = buildSendOptions(currentInput);
            const queuedSessionKey = sessionKey;
            if (!queuedSessionKey) {
              throw new ComposerSubmitError('No session is available to queue this message.');
            }
            const response = await appendQueuedMessage(queuedSessionKey, {
              content: currentInput,
              options: queuedOptions,
              attachments: uploadedAttachments,
            });
            const durableDraft: QueuedDraft = {
              content: response.queuedMessage.content,
              options: response.queuedMessage.options,
              uploadedAttachments: response.queuedMessage.attachments,
              attachments: currentAttachments,
            };

            // Recorded under the session the message was queued FOR, and before
            // the session-switch return below — the queued text must be
            // recallable even when it dispatches without this composer.
            recordSentMessage(currentInput, queuedSessionKey);

            // The append is asynchronous. If the user changed sessions while it
            // was running, the message is already queued on the server for the
            // session where Queue was pressed; the newly opened chat must not
            // take it into its own queue.
            if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
              return true;
            }

            queuedDraftSessionRef.current = queuedSessionKey;
            setQueuedDraft((previous) => ({
              ...durableDraft,
              attachments: response.appended && previous
                ? [...previous.attachments, ...currentAttachments]
                : currentAttachments,
            }));
            return true;
          }
          // Chosen "send anyway": fall through to the direct send. Its frame
          // carries forceInterrupt below, so runtimes that hold the input
          // actually start the new turn instead of waiting on the work.
        }

        // A closed socket drops the frame without a word, after the echo and
        // the busy marker below have already told the user it went out. Refuse
        // up front instead, before a new chat allocates a session for nothing.
        if (isConnected === false) {
          throw new ComposerSubmitError('Not connected to the server. Your message was kept; send it again once the connection is back.');
        }

        const messageContent = currentInput;
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
            if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return false;
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
            ...(isForced || sendAnyway ? { forceInterrupt: true } : {}),
            attachments: uploadedAttachments,
          },
        });
        // Only the anchor this send read is cleared: an edit begun in another
        // chat while this send waited must survive it (upstream #1775).
        if (editingAnchorId) {
          setEditingAnchorId(null);
        }

        // Recorded under the (possibly just-allocated) session id, so the first
        // message of a new chat lands in the history of the session the user is
        // navigated to. Queued drafts were recorded when they were queued; the
        // consecutive-duplicate check keeps this second call a no-op.
        recordSentMessage(currentInput, targetSessionId);
      } catch (error) {
        accepted = false;
        if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return false;
        // One place turns a failed submit back into an editable message, and
        // exactly one error row is rendered. Nothing is dropped silently.
        if (queuedSubmission) {
          // Back to the queue it came from; the composer may hold newer text.
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
        } else {
          restoreComposerAfterFailedSubmit(currentInput, takenAttachments, submitScope);
        }
        addMessage({
          type: 'error',
          content: error instanceof ApiRequestError && error.code === 'QUEUE_DELIVERY_UNCONFIRMED'
            ? t('input.queue.confirmDelivery', { defaultValue: 'No server confirmation was received. Refresh and confirm whether the message was queued before trying again.' })
            : error instanceof ApiRequestError && error.code === 'QUEUED_MESSAGE_NOT_COMBINABLE'
            ? t('input.queue.notCombinable', { defaultValue: 'Slash commands must be sent separately from the queued message.' })
            : error instanceof ComposerSubmitError
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

      return accepted;
    },
    [
      selectedSession,
      attachmentQueue,
      buildSendOptions,
      currentSessionId,
      executeCommand,
      isLoading,
      isInputBlocked,
      isConnected,
      hasActiveBackgroundTasks,
      backgroundTasks,
      editingAnchorId,
      processingSessions,
      queuedDraft,
      supportsSteering,
      steerIntoRunningTurn,
      askBeforeSendingOverBackgroundWork,
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
      t,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The server sends queued messages, and another page can queue, edit or
  // drop one, so the card follows what the store holds for this session. Its
  // own copy is kept while it matches, since only it has the browser files the
  // edit button puts back.
  useEffect(() => {
    if (!sessionKey) {
      return undefined;
    }
    return subscribeToChatDrafts(() => {
      if (queuedDraftSessionRef.current !== sessionKey) {
        return;
      }
      const stored = readQueuedMessage(sessionKey);
      setQueuedDraft((current) => {
        if (!stored) {
          return null;
        }
        if (current && isSameQueuedMessage(toStoredQueuedMessage(current), stored)) {
          return current;
        }
        const restored = restoreQueuedDraft(sessionKey);
        const uploads = current?.uploadedAttachments ?? [];
        return restored && current && JSON.stringify((restored.uploadedAttachments ?? []).slice(0, uploads.length)) === JSON.stringify(uploads)
          ? { ...restored, attachments: current.attachments }
          : restored;
      });
    });
  }, [sessionKey]);

  const clearQueuedDraftOnServer = useCallback(async (owner: string | null, expected: QueuedDraft) => {
    if (!owner || draftGenerationRef.current !== getChatDraftSessionGeneration()) return false;
    const cleared = await clearQueuedMessage(owner, toStoredQueuedMessage(expected));
    if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return false;
    if (!cleared) {
      addMessage({ type: 'error', content: t('input.queue.clearFailed', { defaultValue: 'Could not cancel the queued message. Please try again.' }), timestamp: new Date() });
    }
    return cleared;
  }, [addMessage, t]);

  const editQueuedDraft = useCallback(async () => {
    if (!queuedDraft) {
      return;
    }
    const owner = queuedDraftSessionRef.current;
    const draft = queuedDraft;
    let files: File[];
    try {
      files = await recoverQueuedFiles(draft);
    } catch (error) {
      addMessage({ type: 'error', content: String(error), timestamp: new Date() });
      return;
    }
    if (!await clearQueuedDraftOnServer(owner, draft)) return;
    if (sessionKeyRef.current === owner) setQueuedDraft(null);
    restoreComposerAfterFailedSubmit(draft.content, toUploadedAttachments(files, draft), owner ?? '');
    textareaRef.current?.focus();
  }, [queuedDraft, clearQueuedDraftOnServer, restoreComposerAfterFailedSubmit, addMessage]);

  const deleteQueuedDraft = useCallback(async () => {
    const owner = queuedDraftSessionRef.current;
    if (queuedDraft && await clearQueuedDraftOnServer(owner, queuedDraft) && sessionKeyRef.current === owner) setQueuedDraft(null);
  }, [clearQueuedDraftOnServer, queuedDraft]);

  // 定时消息撤回编辑用：把被撤回的文本放回一个会话的输入框并聚焦，排队消息的
  // 编辑按钮走同一条恢复路径，只是那里还带附件。
  const recallContentToComposer = useCallback((content: string, ownerScope: string) => {
    restoreComposerAfterFailedSubmit(content, [], ownerScope);
    textareaRef.current?.focus();
  }, [restoreComposerAfterFailedSubmit]);

  // Force send starts a new run, which the server refuses while a reply is
  // still in flight (RUN_IN_PROGRESS); only a session whose turn has ended
  // and that waits on background work alone can take one.
  const queueTargetActivity = processingSessions?.get(selectedSession?.id || currentSessionId || '');
  const canForceSendQueuedDraft = provider !== 'claude' && Boolean(hasActiveBackgroundTasks)
    && !(queueTargetActivity && !queueTargetActivity.background);

  const forceSendQueuedDraft = useCallback(async () => {
    if (!canForceSendQueuedDraft || !queuedDraft) {
      return;
    }
    const owner = queuedDraftSessionRef.current;
    const draft = { ...queuedDraft };
    try {
      draft.attachments = await recoverQueuedFiles(draft);
    } catch (error) {
      addMessage({ type: 'error', content: String(error), timestamp: new Date() });
      return;
    }
    if (!await clearQueuedDraftOnServer(owner, draft)) return;
    if (sessionKeyRef.current === sessionKey) {
      setQueuedDraft(null);
      if (await handleSubmitRef.current?.(createFakeSubmitEvent(), draft, true)) return;
    }
    if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return;
    if (sessionKey) {
      try {
        const response = await appendQueuedMessage(sessionKey, toStoredQueuedMessage(draft));
        if (sessionKeyRef.current === sessionKey) {
          setQueuedDraft({ ...draft, content: response.queuedMessage.content,
            uploadedAttachments: response.queuedMessage.attachments, options: response.queuedMessage.options });
        }
      } catch (error) {
        if (sessionKeyRef.current === sessionKey) setQueuedDraft(null);
        restoreComposerAfterFailedSubmit(draft.content, toUploadedAttachments(draft.attachments, draft), sessionKey);
        addMessage({ type: 'error', content: `Failed to restore queued message: ${String(error)}`, timestamp: new Date() });
      }
    }
  }, [canForceSendQueuedDraft, queuedDraft, sessionKey, clearQueuedDraftOnServer, restoreComposerAfterFailedSubmit, addMessage]);

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
    if (draftGenerationRef.current !== getChatDraftSessionGeneration()) return;
    const previousScope = inputOwnerRef.current;
    if (previousScope !== draftScope) {
      inputOwnerRef.current = draftScope;
      updateInput(draftScope ? readDraftText(draftScope) : '');
    } else if (draftScope) {
      writeDraftText(draftScope, inputValueRef.current);
    }
    if (selectedProjectId) safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
  }, [draftScope, selectedProjectId, updateInput]);

  // Uploads belong to this composer and this signed-in user: ending either ends them.
  useEffect(() => {
    const unsubscribe = subscribeToChatDrafts(() => {
      if (draftGenerationRef.current !== getChatDraftSessionGeneration()) attachmentQueue.abortAll();
    });
    return () => {
      unsubscribe();
      attachmentQueue.abortAll();
    };
  }, [attachmentQueue]);

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
  }, [sessionKey, updateInput]);

  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState === 'visible') void hydrateChatDrafts();
    };
    const timer = setInterval(reconcile, 5_000);
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, []);

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

  // Also ends edit mode, matching `cancelEditMessage`: a side question asked
  // while editing a sent message must not leave `editingAnchorId` set over
  // the now-empty composer, which previously turned the next plain send into
  // a `chat.edit-send` that replaced the edited turn and everything after it.
  const clearComposerAfterSideQuestion = useCallback(() => {
    updateInput('');
    setEditingAnchorId(null);
    resetCommandMenuState();
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [resetCommandMenuState, setEditingAnchorId, updateInput]);

  const askSideQuestion = useAskSideQuestion(sendMessage);

  /**
   * Asks the current draft as a side question and, when the frame went out,
   * empties the composer (edit mode included). Refusals — an unsupported
   * provider, a session that does not exist yet — land as timeline errors so
   * they read where the user is looking; nothing typed is lost.
   */
  const askSideQuestionFromComposer = useCallback(
    (sessionId: string | null, text: string) => {
      if (!supportsSideQuestions) {
        addMessage({
          type: 'error',
          content: t('sideQuestion.unsupported'),
          timestamp: Date.now(),
        });
        return;
      }
      if (!sessionId) {
        addMessage({
          type: 'error',
          content: t('sideQuestion.noSession'),
          timestamp: Date.now(),
        });
        return;
      }
      if (askSideQuestion(sessionId, text, { model: currentProviderModel }, isConnected)) {
        clearComposerAfterSideQuestion();
      }
    },
    [addMessage, askSideQuestion, clearComposerAfterSideQuestion, currentProviderModel, isConnected, supportsSideQuestions, t],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Option/Alt+Enter asks a side question in every state (loading,
      // background, idle) and even with the command menu or file-mention
      // dropdown open, so this has to run ahead of
      // `handleCommandMenuKeyDown`/`handleFileMentionsKeyDown` below: both
      // consume a plain Enter to select their highlighted entry and never
      // check altKey, so they would otherwise run the highlighted command
      // or mention instead of asking the side question.
      if (event.key === 'Enter' && event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        askSideQuestionFromComposer(sessionKey, inputValueRef.current);
        return;
      }

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
        } else if (
          !event.shiftKey
          && !event.ctrlKey
          && !event.metaKey
          && !sendByCtrlEnter
          // Submitting on plain Enter strands the newline on a soft keyboard:
          // the return key is the only Enter, and no Shift exists to combine
          // with it. The send button still submits.
          && !isSoftKeyboardEnvironment()
        ) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      askSideQuestionFromComposer,
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

  // The task strip targets background work even while a foreground turn is
  // responding. Leave cards and queued drafts intact until the server settles it.
  const handleAbortBackgroundTasks = useCallback(() => {
    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Background stop requested but no session ID is available.');
      return;
    }
    for (const taskId of new Set(backgroundTasks.flatMap((task) => task.taskId ? [task.taskId] : []))) {
      sendMessage({ type: 'chat.stop-task', sessionId: targetSessionId, taskId });
    }
  }, [backgroundTasks, currentSessionId, selectedSession?.id, sendMessage]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    const activity = processingSessions?.get(targetSessionId);
    if (backgroundTasks.length > 0 && backgroundTasks.every((task) => task.taskId)
      && !(activity && !activity.background)) {
      handleAbortBackgroundTasks();
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [backgroundTasks, canAbortSession, currentSessionId, handleAbortBackgroundTasks, processingSessions, selectedSession?.id, sendMessage]);

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

  /** Runs the current draft through the submit as a steer into the running turn. */
  const steerFromComposer = useCallback(
    () => handleSubmitRef.current?.(createFakeSubmitEvent(), undefined, undefined, { steerIntoTurn: true }),
    [],
  );


  return {
    input,
    setInput: updateInput,
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
    attachments,
    attachmentQueue,
    attachmentBlock,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    /** True while a submitted message is being queued or allocated a session. */
    isSubmitting,
    queuedDraft,
    editQueuedDraft,
    /** Used by ChatInterface to recall a scheduled message's text into the composer. */
    recallContentToComposer,
    deleteQueuedDraft,
    forceSendQueuedDraft,
    canForceSendQueuedDraft,
    steerFromComposer,
    askSideQuestionFromComposer,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    pendingSteers: visiblePendingSteers,
    handleSteerOutcome,
    backgroundTasks,
    hasActiveBackgroundTasks,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handleAbortBackgroundTasks,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}

