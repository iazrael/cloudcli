import { clsx, type ClassValue } from 'clsx';
import { defaultUrlTransform } from 'react-markdown';
import { twMerge } from 'tailwind-merge';

import type { ChatAttachment, Project, ProjectSession, QuickSettingsTab, SlashCommand } from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

//----------------- STORED OUTPUT REFERENCES ------------
/** Chat output previews and export builders recognize only content-addressed display assets. */
export function collectStoredOutputAssets(content: string): string[] {
  return [...new Set(content.match(/\/api\/assets\/(?:images\/inline-[a-f0-9]{64}\.(?:png|jpg|gif|webp|svg)|files\/output-[a-f0-9]{64}\.txt)/g) ?? [])];
}

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI';

/**
 * Resolves the human-readable label for a session.
 *
 * Every provider's session row carries its label in `summary` — the
 * synchronizers write whatever they derive (Cursor: the transcript's first
 * user line) into `custom_name`, and the row surfaces that as `summary`. So
 * there is nothing here to tell providers apart, and the Cursor branch that
 * used to read a `name` field no endpoint sends only hid the real label.
 */
/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId`. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;

export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

/**
 * Whether a slash command goes to the engine as message text instead of being
 * run by cloudcli: a provider skill, or an engine command such as `/compact`.
 * Picking one from the menu inserts it into the composer; sending it skips the
 * built-in command handler.
 */
export const isEnginePromptCommand = (command: SlashCommand): boolean =>
  isSkillCommand(command) || command.type === 'engine';

export const getSessionTitle = (session: ProjectSession): string =>
  (session.summary as string) || 'New Session';

/**
 * Worktree label for a session running in a git worktree of its owning
 * project ("feat/x"): the branch name, falling back to the worktree
 * directory's basename for a detached checkout. Null for main-checkout
 * sessions, whose rows carry no worktree metadata.
 *
 * Used by the workspace header subtitle and the sidebar session rows.
 */
export const getSessionWorktreeLabel = (session: ProjectSession | null): string | null => {
  if (!session) {
    return null;
  }

  const branch = typeof session.worktreeBranch === 'string' ? session.worktreeBranch.trim() : '';
  if (branch) {
    return branch;
  }

  const worktreePath = typeof session.worktreePath === 'string' ? session.worktreePath.trim() : '';
  if (!worktreePath) {
    return null;
  }

  // Server paths arrive normalized per-platform (Windows keeps backslashes),
  // so split on both separators before taking the last segment.
  const segments = worktreePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
};

/**
 * The full session subtitle: owning project name plus the worktree label when
 * the session runs in a worktree ("MirLite · feat/x"). Mirrors the
 * "repo · branch" naming the open-worktree-as-project flow uses, so both
 * surfaces read the same. Rendered by WorkspaceTitle.
 */
export const getSessionSubtitle = (projectDisplayName: string, session: ProjectSession | null): string => {
  const worktreeLabel = getSessionWorktreeLabel(session);
  return worktreeLabel ? `${projectDisplayName} · ${worktreeLabel}` : projectDisplayName;
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

//----------------- DOCUMENT TITLE NOTIFICATIONS ------------

const COMPLETION_TITLE_INDICATOR = '[Done]';
const TITLE_INDICATOR_CLEAR_DELAY_MS = 2000;

// Completion notifications retain their clear deadline and return listeners.
let clearTimer: number | null = null;
let returnListenersAttached = false;

const getIndicatorPrefix = () => `${COMPLETION_TITLE_INDICATOR} `;

const stripIndicator = (title: string): string => {
  const prefix = getIndicatorPrefix();
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
};

const pageIsActive = (): boolean => (
  document.visibilityState === 'visible' && document.hasFocus()
);

const removeReturnListeners = (): void => {
  if (!returnListenersAttached || typeof window === 'undefined') {
    return;
  }

  document.removeEventListener('visibilitychange', handleUserReturn);
  window.removeEventListener('focus', handleUserReturn, true);
  window.removeEventListener('click', handleUserReturn, true);
  returnListenersAttached = false;
};

const clearTitleIndicator = (): void => {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }

  removeReturnListeners();
  removePageInactiveListener();

  if (document.title.startsWith(getIndicatorPrefix())) {
    document.title = stripIndicator(document.title);
  }
};

const removePageInactiveListener = (): void => {
  document.removeEventListener('visibilitychange', handlePageInactive);
};

const scheduleClear = (): void => {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
  }

  clearTimer = window.setTimeout(() => {
    clearTitleIndicator();
  }, TITLE_INDICATOR_CLEAR_DELAY_MS);

  removePageInactiveListener();
  document.addEventListener('visibilitychange', handlePageInactive, { once: true });
};

function handleUserReturn(): void {
  if (!pageIsActive()) {
    return;
  }

  // Background completions keep the marker indefinitely. A tab click normally
  // surfaces as visibility/focus, while an in-page click is a useful fallback.
  scheduleClear();
}

function handlePageInactive(): void {
  if (document.visibilityState !== 'hidden') {
    return;
  }

  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }

  if (!returnListenersAttached) {
    document.addEventListener('visibilitychange', handleUserReturn);
    window.addEventListener('focus', handleUserReturn, true);
    window.addEventListener('click', handleUserReturn, true);
    returnListenersAttached = true;
  }
}

/** Chat realtime completion uses the shared page-title notification lifecycle. */
export const showCompletionTitleIndicator = (): void => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  const baseTitle = stripIndicator(document.title || 'CloudCLI');
  document.title = `${getIndicatorPrefix()}${baseTitle}`;

  if (pageIsActive()) {
    scheduleClear();
    return;
  }

  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }

  if (!returnListenersAttached) {
    document.addEventListener('visibilitychange', handleUserReturn);
    window.addEventListener('focus', handleUserReturn, true);
    window.addEventListener('click', handleUserReturn, true);
    returnListenersAttached = true;
  }
};

/**
 * Workspace selection updates the base document title. Same-session metadata
 * updates preserve a pending completion marker; navigating to another target
 * clears that marker through the existing notification cleanup path.
 */
export function setPageTitle(title: string, preserveCompletion: boolean): void {
  if (!preserveCompletion) clearTitleIndicator();
  document.title = `${preserveCompletion && document.title.startsWith(getIndicatorPrefix()) ? getIndicatorPrefix() : ''}${title}`;
}

// ---------------------------

// Fork: storage access guarded for contexts where localStorage is unavailable.
export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        // The draft mirror is the largest disposable thing in storage, and
        // dropping it costs nothing: the server copy is authoritative and is
        // read back on the next hydrate.
        localStorage.removeItem('chat-drafts');

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

// ---------------------------

//----------------- BUILD VERSION DISPLAY ------------

/**
 * Formats the version line shown by the auth loading screen and the settings
 * About tab. `commit` comes from `git describe --tags --always --dirty`: when
 * it is tag-anchored (`v2.1.0`, `v2.1.0-5-g273e294`) it already carries the
 * version, so it is shown alone — prefixing the package version would read
 * "v2.1.0(v2.1.0)" on release day. Only the bare `--always` hash fallback
 * (built from a tree no tag can reach) is shown next to the package
 * version, and an absent commit leaves the plain package version.
 */
export function formatBuildVersion(version: string, commit: string): string {
  if (!commit) {
    return version ? `v${version}` : '';
  }
  if (/^v\d/.test(commit)) {
    return commit;
  }
  return `v${version}(${commit})`;
}

// ---------------------------

//----------------- FILE DOWNLOAD HAND-OFF ------------

/**
 * Hands a finished blob to the user as a saved file. On iOS — the installed
 * PWA especially — an `<a download>` click navigates the webview to the blob
 * URL instead of downloading, and coming back reloads the whole app; the Web
 * Share API is the platform answer there (Save to Files, AirDrop, …) and
 * never navigates away. Environments that cannot share files keep the
 * classic download link. Used by the chat file cards and transcript export,
 * the file tree, the code editor, and the diagnostics report.
 */
export async function saveOrShareBlob(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      // Dismissing the sheet is a normal outcome, not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // Anything else (e.g. a stale user gesture) falls through to the link.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------

//----------------- REQUEST IDENTITY ------------

/** Creates an identity for one user action; reuse it for retries of that action. */
export function createClientRequestId(): string {
  // Non-secure contexts (plain-HTTP LAN access) have no crypto.randomUUID.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `submit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------

