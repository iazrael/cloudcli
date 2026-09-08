import { useEffect } from 'react';

/** Smallest visual-viewport shrinkage treated as a visible keyboard; anything less is layout noise. */
const MIN_KEYBOARD_HEIGHT_PX = 150;

/** Wait for iOS to finish its keyboard-hide animation before re-syncing after focus loss. */
const FOCUS_OUT_RESYNC_DELAY_MS = 350;

/**
 * Keeps the fixed workspace shell above the virtual keyboard in iOS Safari.
 *
 * The shell lifts its bottom edge by `--keyboard-height`, so a stale non-zero
 * value leaves a blank band where the keyboard used to be. iOS hides the
 * keyboard without a final visualViewport resize in several paths (unmounting
 * the focused input on tab/route switches, IME changes), so every sync
 * re-derives the height from live geometry and clears it whenever no real
 * keyboard is covering the bottom of the layout viewport.
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    const updateKeyboardHeight = () => {
      // The keyboard is the bottom band of the layout viewport the visual
      // viewport does not cover; offsetTop removes the page scroll iOS applies
      // while lifting a focused input so scrolling never looks like a keyboard.
      const hiddenHeight = window.innerHeight - visualViewport.offsetTop - visualViewport.height;
      const keyboardHeight = hiddenHeight >= MIN_KEYBOARD_HEIGHT_PX ? hiddenHeight : 0;
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    };

    updateKeyboardHeight();

    visualViewport.addEventListener('resize', updateKeyboardHeight);
    visualViewport.addEventListener('scroll', updateKeyboardHeight);
    window.addEventListener('resize', updateKeyboardHeight);

    // Late re-sync when focus leaves an input: covers the iOS path where the
    // keyboard closes silently (no resize events) because the focused element
    // unmounted during a navigation.
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;
    const handleFocusOut = () => {
      if (resyncTimer !== undefined) {
        clearTimeout(resyncTimer);
      }
      resyncTimer = setTimeout(updateKeyboardHeight, FOCUS_OUT_RESYNC_DELAY_MS);
    };
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      if (resyncTimer !== undefined) {
        clearTimeout(resyncTimer);
      }
      visualViewport.removeEventListener('resize', updateKeyboardHeight);
      visualViewport.removeEventListener('scroll', updateKeyboardHeight);
      window.removeEventListener('resize', updateKeyboardHeight);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, []);
}
