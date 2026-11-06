import { useCallback, useState } from 'react';
import type { CSSProperties, SyntheticEvent } from 'react';

type ImageSize = { width: number; height: number };

const REMEMBERED_SIZE_LIMIT = 512;

// 组件被虚拟列表卸载后 state 会丢，尺寸只能放在组件之外。Map 按写入顺序迭代，最早的先淘汰。
const rememberedSizes = new Map<string, ImageSize>();

/**
 * 记住 Markdown 图片解码后的原始尺寸。图片行重新挂载时用它占住原来的高度，
 * 否则 virtua 会把占位与真实高度之差写进滚动偏移。
 */
export function useRememberedImageSize(imageKey: string) {
  // 首次加载后触发一次重渲染，让当前实例也换成稳定盒子；尺寸本身以 rememberedSizes 为准。
  const [, setDecodedSize] = useState<ImageSize | null>(null);
  const remember = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    if (!width || !height) return;
    const size = { width, height };
    rememberedSizes.delete(imageKey);
    rememberedSizes.set(imageKey, size);
    if (rememberedSizes.size > REMEMBERED_SIZE_LIMIT) {
      rememberedSizes.delete(rememberedSizes.keys().next().value as string);
    }
    setDecodedSize(size);
  }, [imageKey]);
  return { size: rememberedSizes.get(imageKey) ?? null, remember };
}

/**
 * 不放大、不超出容器的显式盒子。不依赖图片是否已解码，占位用它得到和图片相同的高度。
 */
export function reservedImageBox(size: ImageSize): CSSProperties {
  return { width: `min(${size.width}px, 100%)`, aspectRatio: `${size.width} / ${size.height}` };
}
