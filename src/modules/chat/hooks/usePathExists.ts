import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { requestPathsExist } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, getAuthTokenAccountScope } from '@/shared/authToken';
import { AUTH_ACCOUNT_CHANGED_EVENT } from '@/shared/constants';
import type { PathExistenceRequest, PathExistenceResult } from '@/shared/types';

/** 探测结论：pending 表示还没有可用结论；missing 表示明确不存在或不可读。 */
type PathExistenceVerdict = 'pending' | 'exists' | 'missing' | 'unknown';
type CacheEntry = { promise: Promise<PathExistenceVerdict>; verdict?: PathExistenceVerdict };
type PathExistenceSource = Omit<PathExistenceRequest, 'id'>;
type PendingItem = { source: PathExistenceSource; resolve: (verdict: PathExistenceVerdict) => void; reject: () => void };

const CACHE_LIMIT = 256;
const BATCH_LIMIT = 50;
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, PendingItem>();
const subscribers = new Set<() => void>();
let scheduled = false;
let batchSequence = 0;
let epoch = 0;

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}
// 账号切换使缓存和在途请求全部失效；同账号的令牌刷新只触发重渲染。
let lastAccount = '';
function accountChanged(event: Event) {
  if (event instanceof StorageEvent && event.key !== 'auth-token' && event.key !== null) return;
  const account = getAuthTokenAccountScope();
  if (account !== lastAccount || event.type === AUTH_ACCOUNT_CHANGED_EVENT || event.type === AUTH_SESSION_EXPIRED_EVENT) {
    lastAccount = account;
    epoch++;
    cache.clear();
    for (const item of pending.values()) item.reject();
    pending.clear();
  }
  for (const notify of subscribers) notify();
}
const accountEvents = [AUTH_ACCOUNT_CHANGED_EVENT, AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, 'storage'];
// 缓存比引用组件活得久，注销监听也必须在没有订阅者时保留。
if (typeof window !== 'undefined') {
  for (const event of accountEvents) window.addEventListener(event, accountChanged);
  import.meta.hot?.dispose(() => {
    for (const event of accountEvents) window.removeEventListener(event, accountChanged);
  });
}

async function flush() {
  scheduled = false;
  const entries = [...pending.entries()];
  pending.clear();
  const requestEpoch = epoch;
  for (let offset = 0; offset < entries.length; offset += BATCH_LIMIT) {
    const batch = entries.slice(offset, offset + BATCH_LIMIT);
    const batchId = String(++batchSequence);
    try {
      const response = await requestPathsExist(batch.map(([, item], index) => ({ ...item.source, id: `${batchId}-${index}` })));
      // 账号已切换时丢弃整批结果，不把上一个账号的结论交给新账号。
      if (requestEpoch !== epoch) { for (const [, item] of batch) item.reject(); continue; }
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json() as { results: PathExistenceResult[] };
      for (const [index, [key, item]] of batch.entries()) {
        const status = payload.results.find((result) => result.id === `${batchId}-${index}`)?.status;
        if (status === 200) {
          const entry = cache.get(key);
          if (entry) entry.verdict = 'exists';
          item.resolve('exists');
          continue;
        }
        // 失败结论不进缓存：文件稍后被创建时，下一次挂载会重新探测并恢复可点。
        cache.delete(key);
        item.resolve(status === 404 || status === 403 ? 'missing' : 'unknown');
      }
    } catch {
      for (const [key, item] of batch) { cache.delete(key); item.resolve('unknown'); }
    }
  }
}

function requestVerdict(source: PathExistenceSource): Promise<PathExistenceVerdict> {
  const key = JSON.stringify(source);
  const existing = cache.get(key);
  if (existing) return existing.promise;
  const promise = new Promise<PathExistenceVerdict>((resolve, reject) => pending.set(key, { source, resolve, reject }));
  cache.set(key, { promise });
  // 只淘汰已完成的成功条目，进行中的请求仍有调用方在等待。
  for (const [oldKey, entry] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    if (entry.verdict) cache.delete(oldKey);
  }
  if (!scheduled) { scheduled = true; queueMicrotask(() => { void flush(); }); }
  return promise;
}

/** 聊天 Markdown 专用：挂载时探测本地文件、目录引用的可读性，明确不可读的引用由调用方退回普通文字。 */
export function usePathExists(source: PathExistenceSource | null): PathExistenceVerdict {
  // 订阅账号事件：缓存失效后通过重渲染重新探测。
  useSyncExternalStore(subscribe, () => epoch, () => 0);
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
      requestVerdict(JSON.parse(sourceKey) as PathExistenceRequest).then((verdict) => {
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
