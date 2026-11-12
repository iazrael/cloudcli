import { createRef } from 'react';
import type { ComponentProps } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { createAttachmentUploadQueue } from '@/modules/chat/utils/attachmentUploadQueue';
import type { ComposerAttachmentBlock } from '@/shared/types';

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

type Props = ComponentProps<typeof ChatComposer>;

const noop = () => undefined;

const renderComposer = (overrides: Partial<Props> & { attachmentBlock?: ComposerAttachmentBlock }) => {
  const queue = createAttachmentUploadQueue(() => new Promise(noop));
  const props = {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null,
    isLoading: false,
    canAbortSession: false,
    onAbortSession: noop,
    onAbortBackgroundTasks: noop,
    permissionMode: 'default',
    availablePermissionModes: ['default'],
    onSelectPermissionMode: noop,
    provider: 'claude',
    providerLabel: 'Claude',
    effort: 'default',
    availableEffortOptions: [],
    onSelectEffort: noop,
    model: 'test',
    availableModelOptions: [],
    onSelectModel: noop,
    modelsLoading: false,
    modelsError: false,
    onReloadModels: noop,
    tokenBudget: null,
    onShowTokenUsage: noop,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    hasInput: true,
    onClearInput: noop,
    onSubmit: noop,
    isSubmitting: false,
    isDragActive: false,
    queuedDraft: null,
    onEditQueuedDraft: noop,
    isEditingSentMessage: false,
    onCancelEditMessage: noop,
    scheduledMessages: [],
    scheduledJobs: [],
    scheduledJobsEnabled: false,
    onScheduleMessage: noop,
    onCancelScheduledMessage: noop,
    onDeleteQueuedDraft: noop,
    attachments: [],
    attachmentQueue: queue,
    attachmentBlock: null,
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    openAttachmentPicker: noop,
    inputHighlightRef: createRef(),
    renderInputWithMentions: (text: string) => text,
    textareaRef: createRef(),
    input: 'hello',
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: '',
    isTextareaExpanded: false,
    ...overrides,
  } as Props;
  render(<ChatComposer {...props} />);
};

describe('ChatComposer send gate', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('leaves the send button enabled with nothing unfinished', () => {
    renderComposer({});
    expect(screen.getByLabelText(/^input\.send/)).toHaveProperty('disabled', false);
  });

  it('disables send while attachments upload and says why', () => {
    renderComposer({ attachmentBlock: 'uploading' });
    expect(screen.getByLabelText('input.attachments.stillUploading')).toHaveProperty('disabled', true);
  });

  it('disables send while an attachment has failed and says why', () => {
    renderComposer({ attachmentBlock: 'failed' });
    expect(screen.getByLabelText('input.attachments.needsAttention')).toHaveProperty('disabled', true);
  });

  it('never turns the blocked button into Stop during a running turn', () => {
    renderComposer({
      attachmentBlock: 'uploading',
      isLoading: true,
      canAbortSession: true,
      isInputBlocked: true,
      hasActiveBackgroundTasks: false,
    });
    const button = screen.getByLabelText('input.attachments.stillUploading');
    expect(button).toHaveProperty('disabled', true);
    expect(button.querySelector('.fill-current')).toBeNull();
  });
});
