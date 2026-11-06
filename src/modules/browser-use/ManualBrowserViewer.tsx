import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  Delete,
  Loader2,
  RotateCw,
  Send,
} from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import type { BrowserUseSession } from '@/shared/types';
import { toScrollDelta, toViewportPoint } from '@/modules/browser-use/utils/remoteViewport';

// Mirrors the server's MANUAL_MAX_SCROLL_DELTA so the client never sends a
// request the route would reject.
const MANUAL_SCROLL_LIMIT = 5000;
// Taps below this distance count as clicks; larger drags become scroll wheels.
const SWIPE_THRESHOLD_PX = 12;
const POLL_INTERVAL_MS = 1500;

const clampScrollDelta = (value: number): number =>
  Math.max(-MANUAL_SCROLL_LIMIT, Math.min(MANUAL_SCROLL_LIMIT, value));

type ManualBrowserViewerProps = {
  session: BrowserUseSession;
  /** Receives the refreshed session (with a fresh screenshot) after every action or poll tick. */
  onSessionUpdated: (session: BrowserUseSession) => void;
  /** Receives raw errors; the panel owns error localization and display. */
  onError: (error: unknown) => void;
};

/**
 * Remote-control view for user-created browser sessions, used by the project
 * workspace Browser panel (inline card and fullscreen overlay). Renders the
 * address bar, live screenshot, tap-to-click/swipe-to-scroll surface, and the
 * text input row.
 */
