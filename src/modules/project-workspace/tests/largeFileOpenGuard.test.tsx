import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';

/**
 * Regression guard for chat-opened files: a path from a chat message carries no
 * size, so the open action probes the server first and asks before loading a
 * document that would stall the editor.
 */

const fileStat = vi.fn();
const readFileBlob = vi.fn();
const readExternalFileContent = vi.fn();
const saveOrShareBlob = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    fileStat: (...args: unknown[]) => fileStat(...args),
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
  readExternalFileContent: (...args: unknown[]) => readExternalFileContent(...args),
}));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedUtils>();
  return { ...actual, saveOrShareBlob: (...args: unknown[]) => saveOrShareBlob(...args) };
});

const { useLargeFileOpenGuard } = await import('@/modules/project-workspace/hooks/useLargeFileOpenGuard');

const ROOT = '/proj';
const project: Project = { projectId: 'p1', displayName: 'proj', fullPath: ROOT, path: ROOT };

const okStat = (size: number) => ({ ok: true, json: async () => ({ size }) });
const okBlob = () => ({ ok: true, blob: async () => new Blob(['bytes']) });

function Harness({ project: harnessProject, onOpen }: { project: Project | null; onOpen: (filePath: string, diffInfo?: unknown, line?: number | null) => boolean }) {
  const { openWithGuard, guardDialog } = useLargeFileOpenGuard(harnessProject, onOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => void openWithGuard(`${ROOT}/builds/report.html`)}
      >
        open relative
      </button>
      <button
        type="button"
        onClick={() => void openWithGuard('/tmp/agent-run/report.html')}
      >
        open external
      </button>
      <button
        type="button"
        onClick={() => void openWithGuard(`${ROOT}/diff.ts`, { new_string: 'a', old_string: 'b' })}
      >
        open diff
      </button>
      {guardDialog}
    </>
  );
}

beforeEach(() => {
  fileStat.mockReset();
  readFileBlob.mockReset();
  readExternalFileContent.mockReset();
  saveOrShareBlob.mockReset();
  saveOrShareBlob.mockResolvedValue(undefined);
});

test('a file below the threshold opens without asking', async () => {
  fileStat.mockResolvedValue(okStat(5000));
  const onOpen = vi.fn(() => true);
  render(<Harness project={project} onOpen={onOpen} />);

  fireEvent.click(screen.getByText('open relative'));

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/builds/report.html`, undefined, null));
  expect(screen.queryByText(/Download instead/i)).toBeNull();
});

test('a large file asks first and opens on confirmation', async () => {
  fileStat.mockResolvedValue(okStat(21 * 1024 * 1024));
  const onOpen = vi.fn(() => true);
  render(<Harness project={project} onOpen={onOpen} />);

  fireEvent.click(screen.getByText('open relative'));
  await waitFor(() => expect(screen.getByText(/Download instead/i)).toBeTruthy());
  expect(onOpen).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /Open anyway/i }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/builds/report.html`, undefined, null));
  expect(screen.queryByText(/Download instead/i)).toBeNull();
});

test('the dialog can download a project file instead of opening it', async () => {
  fileStat.mockResolvedValue(okStat(21 * 1024 * 1024));
  readFileBlob.mockResolvedValue(okBlob());
  const onOpen = vi.fn(() => true);
  render(<Harness project={project} onOpen={onOpen} />);

  fireEvent.click(screen.getByText('open relative'));
  await waitFor(() => expect(screen.getByText(/Download instead/i)).toBeTruthy());

  fireEvent.click(screen.getByRole('button', { name: /Download instead/i }));
  await waitFor(() => expect(saveOrShareBlob).toHaveBeenCalledTimes(1));
  assert.equal(saveOrShareBlob.mock.calls[0][1], 'report.html');
  expect(readFileBlob).toHaveBeenCalledWith('p1', `${ROOT}/builds/report.html`);
  expect(onOpen).not.toHaveBeenCalled();
});

test('an external absolute path downloads through the read-only stream', async () => {
  fileStat.mockResolvedValue(okStat(21 * 1024 * 1024));
  readExternalFileContent.mockResolvedValue(okBlob());
  const onOpen = vi.fn(() => true);
  render(<Harness project={project} onOpen={onOpen} />);

  fireEvent.click(screen.getByText('open external'));
  await waitFor(() => expect(screen.getByText(/Download instead/i)).toBeTruthy());

  fireEvent.click(screen.getByRole('button', { name: /Download instead/i }));
  await waitFor(() => expect(saveOrShareBlob).toHaveBeenCalledTimes(1));
  expect(readExternalFileContent).toHaveBeenCalledWith('/tmp/agent-run/report.html', undefined, 'p1');
  expect(readFileBlob).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

test('a failed stat opens the file as before instead of blocking it', async () => {
  fileStat.mockResolvedValue({ ok: false, status: 404 });
  const onOpen = vi.fn(() => true);
  render(<Harness project={project} onOpen={onOpen} />);

  fireEvent.click(screen.getByText('open relative'));

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/builds/report.html`, undefined, null));
  expect(screen.queryByText(/Download instead/i)).toBeNull();
});

test('a diff payload skips the probe because it never reads the file', async () => {
  const onOpen = vi.fn(() => true);
  render(<Harness project={project} onOpen={onOpen} />);

  fireEvent.click(screen.getByText('open diff'));

  await waitFor(() => expect(onOpen).toHaveBeenCalled());
  expect(fileStat).not.toHaveBeenCalled();
});
