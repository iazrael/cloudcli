import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { readContextUsage } from '@/modules/chat/utils/contextUsage';

type ContextUsageBarProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

/** Fill color ramp so a filling window reads at a glance: normal, warm, critical. */
const fillColorForPercent = (percent: number): string => {
  if (percent >= 85) {
    return 'bg-red-500';
  }
  if (percent >= 60) {
    return 'bg-amber-500';
  }
  return 'bg-emerald-500';
};

/**
 * Rendered by chat's ChatComposer as a slim progress line on the composer's top
 * edge, showing how full the context window is at every viewport. Tapping it
 * opens the token usage breakdown (`/cost`); it is deliberately text-free so it
 * adds no width to the tool row. `TokenUsageSummary` carries the token count
 * and, from `sm` up, the same percentage as text.
 */
export function ContextUsageBar({ usage, onClick }: ContextUsageBarProps) {
  const { t } = useTranslation();
  const { percent } = readContextUsage(usage);
  if (percent === null) {
    return null;
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onClick?.();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('chat:misc.showTokenUsage')}
      title={t('chat:misc.contextUsedPercent', { percent })}
      className="absolute inset-x-0 top-0 z-20 h-1 cursor-pointer border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={`block h-full rounded-r-full transition-[width] duration-500 ${fillColorForPercent(percent)}`}
        style={{ width: `${percent}%` }}
      />
    </button>
  );
}
