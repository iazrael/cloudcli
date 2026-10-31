import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, getAuthTokenAccountScope } from '@/shared/authToken';
import { AUTH_ACCOUNT_CHANGED_EVENT } from '@/shared/constants';

/** 批量请求器的缓存条目；`value` 由消费方在结算时写入，作为"已完成"标记供容量淘汰。 */
export type BatchedEntry<TValue> = { promise: Promise<TValue>; value?: TValue };

/** 一批内单个待结算条目：`entry` 是缓存条目本体，`drop` 把失败结论排除在缓存外。 */
export type BatchedItem<TItem, TValue, TFail> = {
  id: string;
  item: TItem;
  key: string;
  entry: BatchedEntry<TValue>;
  resolve: (value: TValue) => void;
  reject: (error?: TFail) => void;
  drop: () => void;
};

type BatchedRequesterConfig<TItem, TValue, TFail> = {
  /** 单条请求的缓存键；同键并发共享一次请求。 */
  cacheKey: (item: TItem) => string;
  /** 已有条目是否可复用（如票据未过期）；缺省一律复用。 */
  reusable?: (entry: BatchedEntry<TValue>, item: TItem) => boolean;
  /** 发起一批请求；`items` 已带同批内唯一的 `id`。 */
  send: (items: Array<TItem & { id: string }>) => Promise<Response>;
  /** 非 2xx 响应抛出的错误；缺省为携带状态码文本的 Error。 */
  httpError?: (status: number) => TFail;
  /** 结算一批成功响应：写 `entry.value` 并逐条 resolve/reject。 */
  settle: (batch: ReadonlyArray<BatchedItem<TItem, TValue, TFail>>, payload: unknown) => void;
  /** 一批请求失败（网络、HTTP、账号切换）时的逐条收尾。 */
  fail: (batch: ReadonlyArray<BatchedItem<TItem, TValue, TFail>>, error: unknown) => void;
  /** 账号切换/会话过期时拒绝在途条目所用的错误；缺省无载荷。 */
  invalidationError?: () => TFail;
  cacheLimit?: number;
  batchLimit?: number;
};

/**
 * 账号作用域的批量请求基础设施，由 useSignedImage 与聊天模块的 usePathExists 共用：
 * 模块级缓存去重、相邻请求按上限分批，账号切换与会话过期使整缓存失效并拒绝在途
 * 请求；失效经 subscribe/snapshot（供 useSyncExternalStore）触发组件重渲染重探。
 */
export function createBatchedAccountRequester<TItem, TValue, TFail = Error>(
  config: BatchedRequesterConfig<TItem, TValue, TFail>,
) {
  const cacheLimit = config.cacheLimit ?? 256;
  const batchLimit = config.batchLimit ?? 50;
  const cache = new Map<string, BatchedEntry<TValue>>();
  const pending = new Map<string, { item: TItem; resolve: (value: TValue) => void; reject: (error?: TFail) => void }>();
  const subscribers = new Set<() => void>();
  let scheduled = false;
  let batchSequence = 0;
  let epoch = 0;
  let lastAccount = '';

  function snapshot() {
    return `${epoch}:${getAuthTokenAccountScope()}`;
  }

  // 账号切换使缓存和在途请求全部失效；同账号的令牌刷新只触发重渲染。
  function accountChanged(event: Event) {
    if (event instanceof StorageEvent && event.key !== 'auth-token' && event.key !== null) return;
    const account = getAuthTokenAccountScope();
    if (account !== lastAccount || event.type === AUTH_ACCOUNT_CHANGED_EVENT || event.type === AUTH_SESSION_EXPIRED_EVENT) {
      lastAccount = account;
      epoch++;
      cache.clear();
      const error = config.invalidationError?.();
      for (const item of pending.values()) item.reject(error);
      pending.clear();
    }
    for (const notify of subscribers) notify();
  }
  const accountEvents = [AUTH_ACCOUNT_CHANGED_EVENT, AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, 'storage'];
  // 缓存比单个组件活得久，注销监听也必须在没有订阅者时保留。
  if (typeof window !== 'undefined') {
    for (const event of accountEvents) window.addEventListener(event, accountChanged);
    import.meta.hot?.dispose(() => {
      for (const event of accountEvents) window.removeEventListener(event, accountChanged);
    });
  }

  function subscribe(notify: () => void) {
    // 长期无订阅后恢复时按当前账号重建缓存归属。
    if (subscribers.size === 0 && lastAccount !== getAuthTokenAccountScope()) {
      cache.clear();
      lastAccount = getAuthTokenAccountScope();
    }
    subscribers.add(notify);
    return () => { subscribers.delete(notify); };
  }

  // 只淘汰已完成条目，进行中的请求仍有调用方在等待。
  function evictCompleted() {
    for (const [key, entry] of cache) {
      if (cache.size <= cacheLimit) break;
      if (entry.value !== undefined) cache.delete(key);
    }
  }

  async function flush() {
    scheduled = false;
    const entries = [...pending.entries()];
    pending.clear();
    const flushEpoch = epoch;
    for (let offset = 0; offset < entries.length; offset += batchLimit) {
      const batchId = String(++batchSequence);
      const batch: Array<BatchedItem<TItem, TValue, TFail>> = entries.slice(offset, offset + batchLimit)
        .map(([key, item], index) => ({
          id: `${batchId}-${index}`,
          item: item.item,
          key,
          entry: cache.get(key)!,
          resolve: item.resolve,
          reject: item.reject,
          drop: () => { cache.delete(key); },
        }));
      try {
        const response = await config.send(batch.map(({ item, id }) => ({ ...item, id })));
        // 账号已切换时丢弃整批，不把上一个账号的结果交给新账号。
        if (flushEpoch !== epoch) {
          const error = config.invalidationError?.();
          for (const item of batch) item.reject(error);
          continue;
        }
        if (!response.ok) throw config.httpError ? config.httpError(response.status) : new Error(String(response.status));
        config.settle(batch, await response.json());
        evictCompleted();
      } catch (error) {
        config.fail(batch, error);
      }
    }
  }

  function request(item: TItem): Promise<TValue> {
    const key = config.cacheKey(item);
    const existing = cache.get(key);
    if (existing && (!config.reusable || config.reusable(existing, item))) return existing.promise;
    cache.delete(key);
    const promise = new Promise<TValue>((resolve, reject) => pending.set(key, { item, resolve, reject }));
    cache.set(key, { promise });
    evictCompleted();
    if (!scheduled) { scheduled = true; queueMicrotask(() => { void flush(); }); }
    return promise;
  }

  return { request, subscribe, snapshot };
}