//----------------- CHAT ATTACHMENTS ------------

/**
 * Whether an uploaded chat attachment is an image, by MIME type or, for
 * descriptors that carry none, by file extension. Splits a message's
 * attachments into the `images` and `files` its timeline row shows.
 */
export function isImageAttachment(attachment: ChatAttachment): boolean {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
}

// ---------------------------

//----------------- MARKDOWN URLS ------------

/** 聊天渲染与地址识别共用：仅识别带明确图片扩展名的文件引用或 HTTP 地址，不读取文件。 */
export function isImageReference(value: string): boolean {
  const reference = value.trim();
  const imageExtension = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
  if (!reference || /[\r\n<>"'`|]/.test(reference)) return false;
  if (/^(?:https?:\/\/|\/\/)/i.test(reference)) {
    try {
      return imageExtension.test(new URL(reference, window.location.href).pathname);
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) && !/^(?:file:\/\/|[a-z]:[/\\])/i.test(reference)) return false;
  if (/\s/.test(reference) && !/^(?:[/\\]|\.{1,2}[/\\]|[a-z]:[/\\]|file:\/\/)/i.test(reference)) return false;
  if (/^[^/\\]*=/.test(reference)) return false;
  return imageExtension.test(reference) || imageExtension.test(reference.split(/[?#]/)[0]);
}

/**
 * Whether a URL points at a local file (`file://`). Providers such as
 * Antigravity link workspace-external documents and their images this way.
 */
export const isFileUrl = (url?: string): boolean => /^file:\/\//i.test(url ?? '');

/** Whether a URL is a Windows absolute path, in either separator or percent-escaped form. */
export const isWindowsAbsolutePath = (url?: string): boolean =>
  /^[a-zA-Z]:([/\\]|%5[cC])/i.test(url ?? '');

/**
 * The `urlTransform` hook to hand react-markdown: it keeps `file://` URLs and
 * Windows absolute paths verbatim and delegates every other URL to the
 * library's default sanitization, whose `file:` handling would strip the scheme
 * and destroy the path. Use it for any markdown that can reference local files.
 */
export const markdownUrlTransform = (url: string): string =>
  isFileUrl(url) || isWindowsAbsolutePath(url) ? url : defaultUrlTransform(url);

/**
 * Converts a `file://` URL back into an absolute filesystem path, decoding
 * percent-escapes so paths with spaces or non-ASCII characters survive. Returns
 * undefined for anything that is not a local `file://` URL (remote hosts such
 * as `file://server/share` are not local paths).
 */
export const filePathFromFileUrl = (href?: string): string | undefined => {
  if (!isFileUrl(href)) {
    return undefined;
  }
  try {
    const url = new URL(href as string);
    if (url.host && url.host !== 'localhost') {
      return undefined;
    }
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
};

/**
 * Turns a markdown link `href` into the filesystem reference the code editor
 * should open. react-markdown percent-escapes non-ASCII characters and spaces
 * before handing an href to a custom renderer, so those are decoded back; web
 * and other non-file schemes are left alone instead of being decoded.
 */
export const fileReferenceFromMarkdownHref = (href?: string): string | undefined => {
  if (!href) {
    return undefined;
  }

  if (isFileUrl(href)) {
    return filePathFromFileUrl(href) ?? href;
  }

  if (!isWindowsAbsolutePath(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href;
  }

  try {
    return decodeURIComponent(href);
  } catch {
    // A literal or incomplete percent escape may be part of a valid filename.
    return href;
  }
};
