import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexAppServerTransport,
  listCodexThreadTurns,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import { AppError } from '@/shared/utils.js';

test('history reader resumes the requested thread and reads every full page with experimental API', async () => {
  const originalOpen = codexAppServerTransport.open;
  const calls: Array<{ method: string; params: any }> = [];
  let options: any;
  let closed = false;
  codexAppServerTransport.open = async (_handlers, suppliedOptions) => {
    options = suppliedOptions;
    return {
      close: () => { closed = true; },
      addNotificationListener: () => () => undefined,
      addExitListener: () => () => undefined,
      call: async (method, params) => {
        calls.push({ method, params: params as Record<string, unknown> });
        if (method === 'thread/resume') return { thread: { id: 'thread-history' } };
        if ((params as Record<string, unknown>).cursor === 'cursor-2') {
          return { data: [{ id: 'turn-2' }], nextCursor: null };
        }
        return { data: [{ id: 'turn-1' }], nextCursor: 'cursor-2' };
      },
    };
  };

  try {
    assert.deepEqual(await listCodexThreadTurns('thread-history'), [{ id: 'turn-1' }, { id: 'turn-2' }]);
    assert.deepEqual(options, { experimentalApi: true });
    assert.deepEqual(calls.map(({ method }) => method), [
      'thread/resume', 'thread/turns/list', 'thread/turns/list',
    ]);
    assert.deepEqual(calls[1].params, {
      threadId: 'thread-history', limit: 100, itemsView: 'full',
    });
    assert.equal(calls[2].params.cursor, 'cursor-2');
    assert.equal(closed, true);
  } finally {
    codexAppServerTransport.open = originalOpen;
  }
});

test('history reader lists a thread another process holds instead of taking it over', async () => {
  const originalOpen = codexAppServerTransport.open;
  const calls: Array<{ method: string; params: any }> = [];
  codexAppServerTransport.open = async () => ({
    close: () => {},
    addNotificationListener: () => () => undefined,
    addExitListener: () => () => undefined,
    call: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === 'thread/resume') {
        // The engine refuses a second writer for a thread a resident
        // conversation holds.
        throw new AppError('thread thread-held already has an active writer', {
          code: 'CODEX_APP_SERVER_ERROR',
          statusCode: 502,
          details: { method: 'thread/resume', rpcCode: -32600 },
        });
      }
      return { data: [{ id: 'turn-1' }], nextCursor: null };
    },
  });

  try {
    assert.deepEqual(await listCodexThreadTurns('thread-held'), [{ id: 'turn-1' }]);
    assert.deepEqual(calls.map(({ method }) => method), ['thread/resume', 'thread/turns/list']);
  } finally {
    codexAppServerTransport.open = originalOpen;
  }
});
