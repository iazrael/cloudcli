import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { requestPathsExist } from '@/shared/api';
import { createBatchedAccountRequester } from '@/shared/batchedRequester';
import type { PathExistenceRequest, PathExistenceResult } from '@/shared/types';

/** 探测结论：pending 表示还没有可用结论；missing 表示明确不存在或不可读。 */
type PathExistenceVerdict = 'pending' | 'exists' | 'missing' | 'unknown';
type PathExistenceSource = Omit<PathExistenceRequest, 'id'>;

const pathProbes = createBatchedAccountRequester<PathExistenceSource, PathExistenceVerdict, void>({
  cacheKey: (source) => JSON.stringify(source),
  send: requestPathsExist,
  settle: (batch, payload) => {
    const { results } = payload as { results: PathExistenceResult[] };
    for (const item of batch) {
      const status = results.find((result) => result.id === item.id)?.status;
      if (status === 200) {
        item.entry.value = 'exists';
        item.resolve('exists');
        continue;
      }
      // 失败结论不进缓存：文件稍后被创建时，下一次挂载会重新探测并恢复可点。
      item.drop();
      item.resolve(status === 404 || status === 403 ? 'missing' : 'unknown');
    }
  },
  // 网络或接口失败按未知处理，调用方保持引用可点。
  fail: (batch) => { for (const item of batch) { item.drop(); item.resolve('unknown'); } },
});

/** 聊天 Markdown 专用：挂载时探测本地文件、目录引用的可读性，明确不可读的引用由调用方退回普通文字。 */
export function usePathExists(source: PathExistenceSource | null): PathExistenceVerdict {
  // 订阅账号事件：缓存失效后通过重渲染重新探测。
  useSyncExternalStore(pathProbes.subscribe, pathProbes.snapshot, () => '');
  const sourceKey = source ? JSON.stringify(source) : '';
  // 只展示当前引用的结论，忽略换引用或卸载后的旧异步结果。
  const [verdictState, setVerdictState] = useState<{ key: string; verdict: PathExistenceVerdict } | null>(null);
  // 请求代次只供异步流程比较，不参与渲染。
  const active = useRef({ key: sourceKey, serial: 0 });
  useEffect(() => {
    if (active.current.key !== sourceKey) active.current = { key: sourceKey, serial: active.current.serial + 1 };
  }, [sourceKey]);
  useEffect(() => {
    if (!sourceKey) return;
    let disposed = false;
    const serial = ++active.current.serial;
    queueMicrotask(() => {
      if (disposed) return;
      pathProbes.request(JSON.parse(sourceKey) as PathExistenceRequest).then((verdict) => {
        if (!disposed && active.current.key === sourceKey && active.current.serial === serial) setVerdictState({ key: sourceKey, verdict });
      }).catch(() => {
        // 账号切换会拒绝在途请求；按未知处理，调用方保持引用可点。
        if (!disposed && active.current.key === sourceKey && active.current.serial === serial) setVerdictState({ key: sourceKey, verdict: 'unknown' });
      });
    });
    return () => { disposed = true; };
  }, [sourceKey]);
  if (!sourceKey) return 'unknown';
  return verdictState?.key === sourceKey ? verdictState.verdict : 'pending';
}

/**
 * 双候选探测（会话工作树优先、项目根兜底）：任一候选存在即算存在并给出
 * 该候选路径；全部非空候选都明确缺失才算缺失；有待定结论保持 pending，
 * 有未知结论保持 unknown，调用方据此维持可点。
 */
export function usePathExistsCandidates(
  primary: PathExistenceSource | null,
  fallback: PathExistenceSource | null,
): { verdict: PathExistenceVerdict; existsPath: string | null } {
  const primaryVerdict = usePathExists(primary);
  const fallbackVerdict = usePathExists(fallback);
  if (primary && primaryVerdict === 'exists') return { verdict: 'exists', existsPath: primary.path };
  if (fallback && fallbackVerdict === 'exists') return { verdict: 'exists', existsPath: fallback.path };
  const verdicts = [primary ? primaryVerdict : null, fallback ? fallbackVerdict : null].filter((v): v is PathExistenceVerdict => v !== null);
  if (verdicts.length === 0) return { verdict: 'unknown', existsPath: null };
  if (verdicts.every((verdict) => verdict === 'missing')) return { verdict: 'missing', existsPath: null };
  if (verdicts.some((verdict) => verdict === 'unknown')) return { verdict: 'unknown', existsPath: null };
  return { verdict: 'pending', existsPath: null };
}
