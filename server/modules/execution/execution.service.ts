import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const launchSchema = z.object({
  requestId: identifier,
  provider: z.string().min(1).max(50),
  model: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
  prompt: z.string().min(1).max(1_000_000),
  permissionMode: z.enum(['default', 'bypassPermissions']).default('default'),
}).strict();
const continueSchema = launchSchema.extend({ sessionId: identifier });
const lookupSchema = z.object({ runId: identifier, cursor: z.number().int().nonnegative().default(0) }).strict();
const cancelSchema = z.object({ runId: identifier.optional(), requestId: identifier.optional() }).strict();
const stateSchema = z.enum(['running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const recordSchema = z.object({
  version: z.literal(1), runId: identifier, sessionId: identifier,
  requestId: identifier, fingerprint: z.string(), provider: z.string(), model: z.string(), cwd: z.string(),
  state: stateSchema, stopConfirmed: z.boolean(), response: z.string(), error: z.string().optional(),
  startedAt: z.string(), endedAt: z.string().optional(),
});
type RunRecord = z.infer<typeof recordSchema>;
type LaunchInput = z.infer<typeof continueSchema>;
type LaunchResult = { success: boolean; stopped: boolean; cancelled?: boolean; error?: string };
type LiveRun = {
  cancel(): Promise<boolean>;
  cancelRequested: boolean;
  settled: boolean;
  approvals: Set<string>;
  newTextBlock: boolean;
};
type Dependencies = {
  directory: string;
  roots: string[];
  capabilities(provider?: string): Promise<{ provider: string; models: string[] }[]>;
  createSession(provider: string, cwd: string, prompt: string): string;
  sessionExists(sessionId: string, provider: string, cwd: string): boolean;
  launch(input: LaunchInput, send: (message: unknown) => void): {
    done: Promise<LaunchResult>;
    cancel(): Promise<boolean>;
  };
};

