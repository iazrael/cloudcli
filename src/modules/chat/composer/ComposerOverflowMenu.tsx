import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Clock, PlusIcon, SquareSlashIcon, XIcon } from 'lucide-react';

import { formatTokenCount, readTokenUsageTotals } from '@/modules/chat/composer/tokenUsage';
import { ComposerMenuItem } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { PromptInputButton } from '@/modules/chat/composer/PromptInputFork';
import { ScheduleMessageContent } from '@/modules/chat/composer/ScheduleMessagePopover';

/** What the ＋ panel is showing: the tool list, or the schedule form inside it. */
type OverflowMenuView = 'menu' | 'schedule';

type ComposerOverflowMenuProps = {
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  /** The box holds a schedulable draft; scheduled send is dimmed without one. */
  canSchedule: boolean;
  hasInput: boolean;
  onClearInput: () => void;
  onScheduleMessage: (scheduledFor: Date) => void;
  /** Creates a task bound to the current session instead of a one-off message. */
  onScheduleTask: (schedule: {
    cronExpression?: string;
    runAt?: string;
    timezone: string;
    /** Days before the bound session is rotated; omitted never rotates. */
    rotateAfterDays?: number;
  }) => void;
  /** Whether the engine also schedules inside its own session (drives the hint). */
  supportsNativeScheduling: boolean;
  /** Whether the scheduled-tasks feature is on; hides the recurring half when off. */
  recurringEnabled: boolean;
};

const PANEL_PREFERRED_WIDTH = 340;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

type PanelAnchor = {
  left: number;
  bottom: number;
  maxHeight: number;
  width: number;
};

/**
 * Rendered by chat's ChatComposer as the mobile composer's "＋" entry: the
 * low-frequency tools — token usage, slash commands, scheduled send, clear
 * input — collect behind it so the main row only carries high-frequency
 * controls. Anchored above its trigger growing rightward (the mirror image of
 * the desktop menus, which grow leftward from the send side).
 */
export function ComposerOverflowMenu({
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  canSchedule,
  hasInput,
  onClearInput,
  onScheduleMessage,
  onScheduleTask,
  supportsNativeScheduling,
  recurringEnabled,
}: ComposerOverflowMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  // Which half is open; reset when the panel closes so it always reopens on the list.
  const [view, setView] = useState<OverflowMenuView>('menu');
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    setView('menu');
  }, []);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setAnchor({
      left: Math.max(VIEWPORT_MARGIN, rect.left),
      bottom: window.innerHeight - rect.top + MENU_GAP,
      maxHeight: Math.max(160, rect.top - MENU_GAP - VIEWPORT_MARGIN),
      width: Math.min(PANEL_PREFERRED_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2),
    });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        close();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, close, updateAnchor]);

  const { usedTokens, contextWindow } = readTokenUsageTotals(tokenBudget);

  return (
    <>
      <PromptInputButton
        ref={triggerRef}
        tooltip={{ content: t('input.moreTools') }}
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        aria-label={t('input.moreTools')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="relative"
      >
        <PlusIcon />
      </PromptInputButton>

      {isOpen && anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('input.moreTools')}
          className="fixed z-[100] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          style={{
            left: anchor.left,
            bottom: anchor.bottom,
            maxHeight: anchor.maxHeight,
            width: anchor.width,
          }}
        >
          {view === 'menu' ? (
            <>
              {contextWindow > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onShowTokenUsage();
                  }}
                  className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{t('input.contextUsage')}</span>
                    <span className="font-medium text-foreground">
                      {formatTokenCount(usedTokens)} / {formatTokenCount(contextWindow)}
                    </span>
                  </span>
                  <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, Math.round((usedTokens / contextWindow) * 100))}%` }}
                    />
                  </span>
                </button>
              )}

              <ComposerMenuItem
                role="menuitem"
                icon={<SquareSlashIcon className="h-4 w-4" />}
                label={t('input.showAllCommands')}
                isSelected={false}
                trailing={
                  slashCommandsCount > 0 ? (
                    <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                      {slashCommandsCount}
                    </span>
                  ) : undefined
                }
                onSelect={() => {
                  close();
                  onToggleCommandMenu();
                }}
              />

              <ComposerMenuItem
                role="menuitem"
                icon={<Clock className="h-4 w-4" />}
                label={t('schedule.trigger')}
                isSelected={false}
                disabled={!canSchedule}
                onSelect={() => setView('schedule')}
              />

              {hasInput && (
                <ComposerMenuItem
                  role="menuitem"
                  icon={<XIcon className="h-4 w-4" />}
                  label={t('input.clearInput')}
                  isSelected={false}
                  onSelect={() => {
                    close();
                    onClearInput();
                  }}
                />
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setView('menu')}
                aria-label={t('schedule.heading')}
                className="flex items-center rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <ScheduleMessageContent
                onSchedule={onScheduleMessage}
                onScheduleTask={onScheduleTask}
                supportsNativeScheduling={supportsNativeScheduling}
                recurringEnabled={recurringEnabled}
                onDone={close}
              />
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

export default ComposerOverflowMenu;
