import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type * as sharedUtils from '@/shared/utils';
import type { CodeEditorFile } from '@/shared/types';
import CodeEditorBinaryFile from '@/modules/code-editor/CodeEditorBinaryFile';

const { readFileBlob, readExternalFileContent, saveOrShareBlob } = vi.hoisted(() => ({
  readFileBlob: vi.fn(),
  readExternalFileContent: vi.fn(),
  saveOrShareBlob: vi.fn(),
}));

vi.mock('@/shared/api', async (original) => {
  const actual = await original<typeof sharedApi>();
  return { ...actual, readExternalFileContent, api: { ...actual.api, readFileBlob } };
});
vi.mock('@/shared/utils', async (original) => ({
  ...await original<typeof sharedUtils>(),
  saveOrShareBlob,
}));

beforeEach(() => {
  readFileBlob.mockReset();
  readExternalFileContent.mockReset();
  saveOrShareBlob.mockReset();
});

const externalFile: CodeEditorFile = {
  name: 'package.zip',
  path: '/Users/demo/Downloads/package.zip',
  isReadOnlyExternal: true,
};
const projectFile: CodeEditorFile = {
  name: 'release.zip',
  path: '/repo/dist/release.zip',
  projectId: 'project-1',
};

function renderBinaryView(file: CodeEditorFile) {
  return render(
    <CodeEditorBinaryFile
      file={file}
      isSidebar={false}
      isFullscreen={false}
      onClose={() => undefined}
      onToggleFullscreen={() => undefined}
      title="Binary File"
      message="cannot be displayed"
      downloadLabel="Download"
      downloadFailedLabel="Download failed"
    />,
  );
}

describe('CodeEditorBinaryFile download', () => {
  it('streams a workspace-external binary through the external content endpoint', async () => {
    const blob = new Blob(['zip-bytes']);
    readExternalFileContent.mockResolvedValue({ ok: true, blob: async () => blob });

    renderBinaryView(externalFile);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(saveOrShareBlob).toHaveBeenCalledTimes(1);
    });
    expect(readExternalFileContent).toHaveBeenCalledWith(externalFile.path, {}, undefined);
    expect(saveOrShareBlob).toHaveBeenCalledWith(blob, externalFile.name);
    expect(readFileBlob).not.toHaveBeenCalled();
    expect(screen.queryByText('Download failed')).toBeNull();
  });

  it('forwards the project id with an external binary when the session has one', async () => {
    // 真实流里外部文件几乎总带 projectId（编辑器侧栏一律附带），保持外部端点语义。
    const blob = new Blob(['zip-bytes']);
    readExternalFileContent.mockResolvedValue({ ok: true, blob: async () => blob });

    renderBinaryView({ ...externalFile, projectId: 'project-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(saveOrShareBlob).toHaveBeenCalledTimes(1);
    });
    expect(readExternalFileContent).toHaveBeenCalledWith(externalFile.path, {}, 'project-1');
    expect(readFileBlob).not.toHaveBeenCalled();
  });

  it('downloads a project binary through the project byte endpoint', async () => {
    const blob = new Blob(['zip-bytes']);
    readFileBlob.mockResolvedValue({ ok: true, blob: async () => blob });

    renderBinaryView(projectFile);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(saveOrShareBlob).toHaveBeenCalledTimes(1);
    });
    expect(readFileBlob).toHaveBeenCalledWith(projectFile.projectId, projectFile.path);
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });

  it('shows the failure label and saves nothing when the endpoint refuses', async () => {
    readExternalFileContent.mockResolvedValue({ ok: false, status: 403, blob: async () => new Blob() });

    renderBinaryView(externalFile);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(screen.getByText('Download failed')).toBeTruthy();
    });
    expect(saveOrShareBlob).not.toHaveBeenCalled();
  });

  it('disables the button while a download is in flight', async () => {
    let resolveFetch: (response: { ok: boolean; blob: () => Promise<Blob> }) => void = () => undefined;
    readExternalFileContent.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

    renderBinaryView(externalFile);
    const button = screen.getByRole('button', { name: 'Download' });
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    resolveFetch({ ok: true, blob: async () => new Blob(['zip-bytes']) });
    await waitFor(() => {
      expect(saveOrShareBlob).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('reports the failure label when a project file carries no project id', async () => {
    renderBinaryView({ name: 'orphan.zip', path: '/repo/dist/orphan.zip' });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(screen.getByText('Download failed')).toBeTruthy();
    });
    expect(readFileBlob).not.toHaveBeenCalled();
    expect(saveOrShareBlob).not.toHaveBeenCalled();
  });
});

describe('CodeEditorBinaryFile render', () => {
  it('keeps the title, message and close affordance for a binary file', () => {
    renderBinaryView(externalFile);
    assert.ok(screen.getByText('Binary File'));
    assert.ok(screen.getByText('cannot be displayed'));
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });
});
