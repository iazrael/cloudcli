import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextWindowCapture,
  extractCumulativeTokenBudget,
  extractTokenBudget,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

// The fallback window is read from CONTEXT_WINDOW at call time; a developer's
// .env value would otherwise stand in for the default these tests pin.
delete process.env.CONTEXT_WINDOW;

test('assistant usage produces a cumulative budget', () => {
  const budget = extractTokenBudget({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 500,
      },
    },
  });

  assert.ok(budget);
  assert.equal(budget.inputTokens, 42_012);
  assert.equal(budget.outputTokens, 500);
  assert.equal(budget.used, 42_512);
});

test('system task events with tool-usage shaped usage emit no budget', () => {
  // task_progress/task_notification carry usage {total_tokens, tool_uses,
  // duration_ms}; reading Anthropic keys off it produced a used: 0 budget
  // that flashed "0" in the composer mid-generation.
  const budget = extractTokenBudget({
    type: 'system',
    subtype: 'task_progress',
    task_id: 't-1',
    usage: { total_tokens: 5_000, tool_uses: 3, duration_ms: 1_200 },
  });

  assert.equal(budget, null);
});

test('subagent messages emit no budget for the parent session', () => {
  // A subagent's usage is its own context window; surfacing it made the
  // session counter drop to the subagent's number and bounce back.
  const budget = extractTokenBudget({
    type: 'assistant',
    parent_tool_use_id: 'toolu_123',
    message: { usage: { input_tokens: 900, output_tokens: 10 } },
  });

  assert.equal(budget, null);
});

test('a turn-ending result emits no budget', () => {
  // `result.usage` is the turn's bill: every request it made, summed, each
  // subagent's included. A four-request turn therefore reports roughly four
  // times the context the conversation holds, so publishing it made the
  // counter leap when the turn ended and fall back on the next turn's first
  // assistant message.
  const budget = extractTokenBudget({
    type: 'result',
    usage: {
      input_tokens: 18,
      cache_creation_input_tokens: 8_138,
      cache_read_input_tokens: 40_460,
      output_tokens: 166,
    },
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 929, outputTokens: 177 },
    },
  });

  assert.equal(budget, null);
});

test('the cumulative reader stays available for SDK builds with no assistant usage', () => {
  const fromUsage = extractCumulativeTokenBudget({
    type: 'result',
    usage: { input_tokens: 18, cache_read_input_tokens: 40_460, output_tokens: 166 },
  });

  assert.ok(fromUsage);
  assert.equal(fromUsage.used, 40_644);

  const fromModelUsage = extractCumulativeTokenBudget({
    type: 'result',
    modelUsage: {
      'claude-sonnet-5': { cumulativeInputTokens: 1_000, cumulativeOutputTokens: 200 },
    },
  });

  assert.ok(fromModelUsage);
  assert.equal(fromModelUsage.used, 1_200);
});

test('the cumulative reader ignores anything that is not a result', () => {
  assert.equal(
    extractCumulativeTokenBudget({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 2 } },
    }),
    null,
  );
});

test('the recorded window drives the live frames, with the model heuristic as fallback', () => {
  // The frames a run streams have to report the same window the reload path
  // resolves, or the badge changes the moment the turn ends.
  const assistantMessage = {
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 100 },
    },
  };

  const recorded = { recorded: 1_000_000, selectedModel: 'opus[1m]' };
  assert.equal(extractTokenBudget(assistantMessage, recorded)?.total, 1_000_000);
  assert.equal(extractTokenBudget(assistantMessage)?.total, 200_000);

  // Never run here yet, but the user picked the 1M variant: the row's model
  // still carries the tag the transcript's resolved id drops.
  assert.equal(
    extractTokenBudget(assistantMessage, { recorded: null, selectedModel: 'opus[1m]' })?.total,
    1_000_000,
  );
  assert.equal(
    extractTokenBudget(assistantMessage, { recorded: null, selectedModel: 'claude-opus-5' })?.total,
    200_000,
  );
  assert.equal(
    extractTokenBudget({
      ...assistantMessage,
      message: { ...assistantMessage.message, model: 'claude-opus-5[1m]' },
    })?.total,
    1_000_000,
  );

  assert.equal(
    extractCumulativeTokenBudget(
      { type: 'result', usage: { input_tokens: 18, output_tokens: 166 } },
      recorded,
    )?.total,
    1_000_000,
  );
});

test('no frame ever reports the legacy 160k window', () => {
  const budget = extractTokenBudget({
    type: 'assistant',
    message: { usage: { input_tokens: 10, output_tokens: 2 } },
  });

  assert.ok(budget);
  assert.notEqual(budget.total, 160_000);
});

/** The shape `fetchSdkContextBudget` hands the capture; only `total` is read. */
const sdkBudget = (total: number) => ({
  used: 1_000,
  total,
  inputTokens: 1_000,
  outputTokens: 0,
  breakdown: { input: 1_000, output: 0 },
});

test('the window capture spends one read once the query answers', async () => {
  // Every read costs a control request, so a run that already learned its
  // window must stop asking — the probe is called once per stream message.
  let reads = 0;
  const seen: number[] = [];
  const capture = createContextWindowCapture(
    async () => {
      reads += 1;
      return sdkBudget(1_000_000);
    },
    (total: number) => seen.push(total),
  );

  await capture();
  await capture();
  await capture();

  assert.equal(reads, 1);
  assert.deepEqual(seen, [1_000_000]);
});

test('a read with nothing to report yet is retried once, then left to the turn end', async () => {
  // A brand-new session has no response to measure at the head of its stream;
  // its first assistant reply is the retry that lands.
  let reads = 0;
  const seen: number[] = [];
  const capture = createContextWindowCapture(
    async () => {
      reads += 1;
      return reads === 1 ? null : sdkBudget(200_000);
    },
    (total: number) => seen.push(total),
  );

  await capture();
  assert.deepEqual(seen, []);
  await capture();
  await capture();

  assert.equal(reads, 2);
  assert.deepEqual(seen, [200_000]);
});

test('the window capture gives up rather than retrying a read that keeps failing', async () => {
  let reads = 0;
  const capture = createContextWindowCapture(
    async () => {
      reads += 1;
      throw new Error('control request unavailable');
    },
    () => assert.fail('a failed read must report no window'),
  );

  await capture();
  await capture();
  await capture();

  assert.equal(reads, 2);
});

test('probes made while a read is in flight share it', async () => {
  // The stream hands over messages faster than a control request answers; two
  // reads for the same window would be pure waste.
  let reads = 0;
  let release: (budget: ReturnType<typeof sdkBudget>) => void = () => {};
  const capture = createContextWindowCapture(
    () => {
      reads += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => {},
  );

  const first = capture();
  const second = capture();
  // The read is queued as a microtask, so let it start before answering it.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  release(sdkBudget(1_000_000));
  await Promise.all([first, second]);

  assert.equal(reads, 1);
});
