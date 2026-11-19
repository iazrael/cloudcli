import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJsonlIncrementally, type JsonlIncrementalState } from '../utils.js';

/**
 * The incremental reader is what keeps a usage refresh from re-parsing a
 * multi-hundred-megabyte transcript. Its value is only correct if it applies
 * every record exactly once across appends, holds a half-written trailing line
 * until its newline arrives, and starts over when the file is replaced.
 */

type Counter = { rows: string[] };

const createCounter = (): Counter => ({ rows: [] });

async function read(
  file: string,
  previous: JsonlIncrementalState<Counter> | null | undefined,
): Promise<JsonlIncrementalState<Counter> | null> {
  return readJsonlIncrementally(
    file,
    previous,
    createCounter,
    (counter, record) => {
      counter.rows.push(String(record.id));
    },
  );
}

test('jsonl incremental reader consumes only the appended tail', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jsonl-incremental-'));
  const file = path.join(directory, 'rollout.jsonl');

  try {
    await writeFile(file, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`);

    const first = await read(file, null);
    assert.deepEqual(first?.accumulator.rows, ['a', 'b']);

    // No change: the same state comes back without a second pass.
    const unchanged = await read(file, first);
    assert.deepEqual(unchanged?.accumulator.rows, ['a', 'b']);

    await appendFile(file, `${JSON.stringify({ id: 'c' })}\n`);
    const second = await read(file, unchanged);
    assert.deepEqual(second?.accumulator.rows, ['a', 'b', 'c']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('jsonl incremental reader holds a line that is still being written', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jsonl-incremental-partial-'));
  const file = path.join(directory, 'rollout.jsonl');

  try {
    const full = `${JSON.stringify({ id: 'complete' })}\n`;
    const half = '{"id":"hal';
    await writeFile(file, `${full}${half}`);

    const first = await read(file, null);
    assert.deepEqual(first?.accumulator.rows, ['complete']);

    // The writer finishes its line; the reader must parse it once, whole.
    await appendFile(file, 'f"}\n');
    const second = await read(file, first);
    assert.deepEqual(second?.accumulator.rows, ['complete', 'half']);

    // And a later append starts from that point, not from zero.
    await appendFile(file, `${JSON.stringify({ id: 'after' })}\n`);
    const third = await read(file, second);
    assert.deepEqual(third?.accumulator.rows, ['complete', 'half', 'after']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('jsonl incremental reader starts over when the file was replaced', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jsonl-incremental-replace-'));
  const file = path.join(directory, 'rollout.jsonl');

  try {
    await writeFile(file, `${JSON.stringify({ id: 'old-1' })}\n${JSON.stringify({ id: 'old-2' })}\n`);
    const first = await read(file, null);
    assert.deepEqual(first?.accumulator.rows, ['old-1', 'old-2']);

    // A rewrite shorter than the previous read must not be treated as "no
    // new bytes": the cursor belongs to a file that no longer exists.
    await writeFile(file, `${JSON.stringify({ id: 'new-1' })}\n`);
    const replaced = await read(file, first);
    assert.deepEqual(replaced?.accumulator.rows, ['new-1']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('jsonl incremental reader is null for a missing file and applies a delta once under concurrency', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jsonl-incremental-missing-'));
  const file = path.join(directory, 'rollout.jsonl');

  try {
    assert.equal(await read(file, null), null);

    await writeFile(file, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`);

    // Two concurrent readers share one accumulator; serializing them keeps the
    // same delta from being counted twice.
    const [left, right] = await Promise.all([read(file, null), read(file, null)]);
    assert.ok(left);
    assert.ok(right);
    assert.deepEqual(left.accumulator.rows, ['a', 'b']);
    assert.deepEqual(right.accumulator.rows, ['a', 'b']);
    assert.equal(left.offset, right.offset);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
