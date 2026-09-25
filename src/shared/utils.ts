import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { Project, ProjectSession } from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

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
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session.
 *
 * Every provider's session row carries its label in `summary` — the
 * synchronizers write whatever they derive (Cursor: the transcript's first
 * user line) into `custom_name`, and the row surfaces that as `summary`. So
 * there is nothing here to tell providers apart, and the Cursor branch that
 * used to read a `name` field no endpoint sends only hid the real label.
 */
export const getSessionTitle = (session: ProjectSession): string =>
  (session.summary as string) || 'New Session';

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

//----------------- MARKDOWN LATEX DELIMITERS ------------

/** A fenced code block opener: up to three spaces of indent, then a ``` or ~~~ run. */
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** An inline code span: a backtick run closed by an equal-length run. */
const INLINE_CODE_SPAN_PATTERN = /(`+)[\s\S]*?\1/g;

/** A LaTeX display-math pair: `\[ ... \]`. */
const DISPLAY_MATH_PATTERN = /\\\[([\s\S]*?)\\\]/g;

/** A LaTeX inline-math pair: `\( ... \)`. */
const INLINE_MATH_PATTERN = /\\\(([\s\S]*?)\\\)/g;

/**
 * A single-dollar inline-math pair on one line. Display `$$` runs and escaped
 * `\$` are excluded, and the delimiters must hug the content, so plain currency
 * prose such as `$5 and $10` never matches.
 */
const SINGLE_DOLLAR_MATH_PATTERN = /(?<![\\$])\$(?![$\s])([^\n$]+?)(?<!\s)(?<!\\)\$(?!\$)/g;

/**
 * Reads the content of a `$...$` pair as LaTeX rather than currency: it carries
 * a command (`\times`), script (`_`, `^`), group (`{`, `}`), or equality, or is
 * a lone variable. Only hinted pairs get promoted, since remark-math runs with
 * `singleDollarTextMath: false` to keep dollar amounts literal.
 */
function looksLikeInlineMath(body: string): boolean {
  return /[\\_^={}]/.test(body) || /^[A-Za-z]$/.test(body);
}

type OpenFence = { marker: string; length: number };

/** Reads a fence line's marker, or null when the line is not a fence. Private to the math normalizer. */
function readFence(line: string): OpenFence | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  return match ? { marker: match[1][0], length: match[1].length } : null;
}

/** CommonMark: a closing fence repeats the opener's marker, at least as long, with no info string. */
function closesFence(open: OpenFence, candidate: OpenFence, line: string): boolean {
  return (
    candidate.marker === open.marker &&
    candidate.length >= open.length &&
    line.trim().replace(/^[`~]+/, '').trim() === ''
  );
}

/**
 * Rewrites the delimiters in one run of non-fence lines, masking inline code
 * spans so LaTeX samples inside them survive. The run is converted as a whole
 * so a display formula can open on one line and close on another.
 */
function convertMathDelimiters(source: string): string {
  if (!source.includes('\\[') && !source.includes('\\(') && !source.includes('$')) {
    return source;
  }

  const convert = (value: string) =>
    value
      .replace(DISPLAY_MATH_PATTERN, (_match, body: string) => '$$' + body + '$$')
      .replace(INLINE_MATH_PATTERN, (_match, body: string) => '$$' + body + '$$')
      .replace(SINGLE_DOLLAR_MATH_PATTERN, (match, body: string) =>
        looksLikeInlineMath(body) ? '$$' + body + '$$' : match,
      );

  if (!source.includes('`')) {
    return convert(source);
  }

  const codeSpans: string[] = [];
  const masked = source.replace(INLINE_CODE_SPAN_PATTERN, (span) => {
    codeSpans.push(span);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  return convert(masked).replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)]);
}

/**
 * Rewrites LaTeX delimiters into the `$$...$$` form remark-math parses:
 * `\[...\]` and `\(...\)` (whose backslash CommonMark drops as an escape) plus
 * single-dollar `$...$` pairs that read as LaTeX, which were left literal
 * because remark-math runs with `singleDollarTextMath: false`. Currency stays
 * untouched. Fenced code blocks and inline code spans pass through untouched.
 * Apply it to every Markdown string before handing it to react-markdown; the
 * chat transcript and MarkdownPreview both do.
 */
export function normalizeLatexMathDelimiters(text: string): string {
  if (!text.includes('\\[') && !text.includes('\\(') && !text.includes('$')) {
    return text;
  }

  const lines = text.split('\n');
  const output: string[] = [];
  let openFence: OpenFence | null = null;
  // Non-fence lines accumulate here and convert as one run, so the formula
  // delimiters may sit on different lines. A fence line flushes the run.
  let run: string[] = [];

  const flushRun = () => {
    if (run.length > 0) {
      output.push(...convertMathDelimiters(run.join('\n')).split('\n'));
      run = [];
    }
  };

  for (const line of lines) {
    const candidate = readFence(line);
    if (candidate) {
      if (!openFence) {
        flushRun();
        openFence = candidate;
      } else if (closesFence(openFence, candidate, line)) {
        openFence = null;
      }
      output.push(line);
      continue;
    }

    if (openFence) {
      output.push(line);
    } else {
      run.push(line);
    }
  }

  flushRun();
  return output.join('\n');
}

//----------------- LOCAL DATE-TIME INPUT ------------

/**
 * Reads a `datetime-local` input value as the instant the user picked.
 *
 * The input carries no zone, and `new Date(value)` reads it in the browser's
 * zone — which is what the user meant, since they picked it off their own
 * clock. Returns null for an empty or malformed value.
 */
export function readLocalDateTimeInputValue(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Formats an instant for a `datetime-local` input, in the browser's zone.
 *
 * The inverse of `readLocalDateTimeInputValue`, so editing an existing one-off
 * task shows its time instead of shifting it by the zone offset.
 */
export function toLocalDateTimeInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

// ---------------------------
