import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenCodeForkProvider } from '@/modules/providers/list/opencode/opencode-fork.provider.js';

/**
 * The fork endpoint itself was probed against a real `opencode serve` while
 * settling the design (POST /api/session/:id/fork, `before` is exclusive).
 * What is left for the fork provider is the anchor translation either side of
 * the client: an anchor names a message the branch must KEEP, and the engine
 * parameter names the message the copy must stop BEFORE.
 */

type ForkCall = { sessionId: string; input: { before?: string } };

function stubClient(listing: Array<{ id: string }>) {
  const forks: ForkCall[] = [];
  return {
    forks,
    client: {
      listSessionMessages: async () => listing,
      forkSession: async (sessionId: string, input: { before?: string }) => {
        forks.push({ sessionId, input });
        return { id: 'ses_fork', title: 'Copied (fork #1)' };
      },
    },
  };
}

const providerWith = (client: unknown) =>
  new OpenCodeForkProvider({ getClient: async () => client as never });

test('a fork without an anchor copies the whole conversation', async () => {
  const { client, forks } = stubClient([{ id: 'msg_1' }, { id: 'msg_2' }]);

  const forked = await providerWith(client).forkSession({
    providerSessionId: 'ses_source',
    jsonlPath: '',
    projectPath: '/tmp/workspace',
  });

  // No file transcript exists for an OpenCode session; the row carries none.
  assert.deepEqual(forked, { providerSessionId: 'ses_fork', jsonlPath: '' });
  assert.deepEqual(forks, [{ sessionId: 'ses_source', input: {} }]);
});

test('an anchor mid-conversation copies everything through it', async () => {
  const { client, forks } = stubClient([{ id: 'msg_1' }, { id: 'msg_2' }, { id: 'msg_3' }, { id: 'msg_4' }]);

  // `before` is exclusive engine-side, so keeping the anchor row itself means
  // cutting before the message that follows it.
  await providerWith(client).forkSession({
    providerSessionId: 'ses_source',
    jsonlPath: '',
    projectPath: '/tmp/workspace',
    upToAnchorId: 'msg_2',
  });

  assert.deepEqual(forks, [{ sessionId: 'ses_source', input: { before: 'msg_3' } }]);
});

test('an anchor on the last message omits the cut and copies everything', async () => {
  const { client, forks } = stubClient([{ id: 'msg_1' }, { id: 'msg_2' }]);

  await providerWith(client).forkSession({
    providerSessionId: 'ses_source',
    jsonlPath: '',
    projectPath: '/tmp/workspace',
    upToAnchorId: 'msg_2',
  });

  assert.deepEqual(forks, [{ sessionId: 'ses_source', input: {} }]);
});

test('an anchor the session no longer has surfaces as FORK_FAILED', async () => {
  const { client } = stubClient([{ id: 'msg_1' }]);

  await assert.rejects(
    () => providerWith(client).forkSession({
      providerSessionId: 'ses_source',
      jsonlPath: '',
      projectPath: '/tmp/workspace',
      upToAnchorId: 'msg_gone',
    }),
    (error: Error & { code?: string }) => error.code === 'FORK_FAILED',
  );
});
