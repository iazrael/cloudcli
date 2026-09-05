import * as React from 'react';

import { cn } from '@/shared/utils';

type CollapsibleContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True while rendering as native <details>/<summary>, where the browser owns the collapse. */
  native: boolean;
};

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

export function useCollapsible() {
  const ctx = React.useContext(CollapsibleContext);
  if (!ctx) throw new Error('Collapsible components must be used within <Collapsible>');
  return ctx;
}

type CollapsibleProps = {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Render as a native <details>/<summary> pair, whose collapse keeps working
   * without JavaScript — the requirement of a statically rendered document
   * such as the exported transcript. The trigger renders as <summary>, content
   * stays in the DOM (the browser hides it while closed).
   */
  nativeDetails?: boolean;
} & React.HTMLAttributes<HTMLDivElement>;

/** Used by the chat module for collapsible tool output and by the shared Reasoning primitive. */
export const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(
  ({ defaultOpen = false, open: controlledOpen, onOpenChange: controlledOnOpenChange, nativeDetails = false, className, children, ...props }, ref) => {
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : internalOpen;
    const onOpenChange = React.useCallback(
      (next: boolean) => {
        if (!isControlled) setInternalOpen(next);
        controlledOnOpenChange?.(next);
      },
      [isControlled, controlledOnOpenChange]
    );

    const value = React.useMemo(
      () => ({ open, onOpenChange, native: nativeDetails }),
      [open, onOpenChange, nativeDetails]
    );

    if (nativeDetails) {
      return (
        <CollapsibleContext.Provider value={value}>
          {/* The public props are div-typed (the interactive variant); details
              accepts the same attributes, the handlers just narrow their event. */}
          <details open={open} className={className} {...(props as React.HTMLAttributes<HTMLDetailsElement>)}>
            {children}
          </details>
        </CollapsibleContext.Provider>
      );
    }

    return (
      <CollapsibleContext.Provider value={value}>
        <div ref={ref} data-state={open ? 'open' : 'closed'} className={className} {...props}>
          {children}
        </div>
      </CollapsibleContext.Provider>
    );
  }
);
Collapsible.displayName = 'Collapsible';

/** Toggle slot of Collapsible, used by the chat module and the shared Reasoning primitive. */
export const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ onClick, children, className, ...props }, ref) => {
    const { open, onOpenChange, native } = useCollapsible();

    const handleClick = React.useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        onOpenChange(!open);
        onClick?.(e);
      },
      [open, onOpenChange, onClick]
    );

    // <summary> toggles its parent <details> natively; no click handling needed.
    if (native) {
      return (
        <summary className={className} {...props}>
          {children}
        </summary>
      );
    }

    return (
      <button
        ref={ref}
        type="button"
        aria-expanded={open}
        data-state={open ? 'open' : 'closed'}
        onClick={handleClick}
        className={className}
        {...props}
      >
        {children}
      </button>
    );
  }
);
CollapsibleTrigger.displayName = 'CollapsibleTrigger';

/** Body slot of Collapsible, used by the chat module and the shared Reasoning primitive. */
export const CollapsibleContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const { open, native } = useCollapsible();

    // The enclosing <details> owns visibility, so this is a plain wrapper —
    // no animation grid, which would fight the native fold.
    if (native) {
      return (
        <div className={className} {...props}>
          {children}
        </div>
      );
    }

    return (
      <div
        ref={ref}
        data-state={open ? 'open' : 'closed'}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          className
        )}
        {...props}
      >
        <div className="overflow-hidden">
          {children}
        </div>
      </div>
    );
  }
);
CollapsibleContent.displayName = 'CollapsibleContent';

