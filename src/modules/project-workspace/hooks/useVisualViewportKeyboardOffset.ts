import { useEffect } from 'react';

/** Smallest visual-viewport shrinkage treated as a visible keyboard; anything less is layout noise. */
const MIN_KEYBOARD_HEIGHT_PX = 150;

/** Wait for iOS to finish its keyboard-hide animation before re-syncing after focus loss. */
const FOCUS_OUT_RESYNC_DELAY_MS = 350;

function getActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLInputElement) {
    const nonTextInputTypes = new Set(['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
    return !nonTextInputTypes.has(element.type.toLowerCase()) && !element.readOnly && !element.disabled;
  }
  if (element instanceof HTMLTextAreaElement) {
    return !element.readOnly && !element.disabled;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }
  return false;
}

/**
 * Keeps the fixed workspace shell above the virtual keyboard in iOS Safari.
 *
 * The shell lifts its bottom edge by `--keyboard-height`, so a stale non-zero
 * value leaves a blank band where the keyboard used to be. The virtual keyboard
 * on iOS can only exist when an editable element (input, textarea, contenteditable)
 * is focused. When no editable element is focused (initial page load, reading chat,
 * after blur, or returning from background tabs/apps), any viewport shrinkage is
 * layout noise or stale geometry and must be strictly forced to 0.
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    const setKeyboardHeight = (heightPx: number) => {
      document.documentElement.style.setProperty('--keyboard-height', `${heightPx}px`);
    };

    const updateKeyboardHeight = () => {
      // If no editable element has focus, the iOS virtual keyboard cannot be open.
      // Prevent stale viewport measurements or initial load glitches from lifting the shell.
      const active = getActiveElement();
      if (!isEditableElement(active)) {
        setKeyboardHeight(0);
        return;
      }

      // The keyboard is the bottom band of the layout viewport the visual
      // viewport does not cover; offsetTop removes the page scroll iOS applies
      // while lifting a focused input so scrolling never looks like a keyboard.
      const hiddenHeight = window.innerHeight - visualViewport.offsetTop - visualViewport.height;
      const keyboardHeight = hiddenHeight >= MIN_KEYBOARD_HEIGHT_PX ? hiddenHeight : 0;
      setKeyboardHeight(keyboardHeight);
    };

    updateKeyboardHeight();

    visualViewport.addEventListener('resize', updateKeyboardHeight);
    visualViewport.addEventListener('scroll', updateKeyboardHeight);
    window.addEventListener('resize', updateKeyboardHeight);

    let focusOutTimer1: ReturnType<typeof setTimeout> | undefined;
    let focusOutTimer2: ReturnType<typeof setTimeout> | undefined;

    const clearFocusTimers = () => {
      if (focusOutTimer1 !== undefined) {
        clearTimeout(focusOutTimer1);
        focusOutTimer1 = undefined;
      }
      if (focusOutTimer2 !== undefined) {
        clearTimeout(focusOutTimer2);
        focusOutTimer2 = undefined;
      }
    };

    const handleFocusIn = () => {
      clearFocusTimers();
      updateKeyboardHeight();
    };

    const handleFocusOut = () => {
      clearFocusTimers();
      // Tick 1 (50ms): clear if focus didn't move to another editable control
      focusOutTimer1 = setTimeout(() => {
        updateKeyboardHeight();
      }, 50);

      // Tick 2 (350ms): after iOS keyboard slide-down animation settles,
      // force clear and repair any lingering window scroll
      focusOutTimer2 = setTimeout(() => {
        updateKeyboardHeight();
        if (!isEditableElement(getActiveElement()) && window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
      }, FOCUS_OUT_RESYNC_DELAY_MS);
    };

    // When returning from background (app switch, screen unlock) or BFCache restore,
    // iOS hides the virtual keyboard without a resize event. Resync immediately.
    const handleResume = () => {
      clearFocusTimers();
      updateKeyboardHeight();
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('pageshow', handleResume);

    return () => {
      clearFocusTimers();
      visualViewport.removeEventListener('resize', updateKeyboardHeight);
      visualViewport.removeEventListener('scroll', updateKeyboardHeight);
      window.removeEventListener('resize', updateKeyboardHeight);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('pageshow', handleResume);
      document.documentElement.style.removeProperty('--keyboard-height');
    };
  }, []);
}
