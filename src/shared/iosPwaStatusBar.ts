import { getIsPWA } from '@/shared/hooks/useDeviceSettings';

/** 在应用入口安装 iOS PWA 状态栏的兼容处理。 */
export function setupIosPwaStatusBar(): (() => void) | undefined {
  if (!window.CSS?.supports('-webkit-touch-callout', 'none') || !getIsPWA()) {
    return;
  }

  const strip = document.querySelector<HTMLElement>('.ios-pwa-status-strip');
  if (!strip) return;
  strip.classList.add('is-active');

  let frame: number | undefined;
  const reset = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    strip.style.removeProperty('top');
  };

  const refresh = () => {
    if (document.visibilityState !== 'visible') {
      reset();
      return;
    }
    if (frame !== undefined) return;

    // 让 WebKit 先看到色带离开顶边，再在下一帧重新取样。
    frame = window.requestAnimationFrame(() => {
      strip.style.top = '12px';
      frame = window.requestAnimationFrame(() => {
        strip.style.removeProperty('top');
        frame = undefined;
      });
    });
  };

  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pageshow', refresh);
  refresh();

  return () => {
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('pageshow', refresh);
    reset();
    strip.classList.remove('is-active');
  };
}
