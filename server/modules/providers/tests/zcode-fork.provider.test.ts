import assert from 'node:assert/strict';
import test from 'node:test';

import { protocolClient } from '@/modules/providers/list/zcode/zcode-protocol.client.js';
import { ZCodeForkProvider } from '@/modules/providers/list/zcode/zcode-fork.provider.js';

/**
 * The session/fork RPC itself is exercised against the real ZCode engine in
 * the design doc's probes (resume → fork → forkedSessionId); what is left for
 * the fork provider is the mapping either side of it.
 */

type SentRequest = { method: string; params: Record<string, unknown> };

function interceptProtocol(
  respond: (method: string, params: Record<string, unknown>) => unknown,
): { calls: SentRequest[]; restore: () => void } {
  const calls: SentRequest[] = [];
  const realSendRequest = protocolClient.sendRequest.bind(protocolClient);
  protocolClient.sendRequest = (async (method: string, params: Record<string, unknown> = {}, _timeout?: number) => {
    calls.push({ method, params });
    const result = respond(method, params);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as typeof protocolClient.sendRequest;
  return {
    calls,
    restore: () => {
      protocolClient.sendRequest = realSendRequest;
    },
  };
}

test('a zcode fork resumes the session then forks at the latest checkpoint', async () => {
  const { calls, restore } = interceptProtocol((method) => {
    if (method === 'session/fork') {
      return { forkedSessionId: 'sess_fork', parentSessionId: 'sess_source', response: 'Forked session' };
    }
    return { messages: [] };
  });

  try {
    const forked = await new ZCodeForkProvider().forkSession({
      providerSessionId: 'sess_source',
      jsonlPath: '',
      projectPath: '/tmp/workspace',
    });
    // No file transcript exists for a ZCode session; the row carries none.
    assert.deepEqual(forked, { providerSessionId: 'sess_fork', jsonlPath: '' });
  } finally {
    restore();
  }

  assert.deepEqual(calls, [
    { method: 'session/resume', params: { sessionId: 'sess_source' } },
    {
      method: 'session/fork',
      // The engine's own default target: everything up to the newest checkpoint.
      params: { sessionId: 'sess_source', target: { kind: 'latestCheckpoint' } },
    },
  ]);
});

test('a zcode fork from a message anchors the cut at that engine message', async () => {
  const { calls, restore } = interceptProtocol((method) => {
    if (method === 'session/fork') {
      return { forkedSessionId: 'sess_fork', targetMessageId: 'msg_b', response: 'Forked session' };
    }
    return { messages: [] };
  });

  try {
    await new ZCodeForkProvider().forkSession({
      providerSessionId: 'sess_source',
      jsonlPath: '',
      projectPath: '/tmp/workspace',
      upToAnchorId: 'msg_b',
    });
  } finally {
    restore();
  }

  assert.deepEqual(calls[1], {
    method: 'session/fork',
    params: { sessionId: 'sess_source', target: { kind: 'message', messageId: 'msg_b' } },
  });
});

test('a fork the engine refuses surfaces as FORK_FAILED', async () => {
  const { restore } = interceptProtocol((method) =>
    method === 'session/fork'
      ? new Error('Cannot fork while a prompt is running')
      : { messages: [] });

  try {
    await assert.rejects(
      () => new ZCodeForkProvider().forkSession({
        providerSessionId: 'sess_source',
        jsonlPath: '',
        projectPath: '/tmp/workspace',
      }),
      (error: Error & { code?: string }) => error.code === 'FORK_FAILED',
    );
  } finally {
    restore();
  }
});

test('a fork response without a session id surfaces as FORK_FAILED', async () => {
  const { restore } = interceptProtocol((method) => {
    if (method === 'session/fork') {
      return { response: 'Forked but told nobody' };
    }
    return { messages: [] };
  });

  try {
    await assert.rejects(
      () => new ZCodeForkProvider().forkSession({
        providerSessionId: 'sess_source',
        jsonlPath: '',
        projectPath: '/tmp/workspace',
      }),
      (error: Error & { code?: string }) => error.code === 'FORK_FAILED',
    );
  } finally {
    restore();
  }
});
