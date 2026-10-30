import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { requestImageUrls } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, getAuthTokenAccountScope } from '@/shared/authToken';
import { AUTH_ACCOUNT_CHANGED_EVENT } from '@/shared/constants';
import type { ImageMediaSource, ImageMediaResult } from '@/shared/types';

type ImageFailure = 'unauthorized' | 'forbidden' | 'notFound' | 'failed' | 'decode';
type Ticket = { url: string; expiresAt: number };
type Pending = { scope: string; source: ImageMediaSource; resolve: (ticket: Ticket) => void; reject: (error: Error) => void };
const CACHE_LIMIT = 256;
const EXPIRY_MARGIN_MS = 30_000;
const cache = new Map<string, { promise: Promise<Ticket>; ticket?: Ticket }>();
const pending = new Map<string, Pending>();
const subscribers = new Set<() => void>();
let scheduled = false;
let batchSequence = 0;
let accountEpoch = 0;

const snapshot = () => `${accountEpoch}:${getAuthTokenAccountScope()}`;
let lastAccount = '';
function accountChanged(event: Event) {
  if (event instanceof StorageEvent && event.key !== 'auth-token' && event.key !== null) return;
  const account = getAuthTokenAccountScope();
  if (account !== lastAccount || event.type === AUTH_ACCOUNT_CHANGED_EVENT || event.type === AUTH_SESSION_EXPIRED_EVENT) {
    lastAccount = account;
    accountEpoch++;
    cache.clear();
    for (const item of pending.values()) item.reject(new Error('unauthorized'));
    pending.clear();
  }
  for (const notify of subscribers) notify();
}
const accountEvents = [AUTH_ACCOUNT_CHANGED_EVENT, AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, 'storage'];
// 缓存比图片组件活得久，注销监听也必须在没有订阅者时保留。
if (typeof window !== 'undefined') {
  for (const event of accountEvents) window.addEventListener(event, accountChanged);
  import.meta.hot?.dispose(() => {
    for (const event of accountEvents) window.removeEventListener(event, accountChanged);
  });
}
function subscribe(notify: () => void) {
  if (subscribers.size === 0) {
    if (lastAccount !== getAuthTokenAccountScope()) { cache.clear(); lastAccount = getAuthTokenAccountScope(); }
  }
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}
function errorFromStatus(status: number): Error {
  return new Error(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'notFound' : status === 415 ? 'decode' : 'failed');
}
async function flush() {
  scheduled = false;
  const entries = [...pending.entries()];
  pending.clear();
  for (let offset = 0; offset < entries.length; offset += 50) {
    const batch = entries.slice(offset, offset + 50);
    const id = String(++batchSequence);
    const requests = batch.map(([, item], index) => ({ ...item.source, id: `${id}-${index}` }));
    try {
      if (batch.some(([, item]) => item.scope !== snapshot())) throw new Error('unauthorized');
      const response = await requestImageUrls(requests);
      if (!response.ok) throw errorFromStatus(response.status);
      const payload = await response.json() as { images: ImageMediaResult[] };
      for (const [index, [key, item]] of batch.entries()) {
        const result = payload.images.find((image) => image.id === requests[index].id);
        if (item.scope !== snapshot()) { item.reject(new Error('unauthorized')); continue; }
        if (!result || !('url' in result)) { cache.delete(key); item.reject(errorFromStatus(result && 'status' in result ? result.status : 500)); continue; }
        // 只接受同源签名路径，不能把异常响应中的地址当作外部凭据使用。
        if (!result.url.startsWith('/api/media/images?ticket=') || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) {
          cache.delete(key); item.reject(new Error('failed')); continue;
        }
        const ticket = { url: result.url, expiresAt: result.expiresAt };
        const entry = cache.get(key);
        if (entry) entry.ticket = ticket;
        for (const [oldKey, oldEntry] of cache) {
          if (cache.size <= CACHE_LIMIT) break;
          if (oldEntry.ticket) cache.delete(oldKey);
        }
        item.resolve(ticket);
      }
    } catch (error) {
      for (const [key, item] of batch) { cache.delete(key); item.reject(error instanceof Error ? error : new Error('failed')); }
    }
  }
}
function requestTicket(source: ImageMediaSource, scope: string, failedUrl?: string): Promise<Ticket> {
  const key = JSON.stringify([scope, source]);
  const existing = cache.get(key);
  if (existing && (!existing.ticket || (existing.ticket.expiresAt > Date.now() + EXPIRY_MARGIN_MS && existing.ticket.url !== failedUrl))) {
    return existing.promise;
  }
  cache.delete(key);
  const promise = new Promise<Ticket>((resolve, reject) => pending.set(key, { source, scope, resolve, reject }));
  cache.set(key, { promise });
  // 仅淘汰已完成条目，进行中的请求仍有调用方等待结果。
  for (const [oldKey, entry] of cache) {
    if (cache.size <= CACHE_LIMIT) break;
    if (entry.ticket) cache.delete(oldKey);
  }
  if (!scheduled) { scheduled = true; queueMicrotask(() => { void flush(); }); }
  return promise;
}

