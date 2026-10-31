import type { QueuedChatMessage } from '@/shared/types.js';
import { readQueuedChatMessage, AppError } from '@/shared/utils.js';

type GitConfig = {
  git_name: string | null;
  git_email: string | null;
};

/** One chat scope's unsent composer text and queued message. */
type DraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type UserDependencies = {
  users: {
    getGitConfig(userId: number): GitConfig | undefined;
    updateGitConfig(userId: number, gitName: string | null, gitEmail: string | null): void;
    completeOnboarding(userId: number): void;
    hasCompletedOnboarding(userId: number): boolean;
  };
  preferences: {
    getPreferences(userId: number): Record<string, unknown>;
    savePreferences(userId: number, updates: Record<string, unknown>): void;
  };
  drafts: {
    getDrafts(userId: number): DraftRecord[];
    saveDraftText(userId: number, scope: string, text: string): void;
    appendQueuedMessage(userId: number, scope: string, message: QueuedChatMessage): { queuedMessage: QueuedChatMessage; appended: boolean } | null;
    clearQueuedMessage(userId: number, scope: string, expected?: QueuedChatMessage): boolean;
    deleteDraft(userId: number, scope: string): void;
  };
  readSystemGitConfig(): Promise<GitConfig>;
  applyGlobalGitConfig(gitName: string, gitEmail: string): Promise<void>;
  logInfo(message: string): void;
  logError(message: string, error: unknown): void;
  notifyLegacyQueueWrite?(userId: number, scope: string): void;
};

/**
 * The longest a draft scope or preference key may be.
 *
 * Scopes are session UUIDs or `project:<id>`, and preference keys are fixed
 * identifiers, so anything longer is a client bug or an attempt to use the
 * table as general storage.
 */
const MAX_KEY_LENGTH = 200;

/** Guards against a runaway composer filling the database with one row. */
const MAX_DRAFT_TEXT_LENGTH = 100_000;

const readDraftScope = (value: unknown): string => {
  const scope = typeof value === 'string' ? value.trim() : '';
  if (!scope || scope.length > MAX_KEY_LENGTH) {
    throw new AppError('A draft scope of 1-200 characters is required', {
      code: 'INVALID_DRAFT_SCOPE',
      statusCode: 400,
    });
  }
  return scope;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);
const readQueuedMessageInput = (value: unknown, enforceLengthLimit = true): QueuedChatMessage => {
  if (!isRecord(value)
    || (value.content !== undefined && typeof value.content !== 'string')
    || (value.attachments !== undefined && !Array.isArray(value.attachments))
    || (value.images !== undefined && !Array.isArray(value.images))
    || (value.options !== undefined && !isRecord(value.options))) {
    throw new AppError('Invalid queued message', { code: 'INVALID_QUEUED_MESSAGE', statusCode: 400 });
  }
  const message = readQueuedChatMessage(value);
  if (!message) throw new AppError('A queued message needs text or attachments', { code: 'INVALID_QUEUED_MESSAGE', statusCode: 400 });
  if (enforceLengthLimit && message.content.length > MAX_DRAFT_TEXT_LENGTH) {
    throw new AppError('Queued message is too long to store', { code: 'DRAFT_TEXT_TOO_LONG', statusCode: 413 });
  }
  return message;
};

const readPreferenceUpdates = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Preferences must be sent as an object', {
      code: 'INVALID_PREFERENCES',
      statusCode: 400,
    });
  }

  const updates = body as Record<string, unknown>;
  for (const key of Object.keys(updates)) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new AppError('Preference keys must be 1-200 characters', {
        code: 'INVALID_PREFERENCE_KEY',
        statusCode: 400,
      });
    }
  }

  return updates;
};

