/**
 * The one diagnostics report the app exports.
 *
 * A user reporting a problem should never have to know which kind of report to
 * take. Startup timings, service-worker state, the websocket frames in both
 * directions, what the timeline ended up holding, the swipes that failed to
 * scroll it, and how the server says recent runs ended are all the same
 * question asked from different sides — "what actually happened in this tab?"
 * — so they are one file.
 *
 * Nothing here contains message bodies, credentials, headers or URL query
 * parameters: frames keep truncated field summaries, resource URLs are
 * sanitized, and the server's run log is identifiers and counters only.
 *
 * Consumers: the settings Diagnostics tab and the chat transcript's export
 * menu, which differ only in whether a session is open to describe.
 */

import { api, readApiJson } from '@/shared/api';
import { readRecordedFrames } from '@/shared/diagnostics/frameRecorder';
import type { RecordedFrame } from '@/shared/diagnostics/frameRecorder';
import { readScrollScreenings } from '@/shared/diagnostics/scrollScreening';
import type { ScrollScreening } from '@/shared/diagnostics/scrollScreening';
import { createStartupDiagnosticsSection } from '@/shared/diagnostics/startupDiagnostics';
import type { StartupDiagnosticsSection } from '@/shared/diagnostics/startupDiagnostics';
import type { NormalizedMessage, RunOutcomeRecord, TimelineSnapshot } from '@/shared/types';
import { saveOrShareBlob } from '@/shared/utils';

/** How many finished runs to ask the server for. */
const REQUESTED_SERVER_RUNS = 50;

/** Longest row summary kept, matching the frame recorder's own limit. */
const MAX_SUMMARY_LENGTH = 120;

export type DiagnosticsReport = {
  schemaVersion: 3;
  takenAt: string;
  sessionId: string | null;
  /** Both directions, oldest first, including frames from earlier page loads. */
  frames: RecordedFrame[];
  /** The rows of the session being reported on, as the store holds them. */
  timeline: {
    /** Merged rows in render order, reduced to what identifies them. */
    rendered: Array<Pick<NormalizedMessage, 'id' | 'kind' | 'role' | 'toolId'> & { summary?: string }>;
    server: string[];
    realtime: string[];
    retiredOptimisticUserAnchors: Array<[string, string]>;
    /** Pairings whose proof holds; a live row reconciles against its own turn only through these. */
    provenOptimisticUserAnchors: string[];
    runEnded: boolean;
  } | null;
  startup: StartupDiagnosticsSection | null;
  /** Touches that should have scrolled the transcript and did not. */
  scrollScreenings: ScrollScreening[];
  /**
   * How the server says recent runs ended, or why it could not be asked. The
   * report is still worth having when this fails — an unreachable server is
   * itself a finding.
   */
  serverRuns: RunOutcomeRecord[] | { error: string };
  privacy: {
    includesChatContent: false;
    includesCredentials: false;
    resourceUrlsAreSanitized: true;
  };
};

function truncate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return value.length > MAX_SUMMARY_LENGTH ? `${value.slice(0, MAX_SUMMARY_LENGTH)}…` : value;
}

/**
 * Builds the report from parts already gathered.
 *
 * Consumers: `createDiagnosticsReport`, and the tests that pin the report's
 * shape and its privacy guarantees.
 */
export function buildDiagnosticsReport(input: {
  sessionId: string | null;
  rendered: NormalizedMessage[] | null;
  snapshot: TimelineSnapshot | null;
  startup: StartupDiagnosticsSection | null;
  serverRuns: RunOutcomeRecord[] | { error: string };
}): DiagnosticsReport {
  return {
    schemaVersion: 3,
    takenAt: new Date().toISOString(),
    sessionId: input.sessionId,
    frames: [...readRecordedFrames()],
    timeline: input.rendered && input.snapshot
      ? {
        rendered: input.rendered.map((row) => ({
          id: row.id,
          kind: row.kind,
          role: row.role,
          toolId: row.toolId,
          summary: truncate(row.content),
        })),
        server: input.snapshot.serverMessages.map((row) => row.id),
        realtime: input.snapshot.realtimeMessages.map((row) => row.id),
        retiredOptimisticUserAnchors: input.snapshot.retiredOptimisticUserAnchors,
        provenOptimisticUserAnchors: input.snapshot.provenOptimisticUserAnchors,
        runEnded: input.snapshot.runEnded,
      }
      : null,
    startup: input.startup,
    scrollScreenings: [...readScrollScreenings()],
    serverRuns: input.serverRuns,
    privacy: {
      includesChatContent: false,
      includesCredentials: false,
      resourceUrlsAreSanitized: true,
    },
  };
}

/**
 * How the report reaches the timeline it describes.
 *
 * The store is created per app mount rather than as a module singleton, so the
 * report cannot import it. The mount registers a reader instead, and the export
 * control asks for the session it is showing.
 *
 * Consumers: the chat module's `useSessionStore` registers; this module reads.
 */
type TimelineSnapshotSource = (sessionId: string) => {
  rendered: NormalizedMessage[];
  snapshot: TimelineSnapshot;
} | null;

let timelineSnapshotSource: TimelineSnapshotSource | null = null;

/** Consumer: the chat module's session store, on mount and unmount. */
export function registerTimelineSnapshotSource(source: TimelineSnapshotSource | null): void {
  timelineSnapshotSource = source;
}

async function readServerRuns(): Promise<RunOutcomeRecord[] | { error: string }> {
  try {
    const response = await api.diagnostics.runs(REQUESTED_SERVER_RUNS);
    const payload = await readApiJson<{ data?: { runs?: RunOutcomeRecord[] } }>(response);
    return payload.data?.runs ?? [];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Gathers every section, including the asynchronous ones.
 *
 * Consumers: the settings Diagnostics tab and the chat export menu.
 */
export async function createDiagnosticsReport(sessionId: string | null): Promise<DiagnosticsReport> {
  const timeline = sessionId ? timelineSnapshotSource?.(sessionId) ?? null : null;
  // Gathered in parallel because the startup section awaits the service worker
  // and caches, and neither section depends on the other.
  const [startup, serverRuns] = await Promise.all([
    createStartupDiagnosticsSection().catch(() => null),
    readServerRuns(),
  ]);

  return buildDiagnosticsReport({
    sessionId,
    rendered: timeline?.rendered ?? null,
    snapshot: timeline?.snapshot ?? null,
    startup,
    serverRuns,
  });
}

/**
 * Writes the report to a file the user can attach to a bug report.
 *
 * Consumers: the settings Diagnostics tab and the chat export menu.
 */
export async function downloadDiagnosticsReport(sessionId: string | null): Promise<void> {
  const report = await createDiagnosticsReport(sessionId);
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  // The share hand-off keeps iOS PWAs from navigating to the blob URL.
  await saveOrShareBlob(blob, `cloudcli-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}