/** 聊天、编辑器和文件树共用；只为可见图片申请签名，字节加载和缓存交给浏览器。 */
export function useSignedImage(source: ImageMediaSource | null, { eager = false }: { eager?: boolean } = {}) {
  const scope = useSyncExternalStore(subscribe, snapshot, () => 'server');
  const sourceKey = source ? JSON.stringify(source) : '';
  const key = `${scope}:${sourceKey}`;
  // 跟踪实际占位或容器节点，让签名申请跟随视口位置。
  const [element, setElement] = useState<HTMLElement | null>(null);
  // 可见性归属当前引用，切换图片后重新判断。
  const [visibleKey, setVisibleKey] = useState('');
  // 只展示当前引用的票据或错误，忽略旧异步结果。
  const [loaded, setLoaded] = useState<{ key: string; ticket?: Ticket; error?: ImageFailure } | null>(null);
  // 请求代次、重试次数和显示状态只供异步流程使用，不参与渲染。
  const active = useRef({ key, serial: 0, retries: 0, displayed: false });
  useEffect(() => {
    if (active.current.key !== key) active.current = { key, serial: active.current.serial + 1, retries: 0, displayed: false };
  }, [key]);
  const current = loaded?.key === key ? loaded : null;
  const observe = useCallback((node: HTMLElement | null) => setElement(node), []);
  const visible = eager || typeof IntersectionObserver === 'undefined' || visibleKey === key;

  useEffect(() => {
    if (!sourceKey || eager || !element) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisibleKey(key); observer.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, eager, key, sourceKey]);

  const load = useCallback(async (failedUrl?: string) => {
    if (!sourceKey) return null;
    const serial = ++active.current.serial;
    try {
      const ticket = await requestTicket(JSON.parse(sourceKey) as ImageMediaSource, scope, failedUrl);
      if (active.current.key !== key || active.current.serial !== serial) return null;
      setLoaded({ key, ticket });
      return ticket.url;
    } catch (error) {
      if (active.current.key === key && active.current.serial === serial) {
        const reason = error instanceof Error && ['unauthorized', 'forbidden', 'notFound', 'decode'].includes(error.message) ? error.message as ImageFailure : 'failed';
        setLoaded({ key, error: reason });
      }
      return null;
    }
  }, [sourceKey, scope, key, active]);

  useEffect(() => {
    let disposed = false;
    if (visible && sourceKey) queueMicrotask(() => { if (!disposed) void load(); });
    return () => { disposed = true; active.current.serial++; };
  }, [visible, sourceKey, load, active]);

  // 后台标签页可能延迟懒加载，切回时检查尚未显示图片的票据。
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible' && visible && !active.current.displayed && current?.ticket
        && current.ticket.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) void load();
    };
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [visible, current, load, active]);

  const onError = () => {
    if (active.current.retries >= 1) { setLoaded({ ...current, key, error: 'decode' }); return; }
    active.current.retries++;
    void load(current?.ticket?.url);
  };
  const retry = () => {
    active.current.retries = 0;
    active.current.displayed = false;
    void load(current?.ticket?.url);
  };
  const ensureFresh = () => load();
  return { observe, url: current?.error ? null : current?.ticket?.url ?? null, error: current?.error, onError, onLoad: () => { active.current.displayed = true; }, retry, ensureFresh };
}
