import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

import { ensureOpenCodeClient } from './opencode-runtime.provider.js';

/**
 * Branches an OpenCode conversation through the service's fork endpoint.
 *
 * The engine's `before` parameter is exclusive — the copy stops AT the named
 * message — while this app's anchor names the message the branch must keep.
 * The facet therefore translates: it finds the message after the anchor and
 * cuts before that one, so forking from a turn keeps the prompt and the
 * answer it got. An anchor that is already the last message omits the cut,
 * which the engine reads as "copy everything".
 */
export class OpenCodeForkProvider implements IProviderFork {
  private readonly getClient: () => Promise<{
    listSessionMessages: (sessionId: string) => Promise<Array<{ id: string }>>;
    forkSession: (sessionId: string, input: { before?: string }) => Promise<{ id: string; title?: string }>;
  }>;

  constructor(dependencies: { getClient?: typeof ensureOpenCodeClient } = {}) {
    this.getClient = dependencies.getClient ?? ensureOpenCodeClient;
  }

  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // `title` is deliberately not forwarded. The engine names a fork itself
    // ("… (fork #1)") and the sidebar name lives in this app's session row.
    try {
      const client = await this.getClient();

      let before: string | undefined;
      if (input.upToAnchorId) {
        const messages = await client.listSessionMessages(input.providerSessionId);
        const anchorIndex = messages.findIndex((message) => message.id === input.upToAnchorId);
        if (anchorIndex < 0) {
          throw new Error(`the anchor message no longer exists in "${input.providerSessionId}"`);
        }
        before = messages[anchorIndex + 1]?.id;
      }

      // Omitting `before` entirely (no anchor, or the anchor ends the
      // conversation) is the engine's "copy everything".
      const forked = await client.forkSession(input.providerSessionId, before ? { before } : {});
      // OpenCode keeps conversations in its own SQLite store; the session row
      // stays path-less like every other session of this provider.
      return { providerSessionId: forked.id, jsonlPath: '' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AppError(`OpenCode could not fork this session: ${reason}`, {
        code: 'FORK_FAILED',
        statusCode: 502,
      });
    }
  }
}