export function ManualBrowserViewer({ session, onSessionUpdated, onError }: ManualBrowserViewerProps) {
  const { t } = useTranslation('settings');
  // True while a control request is in flight; blocks re-entrancy and pauses polling.
  const [isBusy, setIsBusy] = useState(false);
  // Address bar draft; synced from polled page URL unless the user is editing it.
  const [urlDraft, setUrlDraft] = useState(session.url ?? '');
  // Text queued for the page's focused element via the keyboard bridge.
  const [textDraft, setTextDraft] = useState('');
  const imageRef = useRef<HTMLImageElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  // Guards against overlapping poll ticks when a screenshot takes longer than
  // the interval; late responses would otherwise roll back newer frames.
  const pollInFlightRef = useRef(false);
  // Stops polling after repeated failures (e.g. the session was stopped
  // elsewhere) so the viewer surfaces one error instead of looping on 500s.
  const pollStoppedRef = useRef(false);
  const consecutivePollFailuresRef = useRef(0);

  const runControl = useCallback(async (action: () => Promise<Response>) => {
    setIsBusy(true);
    try {
      const response = await action();
      const data = await readApiJson<{ data: { session: BrowserUseSession } }>(response);
      onSessionUpdated(data.data.session);
    } catch (error) {
      onError(error);
    } finally {
      setIsBusy(false);
    }
  }, [onSessionUpdated, onError]);

  // Reset the failure latch when the viewer switches to another session so a
  // previously stopped session cannot keep the new one from polling.
  useEffect(() => {
    pollStoppedRef.current = false;
    consecutivePollFailuresRef.current = 0;
  }, [session.id]);

  // Poll a fresh screenshot while the session is live so the view keeps up
  // with pages that move on their own (redirects, timers, animations). Transient
  // poll failures stay silent; after three in a row (session likely stopped
  // elsewhere) the loop halts and surfaces the error once.
  useEffect(() => {
    if (session.status !== 'ready') return;
    const timer = window.setInterval(() => {
      if (isBusy || pollStoppedRef.current || pollInFlightRef.current || document.visibilityState !== 'visible') return;
      void (async () => {
        pollInFlightRef.current = true;
        try {
          const response = await api.browserUse.screen(session.id);
          const data = await readApiJson<{ data: { session: BrowserUseSession } }>(response);
          consecutivePollFailuresRef.current = 0;
          onSessionUpdated(data.data.session);
        } catch (error) {
          consecutivePollFailuresRef.current += 1;
          if (consecutivePollFailuresRef.current >= 3) {
            pollStoppedRef.current = true;
            onError(error);
          }
        } finally {
          pollInFlightRef.current = false;
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [session.id, session.status, isBusy, onSessionUpdated, onError]);

  // Follow page redirects in the address bar, but never clobber what the user is typing.
  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) {
      setUrlDraft(session.url ?? '');
    }
  }, [session.url]);

  const isReady = session.status === 'ready';

  const submitAddress = () => {
    const url = urlDraft.trim();
    if (!url || isBusy) return;
    void runControl(() => api.browserUse.navigate(session.id, url));
  };

  const sendText = () => {
    const text = textDraft;
    if (!text || isBusy) return;
    void runControl(async () => {
      setTextDraft('');
      return await api.browserUse.typeText(session.id, text);
    });
  };

  const handleSurfaceClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (isBusy || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const point = toViewportPoint(
      { x: event.clientX, y: event.clientY },
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      session.viewport,
    );
    if (!point) return;
    void runControl(() => api.browserUse.click(session.id, point.x, point.y));
  };

  const handleTouchStart = (event: ReactTouchEvent<HTMLImageElement>) => {
    const touch = event.touches[0];
    touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const handleTouchEnd = (event: ReactTouchEvent<HTMLImageElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || isBusy) return;

    const delta = toScrollDelta(start, { x: touch.clientX, y: touch.clientY });
    if (Math.abs(delta.deltaX) < SWIPE_THRESHOLD_PX && Math.abs(delta.deltaY) < SWIPE_THRESHOLD_PX) {
      return;
    }

    // Suppress the synthetic click some platforms still fire after a drag
    // that already exceeded the tap threshold.
    event.preventDefault();

    void runControl(() => api.browserUse.scroll(
      session.id,
      clampScrollDelta(delta.deltaX),
      clampScrollDelta(delta.deltaY),
    ));
  };

  const navButtonClass = 'h-7 w-7 shrink-0 p-0';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/30 px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className={navButtonClass}
          disabled={!isReady || isBusy}
          onClick={() => void runControl(() => api.browserUse.nav(session.id, 'back'))}
          title={t('browserUse.back')}
          aria-label={t('browserUse.back')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={navButtonClass}
          disabled={!isReady || isBusy}
          onClick={() => void runControl(() => api.browserUse.nav(session.id, 'forward'))}
          title={t('browserUse.forward')}
          aria-label={t('browserUse.forward')}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={navButtonClass}
          disabled={!isReady || isBusy}
          onClick={() => void runControl(() => api.browserUse.nav(session.id, 'reload'))}
          title={t('browserUse.reload')}
          aria-label={t('browserUse.reload')}
        >
          <RotateCw className={cn('h-3.5 w-3.5', isBusy && 'animate-spin')} />
        </Button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submitAddress();
          }}
        >
          <input
            ref={addressInputRef}
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder={t('browserUse.addressPlaceholder')}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/50"
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={!isReady || isBusy}
          >
            {t('browserUse.go')}
          </Button>
        </form>
      </div>

      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-neutral-950 p-2">
        {session.screenshotDataUrl ? (
          <img
            ref={imageRef}
            src={session.screenshotDataUrl}
            alt={t('browserUse.screenshotAlt')}
            draggable={false}
            onClick={handleSurfaceClick}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className={cn('max-w-full select-none', isBusy && 'opacity-80')}
            style={{ touchAction: 'none' }}
          />
        ) : (
          <div className="px-6 py-10 text-center text-sm text-neutral-300">
            {session.message || t('browserUse.waitingScreenshot')}
          </div>
        )}
        {isBusy && (
          <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-neutral-300" />
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border/60 bg-muted/30 px-2 py-1.5">
        <input
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              sendText();
            }
          }}
          placeholder={t('browserUse.textPlaceholder')}
          autoComplete="off"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/50"
        />
        <Button
          variant="outline"
          size="sm"
          className={navButtonClass}
          disabled={!isReady || isBusy || !textDraft}
          onClick={sendText}
          title={t('browserUse.send')}
          aria-label={t('browserUse.send')}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={navButtonClass}
          disabled={!isReady || isBusy}
          onClick={() => void runControl(() => api.browserUse.pressKey(session.id, 'Enter'))}
          title={t('browserUse.enterLabel')}
          aria-label={t('browserUse.enterLabel')}
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={navButtonClass}
          disabled={!isReady || isBusy}
          onClick={() => void runControl(() => api.browserUse.pressKey(session.id, 'Backspace'))}
          title={t('browserUse.backspaceLabel')}
          aria-label={t('browserUse.backspaceLabel')}
        >
          <Delete className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="px-2 pb-1 text-[10px] text-muted-foreground">{t('browserUse.manualHint')}</p>
    </div>
  );
}