/** MCP 路由使用此模块校验工具输入，并管理持久化执行生命周期。 */
export function createExecutionService(dependencies: Dependencies) {
  const directory = path.resolve(dependencies.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const roots = dependencies.roots.map((root) => realpathSync(root));
  if (!roots.length) throw new Error('执行服务必须配置允许目录');
  const records = new Map<string, RunRecord>();
  const requests = new Map<string, string>();
  const live = new Map<string, LiveRun>();
  const cancelledRequests = new Set<string>();
  const cancellationDirectory = path.join(directory, '.cancellations');
  mkdirSync(cancellationDirectory, { recursive: true, mode: 0o700 });
  let recoveryBlocked = false;
  // 损坏的墓碑与损坏的运行记录同策略：记日志指认坏文件并阻断新派发，
  // 保留历史查询，而不是让构造失败把整个执行服务（含查询）拖垮。
  for (const entry of readdirSync(cancellationDirectory)) {
    if (!entry.endsWith('.json')) continue;
    try {
      cancelledRequests.add(identifier.parse(JSON.parse(readFileSync(path.join(cancellationDirectory, entry), 'utf8')).requestId));
    } catch (error) {
      recoveryBlocked = true;
      console.error(`[Execution] 取消墓碑恢复失败：${entry}；新派发已阻断，正常历史仍可查询`, error);
    }
  }
  const file = (id: string, name: string) => path.join(directory, id, name);
  const persist = (record: RunRecord) => {
    const temporary = file(record.runId, 'state.next');
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, file(record.runId, 'state.json'));
  };
  // 宿主崩溃后引擎可能仍在写入；恢复时不能虚构停止确认或另开一轮。
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let record: RunRecord;
    try {
      record = recordSchema.parse(JSON.parse(readFileSync(file(entry.name, 'state.json'), 'utf8')));
    } catch (error) {
      recoveryBlocked = true;
      console.error(`[Execution] 运行记录恢复失败：${entry.name}；新派发已阻断，正常历史仍可查询`, error);
      continue;
    }
    if (record.runId !== entry.name) {
      recoveryBlocked = true;
      console.error(`[Execution] 运行记录目录与 runId 不符：${entry.name}`);
      continue;
    }
    if (!record.stopConfirmed) {
      record.state = 'interrupted';
      record.error = '执行服务重启，无法确认原执行已停止；请核对引擎现场';
      persist(record);
    }
    records.set(record.runId, record);
    requests.set(record.requestId, record.runId);
  }
  const recordOf = (id: string) => {
    const record = records.get(id);
    if (!record) throw new Error('runId 不存在');
    return record;
  };
  const snapshot = (record: RunRecord) => ({ ...record });
  const workspace = (cwd: string) => {
    if (!path.isAbsolute(cwd)) throw new Error('cwd 必须为绝对路径');
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory() || !roots.some((root) => {
      const relative = path.relative(root, canonical);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    })) throw new Error('cwd 不在允许目录内');
    return canonical;
  };
  const finish = (record: RunRecord, result: LaunchResult, active: LiveRun) => {
    if (!result.stopped) {
      if (result.error) { record.error = result.error; record.state = 'interrupted'; }
      persist(record);
      return;
    }
    active.settled = true;
    record.stopConfirmed = true;
    record.state = active.cancelRequested || result.cancelled === true ? 'cancelled' : result.success ? 'succeeded' : 'failed';
    if (result.error) record.error = result.error;
    else delete record.error;
    record.endedAt = new Date().toISOString();
    persist(record);
    live.delete(record.runId);
  };
  const emit = (record: RunRecord, active: LiveRun, message: unknown) => {
    if (active.settled) return;
    const previousState = record.state;
    const object = typeof message === 'object' && message !== null ? message as Record<string, unknown> : {};
    const kind = object.kind;
    const requestId = typeof object.requestId === 'string' ? object.requestId : 'unknown';
    if (kind === 'permission_request') active.approvals.add(requestId);
    if (kind === 'permission_resolved' || kind === 'permission_cancelled') active.approvals.delete(requestId);
    record.state = active.approvals.size ? 'waiting_approval' : 'running';
    if (kind === 'stream_end') active.newTextBlock = true;
    if (kind === 'stream_delta' && object.role !== 'user' && !object.parentToolUseId) {
      const delta = typeof object.content === 'string' ? object.content : object.text;
      if (typeof delta === 'string') {
        record.response = ((active.newTextBlock ? '' : record.response) + delta).slice(-1_000_000);
        active.newTextBlock = false;
      }
    }
    if (kind === 'text' && object.role !== 'user' && !object.parentToolUseId) {
      const text = typeof object.content === 'string' ? object.content : object.text;
      if (typeof text === 'string') record.response = text.slice(-1_000_000);
    }
    const json = JSON.stringify(message);
    // 完整结果留在引擎历史；执行日志只保留有限预览和最终回复，不内嵌大图。
    const event = Buffer.byteLength(json) <= 64_000 ? message : { kind, truncated: true, preview: json.slice(0, 8000) };
    appendFileSync(file(record.runId, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (kind === 'complete') {
      // 回合 complete 之后可能仍有后台任务或进程收尾，终态由 launch.done 确认。
      if (object.aborted === true) active.cancelRequested = true;
    }
    if (record.state !== previousState || kind === 'complete') persist(record);
  };
  const launch = async (raw: unknown, continuation: boolean) => {
    const input = continuation ? continueSchema.parse(raw) : launchSchema.parse(raw);
    const cwd = workspace(input.cwd);
    const requestedSession = 'sessionId' in input && typeof input.sessionId === 'string' ? input.sessionId : null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, cwd })).digest('hex');
    const previous = requests.get(input.requestId);
    if (previous) {
      const record = recordOf(previous);
      if (record.fingerprint !== fingerprint) throw new Error('requestId 已用于不同的执行请求');
      return snapshot(record);
    }
    if (cancelledRequests.has(input.requestId)) throw new Error('执行请求已取消');
    if (recoveryBlocked) throw new Error('运行记录恢复异常，核对现场后才能派发新执行');
    const capabilities = await dependencies.capabilities(input.provider);
    const capability = capabilities.find((entry) => entry.provider === input.provider);
    if (!capability) throw new Error('provider 不支持执行');
    if (!capability.models.includes(input.model)) throw new Error('model 不在引擎模型列表中');
    // 能力查询包含异步等待，返回后再次检查并发的幂等重试。
    const concurrent = requests.get(input.requestId);
    if (concurrent) {
      const record = recordOf(concurrent);
      if (record.fingerprint !== fingerprint) throw new Error('requestId 已用于不同的执行请求');
      return snapshot(record);
    }
    if (cancelledRequests.has(input.requestId)) throw new Error('执行请求已取消');
    if (requestedSession) {
      const history = [...records.values()].filter((entry) => entry.sessionId === requestedSession);
      if (!history.length || !dependencies.sessionExists(requestedSession, input.provider, cwd)
        || history.some((entry) => entry.provider !== input.provider || entry.cwd !== cwd)) throw new Error('原会话不存在或不属于该引擎和目录');
      if (history.some((entry) => !entry.stopConfirmed)) throw new Error('原会话仍在运行或尚未确认停止');
    }
    const sessionId = requestedSession ?? dependencies.createSession(input.provider, cwd, input.prompt);
    const record: RunRecord = {
      version: 1, runId: randomUUID(), sessionId, requestId: input.requestId, fingerprint,
      provider: input.provider, model: input.model, cwd, state: 'running', stopConfirmed: false,
      response: '', startedAt: new Date().toISOString(),
    };
    // 完整记录目录原子发布后才允许启动引擎；崩溃遗留的隐藏暂存目录不代表已执行。
    const staging = path.join(directory, `.${record.runId}.next`);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(path.join(staging, 'events.jsonl'), '', { mode: 0o600 });
    writeFileSync(path.join(staging, 'state.json'), JSON.stringify(record), { mode: 0o600 });
    renameSync(staging, path.join(directory, record.runId));
    records.set(record.runId, record);
    requests.set(record.requestId, record.runId);
    const active: LiveRun = { cancel: async () => false, cancelRequested: false, settled: false, approvals: new Set(), newTextBlock: true };
    live.set(record.runId, active);
    try {
      const handle = dependencies.launch({ ...input, cwd, sessionId }, (message) => emit(record, active, message));
      active.cancel = handle.cancel;
      void handle.done.then((result) => finish(record, result, active)).catch((error: unknown) => {
        // 运行时 Promise 拒绝不代表引擎进程已停止。
        record.error = error instanceof Error ? error.message : '执行失败';
        try { persist(record); } catch (storageError) {
          console.error('[Execution] 无法保存执行失败，停止状态保持未知', storageError);
        }
      });
    } catch (error) {
      finish(record, { success: false, stopped: true, error: error instanceof Error ? error.message : '执行启动失败' }, active);
    }
    return snapshot(record);
  };
  const get = (raw: unknown) => {
    const { runId, cursor } = lookupSchema.parse(raw);
    const record = recordOf(runId);
    const eventsPath = file(runId, 'events.jsonl');
    const size = statSync(eventsPath).size;
    if (cursor > size) throw new Error('cursor 超过输出末尾');
    const fd = openSync(eventsPath, 'r');
    try {
      if (cursor > 0) {
        const previous = Buffer.alloc(1);
        readSync(fd, previous, 0, 1, cursor - 1);
        if (previous[0] !== 10) throw new Error('cursor 必须位于事件边界');
      }
      const buffer = Buffer.alloc(Math.min(262_144, size - cursor));
      readSync(fd, buffer, 0, buffer.length, cursor);
      const last = buffer.lastIndexOf(10);
      const length = last < 0 ? 0 : last + 1;
      const events: unknown[] = length ? buffer.subarray(0, length).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as unknown) : [];
      return { ...snapshot(record), events, cursor: cursor + length, hasMore: cursor + length < size };
    } finally { closeSync(fd); }
  };
  const cancel = async (raw: unknown) => {
    const input = cancelSchema.parse(raw);
    if (Boolean(input.runId) === Boolean(input.requestId)) throw new Error('取消须且只能指定 runId 或 requestId');
    const runId = input.runId ?? requests.get(input.requestId!);
    if (input.requestId) {
      // 先写取消墓碑，再查运行；它也会阻止仍在等待能力查询的迟到启动。
      const cancellationFile = path.join(cancellationDirectory, `${input.requestId}.json`);
      const temporary = `${cancellationFile}.next`;
      writeFileSync(temporary, JSON.stringify({ requestId: input.requestId }), { mode: 0o600 });
      renameSync(temporary, cancellationFile);
      cancelledRequests.add(input.requestId);
    }
    if (!runId) return { requestId: input.requestId!, state: recoveryBlocked ? 'interrupted' as const : 'cancelled' as const, stopConfirmed: !recoveryBlocked };
    const record = recordOf(runId);
    if (record.stopConfirmed) return snapshot(record);
    const active = live.get(runId);
    if (!active) return snapshot(record);
    active.cancelRequested = true;
    let accepted = false;
    try { accepted = await active.cancel(); } finally {
      if (!accepted && !record.stopConfirmed) active.cancelRequested = false;
    }
    if (!accepted && !record.stopConfirmed) record.error = '引擎未确认取消，执行现场保留';
    persist(record);
    return snapshot(record);
  };
  const tools = [
    { name: 'execution_capabilities', description: '查询可执行引擎和模型。执行使用 CloudCLI 服务端环境，不接受环境变量覆盖。', schema: z.object({}).strict() },
    { name: 'execution_start', description: '在允许目录启动执行，立即返回持久化的运行和会话标识；requestId 用于幂等重试。', schema: launchSchema },
    { name: 'execution_continue', description: '在原会话继续执行；会话丢失时报错，不创建替代会话。', schema: continueSchema },
    { name: 'execution_get', description: '查询状态、最终回复和分页事件；cursor 是服务端返回的字节游标。', schema: lookupSchema },
    { name: 'execution_cancel', description: '按 runId 或 requestId 取消；未启动的请求记录取消墓碑，阻止迟到启动。仅 stopConfirmed=true 表示执行已停止。', schema: cancelSchema },
  ];
  return {
    start: (raw: unknown) => launch(raw, false),
    continue: (raw: unknown) => launch(raw, true),
    get, cancel, tools,
    async call(name: string, input: unknown): Promise<unknown> {
      switch (name) {
        case 'execution_capabilities':
          tools[0].schema.parse(input);
          return { version: 1, environment: 'server', executorEnvDeny: false, providers: await dependencies.capabilities() };
        case 'execution_start': return launch(input, false);
        case 'execution_continue': return launch(input, true);
        case 'execution_get': return get(input);
        case 'execution_cancel': return cancel(input);
        default: throw new Error('未知执行工具');
      }
    },
  };
}
