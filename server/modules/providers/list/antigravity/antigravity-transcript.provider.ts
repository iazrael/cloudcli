import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord, sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { getAntigravityTranscriptCandidates } from './antigravity-data-root.js';

type CanonicalAntigravityTranscriptRow = {
  entry: AnyRecord;
  contentCompleteness: 'complete' | 'truncated';
};

function isContentTruncated(entry: AnyRecord): boolean {
  return Array.isArray(entry.truncated_fields) && entry.truncated_fields.includes('content');
}

async function readJsonl(pathname: string): Promise<CanonicalAntigravityTranscriptRow[]> {
  try {
    const content = await readFile(pathname, 'utf8');
    return content.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const entry = readObjectRecord(JSON.parse(line));
        if (!entry) return [];
        return [{ entry, contentCompleteness: isContentTruncated(entry) ? 'truncated' : 'complete' }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Reads Antigravity's compact and full transcript artifacts as one canonical
 * ordered stream. Consumed by AntigravitySessionsProvider to normalize historical
 * turns with exact step identity and content completeness, while this module owns
 * partial writes, corrupt JSONL tails, and the case where the full file has not
 * caught up with compact yet.
 */
export async function readCanonicalAntigravityTranscript(
  sessionId: string,
): Promise<CanonicalAntigravityTranscriptRow[]> {
  const safeId = sanitizeLeafDirectoryName(sessionId, 'antigravity session id');
  const compactPath = getAntigravityTranscriptCandidates(safeId).find((candidate) => fs.existsSync(candidate));
  if (!compactPath) return [];

  const fullPath = path.join(path.dirname(compactPath), 'transcript_full.jsonl');
  const [compactRows, fullRows] = await Promise.all([
    readJsonl(compactPath),
    fs.existsSync(fullPath) ? readJsonl(fullPath) : Promise.resolve([]),
  ]);
  const fullByStep = new Map<number, CanonicalAntigravityTranscriptRow>();
  for (const row of fullRows) {
    if (typeof row.entry.step_index === 'number') fullByStep.set(row.entry.step_index, row);
  }

  const merged: CanonicalAntigravityTranscriptRow[] = [];
  const compactSteps = new Set<number>();
  for (const row of compactRows) {
    const step = row.entry.step_index;
    if (typeof step === 'number') {
      compactSteps.add(step);
      merged.push(fullByStep.get(step) ?? row);
    } else {
      merged.push(row);
    }
  }
  for (const row of fullRows) {
    const step = row.entry.step_index;
    if (typeof step === 'number' && !compactSteps.has(step)) merged.push(row);
  }
  return sortByStepIndex(merged);
}

/**
 * Restores causal order by step index. Antigravity's writer occasionally
 * flushes a tool result row ahead of the call row that produced it, which
 * would otherwise make consumers pair a result with the wrong call. Rows
 * without a native step index carry no ordering of their own, so they keep
 * their position right after the row they followed.
 */
function sortByStepIndex(rows: CanonicalAntigravityTranscriptRow[]): CanonicalAntigravityTranscriptRow[] {
  let previousKey = -1;
  const keyed = rows.map((row, position) => {
    const step = row.entry.step_index;
    previousKey = typeof step === 'number' ? step : previousKey + 0.5;
    return { row, key: previousKey, position };
  });
  keyed.sort((a, b) => (a.key - b.key) || (a.position - b.position));
  return keyed.map(({ row }) => row);
}
