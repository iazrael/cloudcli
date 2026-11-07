import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsStorageCleanup from '@/modules/settings/tabs/sessions-settings/SessionsStorageCleanup';
import type * as Api from '@/shared/api';

const providers = {
  storageCleanupSettings: vi.fn(),
  updateStorageCleanupSettings: vi.fn(),
  previewStorageCleanup: vi.fn(),
  runStorageCleanup: vi.fn(),
};

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  api: { providers: new Proxy({}, { get: (_target, key: string) => providers[key as keyof typeof providers] }) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options ? `${key}:${JSON.stringify(options)}` : key
    ),
  }),
}));

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const settings = (overrides = {}) => ({ enabled: false, retentionDays: 30, purgeConversations: false, ...overrides });
const preview = { cutoff: '', sessions: 12, skipped: 1, artifactBytes: 5 * 1024 * 1024, purgeableSessions: 9, purgeBytes: 2 * 1024 * 1024 * 1024, partial: false };

const open = async (current = settings(), lastReport: unknown = null) => {
  providers.storageCleanupSettings.mockResolvedValue(ok({ settings: current, lastReport }));
  render(<SessionsStorageCleanup />);
  await screen.findByRole('switch', { name: 'sessions.storageCleanup.enableLabel' });
};

describe('SessionsStorageCleanup', () => {
  beforeEach(() => {
    Object.values(providers).forEach((mock) => mock.mockReset());
    providers.previewStorageCleanup.mockImplementation(async () => ok(preview));
    providers.updateStorageCleanupSettings.mockImplementation(async (input: object) => ok(settings(input)));
  });
  afterEach(cleanup);

  it('shows the defaults with the purge option unchecked', async () => {
    await open();
    expect(screen.getByRole('switch')).toHaveProperty('ariaChecked', 'false');
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: /"count":30/ }).className).toContain('border-primary');
  });

  it('offers exactly the supported windows', async () => {
    await open();
    expect(screen.getAllByRole('button', { name: /storageCleanup\.days/ }).map((button) => button.textContent))
      .toEqual([7, 14, 30, 60, 90].map((count) => `sessions.storageCleanup.days:{"count":${count}}`));
  });

  it('measures nothing until the feature is used', async () => {
    await open();
    expect(providers.previewStorageCleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.previewButton' }));
    expect(await screen.findByText(/previewArtifacts/)).toBeTruthy();
  });

  it('asks before shortening the window while deletion is on', async () => {
    await open(settings({ purgeConversations: true }));
    fireEvent.click(screen.getByRole('button', { name: /"count":7/ }));
    expect(providers.updateStorageCleanupSettings).not.toHaveBeenCalled();
    expect(screen.getByText('sessions.storageCleanup.widenConfirmBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.purgeConfirmButton' }));
    await waitFor(() => expect(providers.updateStorageCleanupSettings)
      .toHaveBeenCalledWith({ retentionDays: 7, confirmPurge: true }));
  });

  it('asks before enabling while deletion is on, but not before lengthening the window', async () => {
    await open(settings({ purgeConversations: true }));
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByText('sessions.storageCleanup.widenConfirmBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /"count":60/ }));
    await waitFor(() => expect(providers.updateStorageCleanupSettings).toHaveBeenCalledWith({ retentionDays: 60 }));
  });

  it('saves a new retention window and refreshes the preview', async () => {
    await open(settings({ enabled: true }));
    await waitFor(() => expect(providers.previewStorageCleanup).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /"count":7/ }));
    await waitFor(() => expect(providers.updateStorageCleanupSettings).toHaveBeenCalledWith({ retentionDays: 7 }));
    await waitFor(() => expect(providers.previewStorageCleanup).toHaveBeenCalledTimes(2));
  });

  it('shows the preview for both modes', async () => {
    await open(settings({ enabled: true }));
    expect(await screen.findByText(/previewArtifacts.*"count":12.*5\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/previewPurge.*"count":9.*2\.0 GB/)).toBeTruthy();
  });

  it('says so when a preview is partial', async () => {
    providers.previewStorageCleanup.mockImplementation(async () => ok({ ...preview, partial: true }));
    await open(settings({ enabled: true }));
    expect(await screen.findByText('sessions.storageCleanup.previewPartial')).toBeTruthy();
  });

  it('checking purge asks first and saves nothing until confirmed', async () => {
    await open();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText(/purgeConfirmBody.*"count":9/)).toBeTruthy();
    expect(providers.updateStorageCleanupSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);

    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.purgeConfirmButton' }));
    await waitFor(() => expect(providers.updateStorageCleanupSettings)
      .toHaveBeenCalledWith({ purgeConversations: true, confirmPurge: true }));
    await waitFor(() => expect(screen.getByRole('checkbox')).toHaveProperty('checked', true));
  });

  it('cancelling leaves purge off', async () => {
    await open();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.cancel' }));
    expect(providers.updateStorageCleanupSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(/purgeConfirmBody/)).toBeNull();
  });

  it('unchecking purge needs no confirmation', async () => {
    await open(settings({ purgeConversations: true }));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(providers.updateStorageCleanupSettings)
      .toHaveBeenCalledWith({ purgeConversations: false }));
  });

  it('runs right away in the default mode', async () => {
    providers.runStorageCleanup.mockImplementation(async () => ok({ ranAt: '2026-11-07T00:00:00.000Z', bytesFreed: 1024, sessionsCleaned: 2, sessionsDeleted: 0, skipped: 0, failed: 0 }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.runButton' }));
    await waitFor(() => expect(providers.runStorageCleanup).toHaveBeenCalledWith({ confirmPurge: false }));
    expect(await screen.findByText(/lastRun.*"cleaned":2/)).toBeTruthy();
  });

  it('asks before a run that deletes conversations', async () => {
    providers.runStorageCleanup.mockImplementation(async () => ok({ ranAt: '2026-11-07T00:00:00.000Z', bytesFreed: 0, sessionsCleaned: 0, sessionsDeleted: 9, skipped: 0, failed: 0 }));
    await open(settings({ purgeConversations: true }));
    await screen.findByText(/previewPurge/);
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.runButton' }));
    expect(providers.runStorageCleanup).not.toHaveBeenCalled();
    expect(screen.getByText(/runConfirmBody.*"count":9/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.purgeConfirmButton' }));
    await waitFor(() => expect(providers.runStorageCleanup).toHaveBeenCalledWith({ confirmPurge: true }));
  });

  it('caps the run count it warns about at one batch', async () => {
    providers.previewStorageCleanup.mockImplementation(async () => ok({ ...preview, purgeableSessions: 650 }));
    await open(settings({ purgeConversations: true }));
    await screen.findByText(/previewPurge/);
    fireEvent.click(screen.getByRole('button', { name: 'sessions.storageCleanup.runButton' }));
    expect(screen.getByText(/runConfirmBody.*"count":200/)).toBeTruthy();
  });

  it('shows the last report', async () => {
    await open(settings(), { ranAt: '2026-11-07T00:00:00.000Z', bytesFreed: 2048, sessionsCleaned: 3, sessionsDeleted: 1, skipped: 2, failed: 0, errors: [] });
    expect(screen.getByText(/lastRun.*2\.0 KB.*"cleaned":3.*"deleted":1/)).toBeTruthy();
  });

  it('shows a failed save and keeps the old value', async () => {
    providers.updateStorageCleanupSettings.mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'nope' } }), { status: 400 }));
    await open();
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('nope')).toBeTruthy();
    expect(screen.getByRole('switch')).toHaveProperty('ariaChecked', 'false');
  });
});
