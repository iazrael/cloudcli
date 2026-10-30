import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { requestImageUrls } from '@/shared/api';
import { createBatchedAccountRequester } from '@/shared/batchedRequester';
import type { ImageFailure, ImageMediaResult, ImageMediaSource } from '@/shared/types';

type Ticket = { url: string; expiresAt: number };
type TicketItem = { source: ImageMediaSource; scope: string; failedUrl?: string };
const EXPIRY_MARGIN_MS = 30_000;

function errorFromStatus(status: number): Error {
  return new Error(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'notFound' : status === 415 ? 'decode' : 'failed');
}

const imageTickets = createBatchedAccountRequester<TicketItem, Ticket, Error>({
  cacheKey: (item) => JSON.stringify([item.scope, item.source]),
  // 票据未过期且不是刚失败的那个地址时复用；过期或图片加载失败重试都重新申请。
  reusable: (entry, item) => !entry.value || (entry.value.expiresAt > Date.now() + EXPIRY_MARGIN_MS && entry.value.url !== item.failedUrl),
  // 线上契约是扁平的 { ...source, id }；scope 与 failedUrl 只用于客户端缓存键。
  send: (items) => requestImageUrls(items.map(({ source, id }) => ({ ...source, id }))),
  httpError: errorFromStatus,
  settle: (batch, payload) => {
    const { images } = payload as { images: ImageMediaResult[] };
    for (const item of batch) {
      const result = images.find((image) => image.id === item.id);
      if (!result || !('url' in result)) { item.drop(); item.reject(errorFromStatus(result && 'status' in result ? result.status : 500)); continue; }
      // 只接受同源签名路径，不能把异常响应中的地址当作外部凭据使用。
      if (!result.url.startsWith('/api/media/images?ticket=') || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) {
        item.drop(); item.reject(new Error('failed')); continue;
      }
      const ticket: Ticket = { url: result.url, expiresAt: result.expiresAt };
      item.entry.value = ticket;
      item.resolve(ticket);
    }
  },
  fail: (batch, error) => { for (const item of batch) { item.drop(); item.reject(error instanceof Error ? error : new Error('failed')); } },
  invalidationError: () => new Error('unauthorized'),
});

/** 聊天、编辑器和文件树共用；只为可见图片申请签名，字节加载和缓存交给浏览器。 */
export function useSignedImage(source: ImageMediaSource | null, { eager = false }: { eager?: boolean } = {}) {
  const scope = useSyncExternalStore(imageTickets.subscribe, imageTickets.snapshot, () => 'server');
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
      const ticket = await imageTickets.request({ source: JSON.parse(sourceKey) as ImageMediaSource, scope, failedUrl });
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
