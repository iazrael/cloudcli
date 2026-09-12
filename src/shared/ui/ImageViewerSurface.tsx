import { useCallback, useEffect, useRef, useState } from 'react';

type Position = {
  x: number;
  y: number;
};

export type ImageViewerHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  scale: number;
};

type ImageViewerSurfaceProps = {
  src: string;
  alt: string;
  onScaleChange?: (scale: number) => void;
  viewerRef?: React.MutableRefObject<ImageViewerHandle | null>;
};

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 10;
const BUTTON_ZOOM_FACTOR = 1.25;
const WHEEL_DAMPING = 0.003;

/** Used across chat, code-editor, and file-tree to display images with pan, wheel zoom, and mobile touch pinch gestures. */
export function ImageViewerSurface({
  src,
  alt,
  onScaleChange,
  viewerRef,
}: ImageViewerSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  /** Current zoom scale multiplier ranging between MIN_SCALE and MAX_SCALE. */
  const [scale, setScale] = useState<number>(1);

  /** Current 2D translation offset in pixels from the center of the container. */
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });

  /** Tracks active mouse dragging state to update cursor style and capture events. */
  const [isDragging, setIsDragging] = useState<boolean>(false);

  /** Tracks whether user is currently panning or pinching; disables CSS transitions for 0-latency tracking. */
  const [isInteracting, setIsInteracting] = useState<boolean>(false);

  // References for drag and pinch state tracking without re-triggering renders
  const dragStartRef = useRef<{ clientX: number; clientY: number; posX: number; posY: number } | null>(null);
  const touchStateRef = useRef<{
    initialDistance: number;
    initialScale: number;
    initialCenter: Position;
    initialPos: Position;
    lastTapTime: number;
    lastTapPos: Position;
  }>({
    initialDistance: 0,
    initialScale: 1,
    initialCenter: { x: 0, y: 0 },
    initialPos: { x: 0, y: 0 },
    lastTapTime: 0,
    lastTapPos: { x: 0, y: 0 },
  });

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const positionRef = useRef(position);
  positionRef.current = position;

  // Clamps translation so image cannot be dragged completely outside container
  const clampPosition = useCallback((pos: Position, targetScale: number): Position => {
    if (targetScale <= 1) {
      return { x: 0, y: 0 };
    }
    const container = containerRef.current;
    if (!container) return pos;

    const { clientWidth, clientHeight } = container;
    // Allow panning within bounds proportional to the scaled dimension
    const maxBoundX = Math.max(0, (clientWidth * (targetScale - 0.2)) / 2);
    const maxBoundY = Math.max(0, (clientHeight * (targetScale - 0.2)) / 2);

    return {
      x: Math.max(-maxBoundX, Math.min(maxBoundX, pos.x)),
      y: Math.max(-maxBoundY, Math.min(maxBoundY, pos.y)),
    };
  }, []);

  const updateScale = useCallback((newScale: number, targetCenter?: Position) => {
    const clampedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    const currentScale = scaleRef.current;
    const currentPos = positionRef.current;

    if (clampedScale === currentScale) return;

    if (clampedScale <= 1 && !targetCenter) {
      scaleRef.current = clampedScale;
      positionRef.current = { x: 0, y: 0 };
      setScale(clampedScale);
      setPosition({ x: 0, y: 0 });
      onScaleChange?.(clampedScale);
      return;
    }

    let nextPos: Position;
    if (targetCenter && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const cx = targetCenter.x - rect.left - rect.width / 2;
      const cy = targetCenter.y - rect.top - rect.height / 2;

      // Keep the point under cursor fixed:
      // (cx - newPos) / newScale = (cx - oldPos) / oldScale
      const ratio = clampedScale / currentScale;
      nextPos = {
        x: cx - (cx - currentPos.x) * ratio,
        y: cy - (cy - currentPos.y) * ratio,
      };
    } else {
      // Zoom relative to current viewport center
      const ratio = clampedScale / currentScale;
      nextPos = {
        x: currentPos.x * ratio,
        y: currentPos.y * ratio,
      };
    }

    const boundedPos = clampPosition(nextPos, clampedScale);
    scaleRef.current = clampedScale;
    positionRef.current = boundedPos;
    setScale(clampedScale);
    setPosition(boundedPos);
    onScaleChange?.(clampedScale);
  }, [onScaleChange, clampPosition]);

  const zoomIn = useCallback(() => {
    setIsInteracting(false);
    updateScale(scaleRef.current * BUTTON_ZOOM_FACTOR);
  }, [updateScale]);

  const zoomOut = useCallback(() => {
    setIsInteracting(false);
    updateScale(scaleRef.current / BUTTON_ZOOM_FACTOR);
  }, [updateScale]);

  const resetZoom = useCallback(() => {
    setIsInteracting(false);
    scaleRef.current = 1;
    positionRef.current = { x: 0, y: 0 };
    setScale(1);
    setPosition({ x: 0, y: 0 });
    onScaleChange?.(1);
  }, [onScaleChange]);

  // Expose handles via viewerRef
  useEffect(() => {
    if (viewerRef) {
      viewerRef.current = {
        zoomIn,
        zoomOut,
        resetZoom,
        scale,
      };
    }
  }, [viewerRef, zoomIn, zoomOut, resetZoom, scale]);

  // Reset when image source changes
  useEffect(() => {
    setIsInteracting(false);
    scaleRef.current = 1;
    positionRef.current = { x: 0, y: 0 };
    setScale(1);
    setPosition({ x: 0, y: 0 });
    onScaleChange?.(1);
  }, [src, onScaleChange]);

  // Smooth exponential wheel zoom with cursor focal point
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setIsInteracting(false);
      const clampedDelta = Math.max(-120, Math.min(120, e.deltaY));
      const factor = Math.exp(-clampedDelta * WHEEL_DAMPING);
      updateScale(scaleRef.current * factor, { x: e.clientX, y: e.clientY });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [updateScale]);

  // Pointer events with pointer capture for robust mouse dragging across boundaries
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;

    if (scaleRef.current > 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStartRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        posX: positionRef.current.x,
        posY: positionRef.current.y,
      };
      setIsDragging(true);
      setIsInteracting(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.clientX;
    const dy = e.clientY - dragStartRef.current.clientY;
    const newPos = {
      x: dragStartRef.current.posX + dx,
      y: dragStartRef.current.posY + dy,
    };
    setPosition(clampPosition(newPos, scaleRef.current));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && dragStartRef.current) {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Safe fallback
      }
      dragStartRef.current = null;
      setIsDragging(false);
      setIsInteracting(false);
    }
  };

  // Double click on desktop
  const handleDoubleClick = (e: React.MouseEvent) => {
    setIsInteracting(false);
    // If zoomed in or out away from default 1x, double click resets to 1x fit
    if (Math.abs(scale - 1) > 0.05) {
      resetZoom();
    } else {
      updateScale(2.5, { x: e.clientX, y: e.clientY });
    }
  };

  // Touch handlers for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const now = Date.now();
      const lastPos = touchStateRef.current.lastTapPos;
      const dist = Math.hypot(touch.clientX - lastPos.x, touch.clientY - lastPos.y);
      const isDoubleTap = now - touchStateRef.current.lastTapTime < 300 && dist < 25;

      touchStateRef.current.lastTapPos = { x: touch.clientX, y: touch.clientY };

      if (isDoubleTap) {
        touchStateRef.current.lastTapTime = 0;
        setIsInteracting(false);
        // If zoomed in or out away from default 1x, double tap resets to 1x fit
        if (Math.abs(scaleRef.current - 1) > 0.05) {
          resetZoom();
        } else {
          updateScale(2.5, { x: touch.clientX, y: touch.clientY });
        }
        dragStartRef.current = null;
        return;
      }

      touchStateRef.current.lastTapTime = now;

      if (scaleRef.current > 1) {
        dragStartRef.current = {
          clientX: touch.clientX,
          clientY: touch.clientY,
          posX: positionRef.current.x,
          posY: positionRef.current.y,
        };
        setIsDragging(true);
        setIsInteracting(true);
      }
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      touchStateRef.current = {
        ...touchStateRef.current,
        initialDistance: distance,
        initialScale: scaleRef.current,
        initialCenter: {
          x: (t1.clientX + t2.clientX) / 2,
          y: (t1.clientY + t2.clientY) / 2,
        },
        initialPos: { ...positionRef.current },
      };
      dragStartRef.current = null;
      setIsDragging(false);
      setIsInteracting(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && dragStartRef.current) {
      const touch = e.touches[0];
      const dx = touch.clientX - dragStartRef.current.clientX;
      const dy = touch.clientY - dragStartRef.current.clientY;
      const newPos = {
        x: dragStartRef.current.posX + dx,
        y: dragStartRef.current.posY + dy,
      };
      setPosition(clampPosition(newPos, scaleRef.current));
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const { initialDistance, initialScale, initialCenter } = touchStateRef.current;

      if (initialDistance > 0) {
        const factor = currentDistance / initialDistance;
        const newScale = initialScale * factor;
        updateScale(newScale, initialCenter);
      }
    }
  };

  const handleTouchEnd = () => {
    dragStartRef.current = null;
    setIsDragging(false);
    setIsInteracting(false);
    touchStateRef.current.initialDistance = 0;
  };

  const cursorClass = isDragging
    ? 'cursor-grabbing'
    : scale > 1
      ? 'cursor-grab'
      : 'cursor-zoom-in';

  const transformTransitionClass = isInteracting
    ? 'transition-none'
    : 'transition-transform duration-200 ease-out';

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={alt}
      tabIndex={0}
      className={`relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden ${cursorClass}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        className={`flex max-h-full max-w-full items-center justify-center will-change-transform ${transformTransitionClass}`}
        style={{
          transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none max-h-full max-w-full select-none object-contain drop-shadow-sm"
        />
      </div>
    </div>
  );
}
