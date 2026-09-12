import assert from 'node:assert/strict';
import React, { createRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, it } from 'vitest';

import CodeEditorImageViewer, {
  MAX_SCALE,
  MIN_SCALE,
  type ImageViewerHandle,
} from '@/modules/code-editor/CodeEditorImageViewer';

describe('CodeEditorImageViewer', () => {
  it('renders image and handles zoom controls via ref', () => {
    const viewerRef = createRef<ImageViewerHandle | null>();
    let currentScale = 1;

    const { container } = render(
      <CodeEditorImageViewer
        src="blob:http://localhost/test-image.png"
        alt="test-image.png"
        viewerRef={viewerRef as React.MutableRefObject<ImageViewerHandle | null>}
        onScaleChange={(s) => {
          currentScale = s;
        }}
      />,
    );

    const img = container.querySelector('img');
    assert.ok(img, 'Image element should exist');
    assert.equal(img?.getAttribute('src'), 'blob:http://localhost/test-image.png');
    assert.equal(img?.getAttribute('alt'), 'test-image.png');

    // Initial scale
    assert.equal(viewerRef.current?.scale, 1);
    assert.equal(currentScale, 1);

    // Zoom in
    act(() => {
      viewerRef.current?.zoomIn();
    });
    assert.equal(viewerRef.current?.scale, 1.25);
    assert.equal(currentScale, 1.25);

    // Zoom out
    act(() => {
      viewerRef.current?.zoomOut();
    });
    assert.equal(viewerRef.current?.scale, 1);
    assert.equal(currentScale, 1);

    // Reset zoom
    act(() => {
      viewerRef.current?.zoomIn();
      viewerRef.current?.zoomIn();
      viewerRef.current?.resetZoom();
    });
    assert.equal(viewerRef.current?.scale, 1);
    assert.equal(currentScale, 1);
  });

  it('handles desktop double click to zoom in and reset', () => {
    const viewerRef = createRef<ImageViewerHandle | null>();
    const { container } = render(
      <CodeEditorImageViewer
        src="blob:http://localhost/test.png"
        alt="test.png"
        viewerRef={viewerRef as React.MutableRefObject<ImageViewerHandle | null>}
      />,
    );

    const region = container.querySelector('[role="region"]');
    assert.ok(region);

    // First double click zooms to 2.5x
    act(() => {
      fireEvent.doubleClick(region, { clientX: 200, clientY: 200 });
    });
    assert.equal(viewerRef.current?.scale, 2.5);

    // Second double click resets to 1x
    act(() => {
      fireEvent.doubleClick(region, { clientX: 200, clientY: 200 });
    });
    assert.equal(viewerRef.current?.scale, 1);

    // Zoom out below 1x, then double click should reset back to 1x
    act(() => {
      viewerRef.current?.zoomOut();
      viewerRef.current?.zoomOut();
    });
    assert.ok((viewerRef.current?.scale ?? 1) < 1);
    act(() => {
      fireEvent.doubleClick(region, { clientX: 200, clientY: 200 });
    });
    assert.equal(viewerRef.current?.scale, 1);
  });

  it('handles mouse wheel zooming with damping and clamps to bounds', () => {
    const viewerRef = createRef<ImageViewerHandle | null>();
    const { container } = render(
      <CodeEditorImageViewer
        src="blob:http://localhost/test.png"
        alt="test.png"
        viewerRef={viewerRef as React.MutableRefObject<ImageViewerHandle | null>}
      />,
    );

    const region = container.querySelector('[role="region"]');
    assert.ok(region);

    // Wheel up zooms in
    act(() => {
      fireEvent.wheel(region, { deltaY: -100, clientX: 150, clientY: 150 });
    });
    assert.ok((viewerRef.current?.scale ?? 1) > 1, 'Scale should increase on wheel up');

    // Repeated zoom in does not exceed MAX_SCALE
    act(() => {
      for (let i = 0; i < 40; i++) {
        viewerRef.current?.zoomIn();
      }
    });
    assert.equal(viewerRef.current?.scale, MAX_SCALE);

    // Repeated zoom out does not drop below MIN_SCALE
    act(() => {
      for (let i = 0; i < 40; i++) {
        viewerRef.current?.zoomOut();
      }
    });
    assert.equal(viewerRef.current?.scale, MIN_SCALE);
  });

  it('handles mobile touch double-tap with distance tolerance', () => {
    const viewerRef = createRef<ImageViewerHandle | null>();
    const { container } = render(
      <CodeEditorImageViewer
        src="blob:http://localhost/test.png"
        alt="test.png"
        viewerRef={viewerRef as React.MutableRefObject<ImageViewerHandle | null>}
      />,
    );

    const region = container.querySelector('[role="region"]');
    assert.ok(region);

    // Far taps (>25px) should not trigger double-tap zoom
    act(() => {
      fireEvent.touchStart(region, { touches: [{ clientX: 50, clientY: 50 }] });
      fireEvent.touchEnd(region);
      fireEvent.touchStart(region, { touches: [{ clientX: 120, clientY: 120 }] });
      fireEvent.touchEnd(region);
    });
    assert.equal(viewerRef.current?.scale, 1);

    // Close taps (<25px within 300ms) trigger double-tap zoom
    act(() => {
      fireEvent.touchStart(region, { touches: [{ clientX: 100, clientY: 100 }] });
      fireEvent.touchEnd(region);
      fireEvent.touchStart(region, { touches: [{ clientX: 105, clientY: 105 }] });
      fireEvent.touchEnd(region);
    });
    assert.equal(viewerRef.current?.scale, 2.5);
  });
});
