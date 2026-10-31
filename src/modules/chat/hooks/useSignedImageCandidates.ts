import { useCallback } from 'react';

import { useSignedImage } from '@/shared/hooks/useSignedImage';
import type { ImageFailure, ImageMediaSource } from '@/shared/types';

/**
 * 双候选签名（会话工作树优先、项目根兜底）：任一候选拿到票据就用它；只有
 * 全部候选都明确失败才对外暴露错误。可见性回调合并驱动两个候选，点击重试
 * 同时重探两路；加载与续签回调只转给当前出图的一路。
 */
export function useSignedImageCandidates(
  primary: ImageMediaSource | null,
  fallback: ImageMediaSource | null,
  options: { eager?: boolean } = {},
) {
  const { eager = false } = options;
  const primarySigned = useSignedImage(primary, { eager });
  const fallbackSigned = useSignedImage(fallback, { eager });
  const primaryObserve = primarySigned.observe;
  const fallbackObserve = fallbackSigned.observe;
  // 两个候选共享同一个可见性宿主节点，任一路加载都跟随视口；observe 在共享
  // Hook 里是稳定引用，这样合并回调不会随票据状态变化而重建。
  const observe = useCallback((node: HTMLElement | null) => {
    primaryObserve(node);
    fallbackObserve(node);
  }, [primaryObserve, fallbackObserve]);

  const url = primarySigned.url ?? fallbackSigned.url;
  // 出图的一路负责加载与续签回调，避免把图片事件灌进未显示的候选。
  const active = primarySigned.url ? primarySigned : fallbackSigned;
  // 兜底候选未出结论前不判失败，避免工作树候选的结论抢跑项目根候选。
  const error: ImageFailure | undefined = url
    ? undefined
    : fallback
      ? fallbackSigned.error ?? undefined
      : primarySigned.error ?? undefined;

  return {
    observe,
    url,
    error,
    retry: () => { primarySigned.retry(); fallbackSigned.retry(); },
    onLoad: active.onLoad,
    onError: active.onError,
    ensureFresh: active.ensureFresh,
  };
}
