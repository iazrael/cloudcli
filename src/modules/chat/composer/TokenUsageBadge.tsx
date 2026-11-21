import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import {
  formatTokenCount,
  getTokenUsageAlert,
  readTokenUsageTotals,
} from '@/modules/chat/composer/tokenUsage';

type TokenUsageBadgeProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

/**
 * Rendered by chat's ChatComposer in the mobile composer row. The context
 * window's usage stays invisible until it closes in on full, then shows as a
 * compact count — amber from 85%, red from 95% — that opens the detailed
 * breakdown on tap, standing in for the full TokenUsageSummary chip.
 */
function TokenUsageBadge({ usage, onClick }: TokenUsageBadgeProps) {
  const { t } = useTranslation();
  const { usedTokens, contextWindow } = readTokenUsageTotals(usage);
  const alert = getTokenUsageAlert(usedTokens, contextWindow);
  if (!alert) {
    return null;
  }

  // The badge measures the context window's current occupancy, not the
  // session's spend; the tooltip says which model window it is measured
  // against so the number cannot be read as a total.
  const title = contextWindow > 0
    ? t('chat:misc.contextTokensUsed', {
      used: formatTokenCount(usedTokens),
      total: formatTokenCount(contextWindow),
      defaultValue: 'Current context: {{used}} / {{total}} tokens',
    })
    : t('chat:misc.tokensUsed', { count: usedTokens });

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-11 shrink-0 items-center rounded-lg border px-2 text-xs font-medium shadow-sm transition-colors',
        alert === 'critical'
          ? 'border-red-400/60 bg-red-500/10 text-red-600 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-400'
          : 'border-amber-400/60 bg-amber-500/10 text-amber-600 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-400',
      )}
      title={title}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      {formatTokenCount(usedTokens)}
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this badge's numbers only move when a turn ends. */
export default memo(TokenUsageBadge);
