import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/shared/context/ThemeContext';
import MermaidDiagram from '@/modules/code-editor/markdown/MermaidDiagram';

// MermaidDiagram rewrites the emitted root tag for the viewer data URL, so the
// fixture keeps mermaid's real shape: relative width plus a max-width style.
const TEST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 800 400" style="max-width: 800px;"><g><rect width="100" height="50" /></g></svg>';

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaidMock }));

// restoreMocks wipes per-test stubs, so the render promise is re-armed here.
beforeEach(() => {
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset().mockResolvedValue({ svg: TEST_SVG });
});

const renderDiagram = () =>
  render(
    <ThemeProvider>
      <MermaidDiagram code="flowchart TD; A --> B" />
    </ThemeProvider>,
  );

describe('MermaidDiagram tap-to-zoom', () => {
  it('opens the fullscreen viewer with an explicit-size svg data URL', async () => {
    renderDiagram();
    fireEvent.click(await screen.findByRole('button', { name: 'common:imageViewer.expandDiagram' }));
    const dialog = screen.getByRole('dialog');
    const img = dialog.querySelector('img');
    expect(img).toBeTruthy();
    const [, payload] = (img as HTMLImageElement).src.split(',');
    // The viewBox size becomes explicit width/height so the viewer's 100% zoom
    // is the diagram's native size; the fitting max-width style is gone.
    const decoded = decodeURIComponent(payload);
    expect(decoded).toContain('width="800"');
    expect(decoded).toContain('height="400"');
    expect(decoded).not.toContain('max-width');
  });

  it('closes the viewer and keeps the inline diagram', async () => {
    renderDiagram();
    fireEvent.click(await screen.findByRole('button', { name: 'common:imageViewer.expandDiagram' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'common:imageViewer.expandDiagram' })).toBeTruthy();
  });
});
