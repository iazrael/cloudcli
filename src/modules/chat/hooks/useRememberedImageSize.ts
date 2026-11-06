import { useCallback, useState } from 'react';
import type { CSSProperties, SyntheticEvent } from 'react';

type ImageSize = { width: number; height: number };

const REMEMBERED_SIZE_LIMIT = 512;

// 组件被虚拟列表卸载后 state 会丢，尺寸只能放在组件之外。Map 按写入顺序迭代，最早的先淘汰。
const rememberedSizes = new Map<string, ImageSize>();

/**
 * 记住转录图片解码后的原始尺寸。图片行重新挂载时用它占住原来的高度，
 * 否则 virtua 会把占位与真实高度之差写进滚动偏移。`imageKey` 为 null 表示这张图不需要记。
 */
export function useRememberedImageSize(imageKey: string | null) {
  // 首次加载后触发一次重渲染，让当前实例也换成稳定盒子；尺寸本身以 rememberedSizes 为准。
  const [, setDecodedSize] = useState<ImageSize | null>(null);
  const remember = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    if (imageKey === null || !width || !height) return;
    const size = { width, height };
    rememberedSizes.delete(imageKey);
    rememberedSizes.set(imageKey, size);
    if (rememberedSizes.size > REMEMBERED_SIZE_LIMIT) {
      rememberedSizes.delete(rememberedSizes.keys().next().value as string);
    }
    setDecodedSize(size);
  }, [imageKey]);
  return { size: imageKey === null ? null : rememberedSizes.get(imageKey) ?? null, remember };
}

/**
 * 与 `h-auto w-auto max-w-full` 加高度上限等价的显式盒子：不放大、不超出容器、高度不过上限。
 * 不依赖图片是否已解码，占位和图片用它得到同一个高度。
 */
export function reservedImageBox(size: ImageSize, maxHeight?: string): CSSProperties {
  const limits = [`${size.width}px`, '100%', ...(maxHeight ? [`calc(${maxHeight} * ${size.width / size.height})`] : [])];
  return { width: `min(${limits.join(', ')})`, aspectRatio: `${size.width} / ${size.height}` };
}
