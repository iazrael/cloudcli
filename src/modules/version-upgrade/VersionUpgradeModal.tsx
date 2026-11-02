import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/shared/api";
import { BUILD_INFO } from "@/shared/constants";
import { useBusySessionIdSet } from "@/shared/context/SessionProtectionContext";
import type { SystemUpdateRefusal, SystemUpdateStatus } from "@/shared/types";

type VersionUpgradeModalProps = {
    isOpen: boolean;
    onClose: () => void;
    status: SystemUpdateStatus | null;
    /** Re-reads the status; `true` forces a `git fetch`. */
    reload: (refresh?: boolean) => Promise<SystemUpdateStatus | null>;
    checkNow: () => Promise<SystemUpdateStatus | null>;
    isChecking: boolean;
};

/** Fast enough to follow build steps, slow enough to stay cheap while the server is down. */
const JOB_POLL_MS = 2000;
const MANUAL_UPDATE_COMMAND = 'git pull && npm install && npm run build && pm2 restart cloudcli';

const shortHash = (hash: string | null | undefined) => (hash ? hash.slice(0, 7) : '—');

/** This module's only public export: rendered by the sidebar and settings modules to show the checkout's update status and run "update and restart". */
export function VersionUpgradeModal({
    isOpen,
    onClose,
    status,
    reload,
    checkNow,
    isChecking,
}: VersionUpgradeModalProps) {
    const { t } = useTranslation('common');
    const runningSessionCount = useBusySessionIdSet().size;
    // Id of the job this modal started, so its outcome (and only its outcome)
    // drives the success reload and the failure report.
    const [startedJobId, setStartedJobId] = useState<string | null>(null);
    // The POST is refused synchronously for reasons the status may not show yet.
    const [startError, setStartError] = useState<string | null>(null);
    // Disables the action between the click and the POST's answer.
    const [isStarting, setIsStarting] = useState(false);

    const job = status?.job ?? null;
    const jobActive = job?.state === 'running' || job?.state === 'restarting';
    const ownJob = job && startedJobId === job.id ? job : null;
    const showJob = jobActive || ownJob !== null;

    // Follow the job closely while it runs; the status request simply fails
    // while PM2 restarts the server, and polling resumes once it answers.
    useEffect(() => {
        if (!isOpen || !(jobActive || (startedJobId && !ownJob))) return;
        const interval = window.setInterval(() => void reload(), JOB_POLL_MS);
        return () => window.clearInterval(interval);
    }, [isOpen, jobActive, startedJobId, ownJob, reload]);

    // The new server settled our job as succeeded: load the new bundle,
    // bypassing any cached assets from the previous build.
    useEffect(() => {
        if (ownJob?.state !== 'succeeded') return;
        const timeout = window.setTimeout(() => {
            const url = new URL(window.location.href);
            url.searchParams.set('_hardReload', Date.now().toString());
            window.location.replace(url.toString());
        }, 1500);
        return () => window.clearTimeout(timeout);
    }, [ownJob?.state]);

    const handleStart = useCallback(async () => {
        setIsStarting(true);
        setStartError(null);
        try {
            const response = await api.system.update();
            const body = await response.json().catch(() => null) as
                | { jobId?: string; error?: { code?: SystemUpdateRefusal; message?: string } }
                | null;
            if (response.ok && body?.jobId) {
                setStartedJobId(body.jobId);
                await reload();
                return;
            }
            const code = body?.error?.code;
            setStartError(code
                ? t(`versionUpdate.refusal.${code}`, { defaultValue: body?.error?.message ?? code })
                : t('versionUpdate.refusal.unknown', { status: response.status }));
            await reload();
        } catch (error) {
            setStartError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsStarting(false);
        }
    }, [reload, t]);

    if (!isOpen) return null;

    const mode = status?.availableMode ?? null;
    const blockedReason = !status
        ? null
        : !status.supported
            ? status.reason
            : status.dirtyFiles.length > 0
                ? 'dirty'
                : status.diverged
                    ? 'diverged'
                    : null;
    const canStart = Boolean(status?.supported && mode && !blockedReason && !jobActive && !isStarting);

    const title = showJob
        ? job?.state === 'failed'
            ? t('versionUpdate.failedTitle')
            : job?.state === 'succeeded'
                ? t('versionUpdate.succeededTitle')
                : t('versionUpdate.updatingTitle')
        : mode === 'pull'
            ? t('versionUpdate.title')
            : mode === 'rebuild'
                ? t('versionUpdate.rebuildTitle')
                : t('versionUpdate.upToDate');
    const subtitle = mode === 'pull'
        ? t('versionUpdate.commitsBehind', { count: status?.behind ?? 0, upstream: status?.upstream ?? '' })
        : mode === 'rebuild'
            ? t('versionUpdate.rebuildHint')
            : status?.upstream ?? '';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <button
                className="fixed inset-0 bg-black/50 backdrop-blur-sm"
                onClick={onClose}
                aria-label={t('versionUpdate.ariaLabels.closeModal')}
            />

            <div className="relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                            <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
                            {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                    >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Build / checkout identity */}
                <div className="space-y-2">
                    <InfoRow label={t('versionUpdate.runningBuild')} value={BUILD_INFO.describe || shortHash(status?.builtCommit)} />
                    <InfoRow label={t('versionUpdate.localHead')} value={`${status?.branch ?? '—'} @ ${shortHash(status?.headCommit)}`} />
                    <InfoRow
                        label={t('versionUpdate.remote')}
                        value={`${status?.upstream ?? '—'} @ ${shortHash(status?.remoteCommit)}`}
                        highlight={mode === 'pull'}
                    />
                    {status?.lastFetchedAt && (
                        <p className="text-right text-[11px] text-gray-400">
                            {t('versionUpdate.lastChecked', { time: new Date(status.lastFetchedAt).toLocaleString() })}
                        </p>
                    )}
                </div>

                {status?.fetchError && (
                    <Notice tone="amber">{t('versionUpdate.fetchFailed', { error: status.fetchError })}</Notice>
                )}

                {/* Incoming commits */}
                {mode === 'pull' && status && status.commits.length > 0 && !showJob && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.incomingCommits')}</h3>
                        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-700/50">
                            {status.commits.map((commit) => (
                                <li key={commit.hash} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                                    <code className="flex-shrink-0 font-mono text-xs text-gray-400">{commit.hash}</code>
                                    <span className="min-w-0 break-words">{commit.subject}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Why the update cannot run */}
                {blockedReason && !showJob && (
                    <Notice tone="red">
                        <p>{t(`versionUpdate.blocked.${blockedReason}`, { upstream: status?.upstream ?? '' })}</p>
                        {blockedReason === 'dirty' && status && (
                            <ul className="mt-1 list-inside list-disc font-mono text-[11px]">
                                {status.dirtyFiles.map((file) => <li key={file}>{file}</li>)}
                            </ul>
                        )}
                        {blockedReason === 'not-pm2' && (
                            <code className="mt-1 block font-mono text-[11px]">{MANUAL_UPDATE_COMMAND}</code>
                        )}
                    </Notice>
                )}

                {/* What pressing the button will do to live work */}
                {canStart && (
                    <Notice tone={runningSessionCount > 0 ? 'amber' : 'blue'}>
                        {runningSessionCount > 0 && (
                            <p className="font-medium">{t('versionUpdate.runningSessionsWarning', { count: runningSessionCount })}</p>
                        )}
                        <p>{t('versionUpdate.restartWarning')}</p>
                    </Notice>
                )}

                {startError && <Notice tone="red">{startError}</Notice>}

                {/* Job progress */}
                {showJob && job && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white">
                            {job.state === 'failed'
                                ? t('versionUpdate.failedWith', { error: job.error ?? '' })
                                : job.state === 'succeeded'
                                    ? t('versionUpdate.updateSucceeded')
                                    : job.state === 'restarting'
                                        ? t('versionUpdate.waitingForServer')
                                        : t(`versionUpdate.steps.${job.step ?? 'queued'}`, { defaultValue: job.step ?? '' })}
                        </h3>
                        <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-3 dark:bg-gray-950">
                            <pre className="whitespace-pre-wrap font-mono text-[11px] text-green-400">{job.logTail.join('\n') || '…'}</pre>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                    <button
                        onClick={onClose}
                        className="flex-1 whitespace-nowrap rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                    >
                        {canStart ? t('versionUpdate.buttons.later') : t('versionUpdate.buttons.close')}
                    </button>
                    {!jobActive && (
                        <button
                            onClick={() => void checkNow()}
                            disabled={isChecking}
                            className="flex-1 whitespace-nowrap rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-60 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                            {isChecking ? t('versionUpdate.buttons.checking') : t('versionUpdate.buttons.checkNow')}
                        </button>
                    )}
                    {mode && !showJob && (
                        <button
                            onClick={() => void handleStart()}
                            disabled={!canStart}
                            className="flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                        >
                            {isStarting && <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />}
                            {mode === 'pull' ? t('versionUpdate.buttons.pullAndRestart') : t('versionUpdate.buttons.rebuildAndRestart')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function InfoRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
    return (
        <div className={highlight
            ? 'flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-900/20'
            : 'flex items-center justify-between rounded-lg bg-gray-50 p-3 dark:bg-gray-700/50'}
        >
            <span className={highlight ? 'text-sm font-medium text-blue-700 dark:text-blue-300' : 'text-sm font-medium text-gray-700 dark:text-gray-300'}>
                {label}
            </span>
            <span className={highlight ? 'font-mono text-sm text-blue-900 dark:text-blue-100' : 'font-mono text-sm text-gray-900 dark:text-white'}>
                {value}
            </span>
        </div>
    );
}

const NOTICE_TONES = {
    red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200',
    blue: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200',
} as const;

function Notice({ tone, children }: { tone: keyof typeof NOTICE_TONES; children: ReactNode }) {
    return <div className={`space-y-1 rounded-md border px-3 py-2 text-xs ${NOTICE_TONES[tone]}`}>{children}</div>;
}
