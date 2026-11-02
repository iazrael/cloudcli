import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

import type { OpenCodeApiClient } from './opencode-api.client.js';
import {
  getOpenCodeDatabasePath,
  readOpenCodeConversationOrder,
  type OpenCodeConversationMessage,
} from './opencode-data-root.js';
import { connectOpenCodeApiClient } from './opencode-service.js';

/**
 * The message id to hand OpenCode's **exclusive** fork cut so the copy ends at
 * the anchor's turn.
 *
 * The cut copies everything before the named message, so the answer is the
 * first *user* message after the anchor: that keeps the anchor's whole turn
 * (its answer included) and drops the next one. `null` means the anchor's turn
 * is the last, and the whole conversation is copied. Turn-inclusive is the same
 * choice Codex's fork makes — a turn is the smallest useful branch point.
 *
 * Exported for tests only.
 */
export function resolveOpenCodeForkCut(
  order: OpenCodeConversationMessage[],
  anchorId: string,
): string | null {
  const anchorIndex = order.findIndex((message) => message.id === anchorId);
  if (anchorIndex < 0) {
    throw new AppError('That message is no longer in the transcript.', {
      code: 'ANCHOR_NOT_FOUND',
      statusCode: 404,
    });
  }

  return order.slice(anchorIndex + 1).find((message) => message.role === 'user')?.id ?? null;
}

type OpenCodeForkDependencies = {
  /** The client the fork talks to; defaults to the production server. */
  connectClient?: () => Promise<Pick<OpenCodeApiClient, 'forkSession'>>;
};

/**
 * Branches an OpenCode conversation through the service's `fork` primitive,
 * which copies the messages before the cut into an independent session.
 *
 * OpenCode keeps its transcript in a shared database rather than a file, so
 * `requiresTranscriptFile` is false and the fork returns no artifact path.
 *
 * Consumer: `opencode.provider.ts` (the provider's `fork` facet).
 */
export class OpenCodeForkProvider implements IProviderFork {
  readonly requiresTranscriptFile = false;

  private readonly connectClient: () => Promise<Pick<OpenCodeApiClient, 'forkSession'>>;

  constructor(dependencies: OpenCodeForkDependencies = {}) {
    this.connectClient = dependencies.connectClient ?? connectOpenCodeApiClient;
  }

  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string | null;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string | null }> {
    let cutMessageId: string | null = null;
    if (input.upToAnchorId) {
      const databasePath = getOpenCodeDatabasePath();
      if (!fsSync.existsSync(databasePath)) {
        throw new AppError('OpenCode database was not found.', {
          code: 'OPENCODE_DATABASE_NOT_FOUND',
          statusCode: 409,
        });
      }
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        cutMessageId = resolveOpenCodeForkCut(
          readOpenCodeConversationOrder(db, input.providerSessionId),
          input.upToAnchorId,
        );
      } finally {
        db.close();
      }
    }

    // The fork's chosen title lives on this app's own session row, so the
    // engine-side session keeps whatever it derives itself.
    const client = await this.connectClient();
    const forked = await client.forkSession(input.providerSessionId, cutMessageId);
    return { providerSessionId: forked.id, jsonlPath: null };
  }
}
