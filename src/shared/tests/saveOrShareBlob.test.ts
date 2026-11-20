import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

// saveOrShareBlob is imported after the globals it reads are staged in
// beforeEach, but the module reads them at call time, so a plain import is fine.
const { saveOrShareBlob } = await import('@/shared/utils');

const flushTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const setTouchPoints = (count: number) => {
  Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: count });
};

describe('saveOrShareBlob', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let share: ReturnType<typeof vi.fn>;
  let anchorClick: MockInstance<() => void>;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    share = vi.fn();
    Object.defineProperty(window.navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(window.navigator, 'share', { configurable: true, value: share });
    // jsdom's click would try to navigate; the download hand-off only needs the
    // click itself to be observed.
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    setTouchPoints(0);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    anchorClick.mockRestore();
    vi.restoreAllMocks();
  });

  it('downloads through the link on a desktop even when file sharing is available', async () => {
    await saveOrShareBlob(new Blob(['data']), 'report.txt');

    expect(share).not.toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalledTimes(1);
  });

  it('revokes the object URL only after the download hand-off settles, not in the same task', async () => {
    await saveOrShareBlob(new Blob(['data']), 'report.txt');

    expect(revokeObjectURL).not.toHaveBeenCalled();
    await flushTask();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('hands the file to the share sheet on a touch device', async () => {
    setTouchPoints(1);
    share.mockResolvedValue(undefined);

    await saveOrShareBlob(new Blob(['data']), 'report.txt');

    expect(share).toHaveBeenCalledTimes(1);
    const shared = share.mock.calls[0][0] as { files: File[] };
    expect(shared.files[0].name).toBe('report.txt');
    expect(anchorClick).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back to the download link when sharing fails on a touch device', async () => {
    setTouchPoints(1);
    share.mockRejectedValue(new TypeError('stale activation'));

    await saveOrShareBlob(new Blob(['data']), 'report.txt');

    expect(anchorClick).toHaveBeenCalledTimes(1);
    await flushTask();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('treats a dismissed share sheet as done, with no download', async () => {
    setTouchPoints(1);
    share.mockRejectedValue(new DOMException('user cancelled', 'AbortError'));

    await saveOrShareBlob(new Blob(['data']), 'report.txt');

    expect(anchorClick).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    await flushTask();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
