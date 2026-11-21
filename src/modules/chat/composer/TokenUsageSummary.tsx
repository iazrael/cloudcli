import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatTokenCount, readTokenUsageTotals } from '@/modules/chat/composer/tokenUsage';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

/**
 * Rendered by chat's ChatComposer to show the session's context-window usage
 * and open the detailed token breakdown on click.
 */
function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const { usedTokens, contextWindow } = readTokenUsageTotals(usage);
  // The button measures the context window's current occupancy, not the
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
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="hidden h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary sm:grid">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">
        {t('chat:misc.tokensLabel', { count: usedTokens })}
      </span>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
