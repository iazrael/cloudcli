import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

import { protocolClient } from './zcode-protocol.client.js';

/** The engine replays a session's context on resume; big sessions take a while. */
const RESUME_TIMEOUT_MS = 30_000;
/** A fork also snapshots the workspace, which can copy many files. */
const FORK_TIMEOUT_MS = 60_000;

/**
 * Branches a ZCode conversation through the engine's own fork RPC.
 *
 * ZCode forks by reference, not by copy: the new session chains to the parent
 * (`parent_id`) and carries the cut as a fork notice, so the engine keeps one
 * shared history and each branch resolves its prefix at read time. The
 * sessions provider mirrors that on read (parent-chain resolution) — here the
 * contract only needs the new id.
 *
 * The engine refuses to fork a session it does not hold in memory ("Session
 * is not active"), so the fork resumes the session first; on a session this
 * runtime is already chatting with the resume is a refresh. A turn that is
 * still running is refused by the engine and surfaces as FORK_FAILED.
 */
export class ZCodeForkProvider implements IProviderFork {
  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // `title` is deliberately not forwarded. The sidebar name lives in this
    // app's own session row; the engine names the fork itself ("Fork of …").
    try {
      await protocolClient.sendRequest(
        'session/resume',
        { sessionId: input.providerSessionId },
        RESUME_TIMEOUT_MS,
      );

      // An anchor names the engine message the branch keeps; without one the
      // engine's own default applies — everything up to the newest checkpoint,
      // which is the whole conversation for a settled session.
      const target = input.upToAnchorId
        ? { kind: 'message', messageId: input.upToAnchorId }
        : { kind: 'latestCheckpoint' };

      const fork = await protocolClient.sendRequest<{ forkedSessionId?: unknown }>(
        'session/fork',
        { sessionId: input.providerSessionId, target },
        FORK_TIMEOUT_MS,
      );

      const forkedSessionId = typeof fork?.forkedSessionId === 'string' ? fork.forkedSessionId : '';
      if (!forkedSessionId) {
        throw new Error('the engine returned no forked session id');
      }

      // ZCode sessions have no transcript file; the row stays path-less like
      // every other engine-stored session of this provider.
      return { providerSessionId: forkedSessionId, jsonlPath: '' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AppError(`ZCode could not fork this session: ${reason}`, {
        code: 'FORK_FAILED',
        statusCode: 502,
      });
    }
  }
}
