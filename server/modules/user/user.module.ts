import spawn from 'cross-spawn';

import { sessionDraftsDb, sessionsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

import { createUserRouter } from './user.routes.js';
import { createUserService } from './user.service.js';

type GitCommandResult = { stdout: string };

function runGit(args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { shell: false });
    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`Git command failed with code ${code}`));
    });
  });
}

async function readSystemGitConfig() {
  const [nameResult, emailResult] = await Promise.all([
    runGit(['config', '--global', 'user.name']).catch(() => ({ stdout: '' })),
    runGit(['config', '--global', 'user.email']).catch(() => ({ stdout: '' })),
  ]);
  return {
    git_name: nameResult.stdout.trim() || null,
    git_email: emailResult.stdout.trim() || null,
  };
}

const userService = createUserService({
  users: {
    getGitConfig: (userId) => userDb.getGitConfig(userId),
    updateGitConfig: (userId, gitName, gitEmail) => userDb.updateGitConfig(
      userId,
      gitName ?? '',
      gitEmail ?? '',
    ),
    completeOnboarding: (userId) => userDb.completeOnboarding(userId),
    hasCompletedOnboarding: (userId) => userDb.hasCompletedOnboarding(userId),
  },
  preferences: {
    getPreferences: (userId) => userPreferencesDb.getPreferences(userId),
    savePreferences: (userId, updates) => userPreferencesDb.savePreferences(userId, updates),
  },
  drafts: {
    getDrafts: (userId) => sessionDraftsDb.getDrafts(userId),
    saveDraftText: (userId, scope, text) => sessionDraftsDb.saveDraftText(userId, scope, text),
    appendQueuedMessage: (userId, scope, message) => sessionDraftsDb.appendQueuedMessage(userId, scope, message),
    clearQueuedMessage: (userId, scope, expected) => sessionDraftsDb.clearQueuedMessage(userId, scope, expected),
    deleteDraft: (userId, scope) => sessionDraftsDb.deleteDraft(userId, scope),
  },
  readSystemGitConfig,
  applyGlobalGitConfig: async (gitName, gitEmail) => {
    await runGit(['config', '--global', 'user.name', gitName]);
    await runGit(['config', '--global', 'user.email', gitEmail]);
  },
  logInfo: (message) => console.log(message),
  logError: (message, error) => console.error(message, error),
  notifyLegacyQueueWrite: (userId, scope) => {
    const session = sessionsDb.getSessionById(scope);
    if (!session) return;
    const language = userPreferencesDb.getPreferences(userId).language;
    chatRunRegistry.publishSessionEvent(scope, {
      id: `legacy-queue-refresh:${scope}`,
      sessionId: scope,
      provider: session.provider as LLMProvider,
      timestamp: new Date().toISOString(),
      kind: 'error',
      content: typeof language === 'string' && language.startsWith('zh')
        ? '当前页面版本已过期，排队操作没有生效。请先复制输入文字和排队内容，再刷新页面确认队列后重新操作。'
        : 'This page is out of date and the queue operation was not applied. Copy both the input text and queued content, then refresh and check the queue before trying again.',
    });
  },
});

/** User router assembled for the authenticated server mount. */
export const userRoutes = createUserRouter(userService);