/** Creates user-profile workflows with explicit repository and Git adapters. */
export function createUserService(dependencies: UserDependencies) {
  const notifyLegacyQueueWrite = (userId: number, scope: string) => {
    try {
      dependencies.notifyLegacyQueueWrite?.(userId, scope);
    } catch (error) {
      dependencies.logError('Failed to notify an outdated queue client', error);
    }
  };
  return {
    async getGitConfig(userId: number) {
      let gitConfig = dependencies.users.getGitConfig(userId);
      if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
        const systemConfig = await dependencies.readSystemGitConfig();
        if (systemConfig.git_name || systemConfig.git_email) {
          dependencies.users.updateGitConfig(
            userId,
            systemConfig.git_name,
            systemConfig.git_email,
          );
          gitConfig = systemConfig;
          dependencies.logInfo(`Auto-populated Git config for user ${userId}`);
        }
      }

      return {
        success: true,
        gitName: gitConfig?.git_name ?? null,
        gitEmail: gitConfig?.git_email ?? null,
      };
    },

    async updateGitConfig(userId: number, gitNameInput: unknown, gitEmailInput: unknown) {
      const gitName = typeof gitNameInput === 'string' ? gitNameInput.trim() : '';
      const gitEmail = typeof gitEmailInput === 'string' ? gitEmailInput.trim() : '';
      if (!gitName || !gitEmail) {
        throw new AppError('Git name and email are required', {
          code: 'GIT_CONFIG_REQUIRED',
          statusCode: 400,
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail)) {
        throw new AppError('Invalid email format', {
          code: 'INVALID_GIT_EMAIL',
          statusCode: 400,
        });
      }

      dependencies.users.updateGitConfig(userId, gitName, gitEmail);
      try {
        await dependencies.applyGlobalGitConfig(gitName, gitEmail);
      } catch (error) {
        // Persisted user settings remain authoritative even if the host Git
        // installation cannot be updated (matching the previous behavior).
        dependencies.logError('Failed to apply global Git config', error);
      }
      return { success: true, gitName, gitEmail };
    },

    completeOnboarding(userId: number) {
      dependencies.users.completeOnboarding(userId);
      return { success: true, message: 'Onboarding completed successfully' };
    },

    getOnboardingStatus(userId: number) {
      return {
        success: true,
        hasCompletedOnboarding: dependencies.users.hasCompletedOnboarding(userId),
      };
    },

    /** Every stored preference at once; the client fills gaps with its defaults. */
    getPreferences(userId: number) {
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    /**
     * Merge-patch: only the keys in the request body are touched, so two
     * independent settings screens can save concurrently without one erasing
     * the other's work.
     */
    savePreferences(userId: number, body: unknown) {
      const updates = readPreferenceUpdates(body);
      dependencies.preferences.savePreferences(userId, updates);
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    getDrafts(userId: number) {
      return { success: true, drafts: dependencies.drafts.getDrafts(userId) };
    },

    saveDraft(userId: number, scopeInput: unknown, body: unknown) {
      const scope = readDraftScope(scopeInput);
      if (!isRecord(body)) throw new AppError('Draft must be an object', { code: 'INVALID_DRAFT', statusCode: 400 });
      if (Object.hasOwn(body, 'queuedMessage') && body.queuedMessage !== null) {
        notifyLegacyQueueWrite(userId, scope);
        throw new AppError('Refresh this page to use the queue API', { code: 'LEGACY_QUEUE_WRITE', statusCode: 409 });
      }
      const payload = body;
      const text = typeof payload.text === 'string' ? payload.text : '';

      if (text.length > MAX_DRAFT_TEXT_LENGTH) {
        throw new AppError('Draft text is too long to store', {
          code: 'DRAFT_TEXT_TOO_LONG',
          statusCode: 413,
        });
      }

      dependencies.drafts.saveDraftText(userId, scope, text);
      if (body.queuedMessage === null && dependencies.drafts.getDrafts(userId)
        .some((draft) => draft.scope === scope && draft.queuedMessage !== null)) {
        notifyLegacyQueueWrite(userId, scope);
      }
      return { success: true };
    },

    /** User routes submit follow-ups to the atomic repository operation. */
    appendQueuedMessage(userId: number, scopeInput: unknown, input: unknown) {
      const scope = readDraftScope(scopeInput);
      const message = readQueuedMessageInput(input);
      const result = dependencies.drafts.appendQueuedMessage(userId, scope, message);
      if (!result) {
        throw new AppError('A slash command must run in its own turn', { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', statusCode: 409 });
      }
      return { success: true, ...result };
    },

    clearQueuedMessage(userId: number, scopeInput: unknown, body: unknown = {}) {
      const scope = readDraftScope(scopeInput);
      if (!isRecord(body)) throw new AppError('Invalid queue clear request', { code: 'INVALID_QUEUED_MESSAGE', statusCode: 400 });
      const expected = Object.hasOwn(body, 'expectedQueuedMessage')
        ? readQueuedMessageInput(body.expectedQueuedMessage, false) : undefined;
      if (!dependencies.drafts.clearQueuedMessage(userId, scope, expected)) {
        throw new AppError('The queued message changed or has already been claimed; refresh before editing or sending', { code: 'QUEUED_MESSAGE_CHANGED', statusCode: 409 });
      }
      return { success: true };
    },

    deleteDraft(userId: number, scopeInput: unknown) {
      const scope = readDraftScope(scopeInput);
      const keepsQueue = dependencies.drafts.getDrafts(userId)
        .some((draft) => draft.scope === scope && draft.queuedMessage !== null);
      dependencies.drafts.deleteDraft(userId, scope);
      if (keepsQueue) {
        notifyLegacyQueueWrite(userId, scope);
      }
      return { success: true };
    },
  };
}
