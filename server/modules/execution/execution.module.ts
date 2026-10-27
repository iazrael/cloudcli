import path from 'node:path';
import os from 'node:os';

import { z } from 'zod';

import { projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService, providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, broadcastSessionUpserted, emitRuntimeFailureFallback } from '@/modules/websocket/index.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

import { createExecutionRouter } from './execution.routes.js';
import { createExecutionService } from './execution.service.js';

/** 服务入口挂载此模块；首次授权请求时装配执行能力，数据库须已初始化。 */
export function createExecutionModule(overrides: {
  runtime?: typeof providerRuntimeService;
  models?: typeof providerModelsService;
} = {}) {
  const runtime = overrides.runtime ?? providerRuntimeService;
  const models = overrides.models ?? providerModelsService;
  const token = process.env.CLOUDCLI_EXECUTION_TOKEN;
  let service: ReturnType<typeof createExecutionService> | undefined;
  const getService = () => {
    if (service) return service;
    const roots = z.array(z.string().min(1)).min(1).parse(JSON.parse(process.env.CLOUDCLI_EXECUTION_ROOTS ?? '[]'));
    service = createExecutionService({
      directory: process.env.CLOUDCLI_EXECUTION_DIR ?? path.join(os.homedir(), '.cloudcli', 'executions'),
      roots,
      capabilities: async (requestedProvider) => {
        const providers = (await runtime.listExecutionProviders()).filter((entry) => entry.installed && entry.supportsTaskExecution
          && (!requestedProvider || entry.provider === requestedProvider));
        return Promise.all(providers.map(async ({ provider }) => {
          const catalog = await models.getProviderModels(provider);
          return { provider, models: catalog.OPTIONS.map((model) => model.value) };
        }));
      },
      createSession(provider, cwd, prompt) {
        projectsDb.createProjectPath(cwd, null);
        return sessionsService.createAppSession(provider as LLMProvider, cwd, prompt).sessionId;
      },
      sessionExists(sessionId, provider, cwd) {
        const session = sessionsDb.getSessionById(sessionId);
        return session?.provider === provider && session.project_path === cwd && Boolean(session.provider_session_id);
      },
      launch(input, send) {
        const provider = input.provider as LLMProvider;
        const row = sessionsDb.getSessionById(input.sessionId);
        const userId = userDb.getFirstUser()?.id;
        if (!row || userId === undefined) throw new Error('执行需要有效的应用会话和本机用户');
        let terminal = false;
        let failed = false;
        let aborted = false;
        let runtimeSettled = false;
        let identityMismatch = false;
        let error: string | undefined;
        const run = chatRunRegistry.startRun({
          appSessionId: input.sessionId, provider, providerSessionId: row.provider_session_id,
          userId, connection: null,
        });
        if (!run) throw new Error('该会话正在运行');
        const captureSessionId = (nativeId: string) => {
          if (row.provider_session_id && nativeId !== row.provider_session_id) {
            identityMismatch = true;
            failed = true;
            error = '引擎返回了不同的原生会话，已拒绝替换并请求停止';
            void runtime.abort(provider, input.sessionId).catch((caught: unknown) => console.error('[Execution] 会话替换后的停止失败', caught));
            return;
          }
          run.writer.setSessionId(nativeId);
        };
        const writer = {
          userId,
          isWebSocketWriter: true,
          setSessionId: captureSessionId,
          send(data: unknown) {
            const message = data as NormalizedMessage;
            if (message.kind === 'session_created') {
              const nativeId = message.newSessionId ?? message.sessionId;
              if (nativeId) captureSessionId(nativeId);
            }
            if (message.kind === 'complete') {
              terminal = true;
              aborted ||= message.aborted === true;
              failed ||= (message.exitCode ?? 0) !== 0;
            }
            if (message.kind === 'error') error = typeof message.content === 'string' ? message.content : '引擎报错';
            send({ ...message, sessionId: input.sessionId });
            // 执行仍有后台工作时保持会话忙碌，由 done 最后发送 complete。
            if (message.kind !== 'complete' && !identityMismatch) run.writer.send(data);
          },
        };
        models.setSessionModel(provider, input.sessionId, input.model);
        void broadcastSessionUpserted(input.sessionId).catch((caught: unknown) => {
          console.error('[Execution] 会话广播失败', caught);
        });
        const done = (async () => {
          try {
            const result = await runtime.run(provider, input.prompt, {
              sessionId: input.sessionId, cwd: input.cwd, projectPath: input.cwd,
              model: input.model, permissionMode: input.permissionMode, skipPermissions: input.permissionMode === 'bypassPermissions',
              strictResume: Boolean(row.provider_session_id),
            }, writer);
            if (terminal && result && typeof result === 'object' && 'success' in result && result.success === false) failed = true;
          } catch (caught) {
            error = caught instanceof Error ? caught.message : '引擎执行失败';
            failed = true;
            // RPC 请求可能已经送达引擎；异常不能证明它已停止。
          } finally { runtimeSettled = true; }
          if (!terminal && error) {
            // 与聊天网关的兜底同款：运行时没发 complete 就结束（RPC 报错、会话
            // 身份被替换），补一条错误帧并释放网关 run，否则会话在所有客户端
            // 永远卡在处理中，chat.send、定时消息和后续派发全被卡死。
            // 执行记录仍按 stopped:false 记作中断——界面终态不能当停止凭据。
            emitRuntimeFailureFallback(run, { provider, sessionId: input.sessionId, message: error });
            chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1, reason: 'dispatch_failed' });
            return { success: false, stopped: false, error };
          }
          // 静默移交和仍有后台任务的回合继续等待；provider 的监听器仍使用当前 writer。
          while (!terminal || !runtimeSettled || runtime.hasBackgroundWork(input.sessionId)
            || runtime.hasSessionWork(input.sessionId)) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          aborted ||= run.endReason === 'client_abort';
          chatRunRegistry.completeRunIfCurrent(run, {
            exitCode: failed ? 1 : 0, aborted, reason: aborted ? 'client_abort' : failed ? 'engine_failed' : 'engine_completed',
          });
          return { success: !failed && !aborted, stopped: true, cancelled: aborted, ...(failed && error ? { error } : {}) };
        })();
        return {
          done,
          cancel: () => runtime.abort(provider, input.sessionId),
        };
      },
    });
    return service;
  };
  return { router: createExecutionRouter({ token, service: getService }), service: getService };
}
