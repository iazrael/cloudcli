import { MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE_BYTES } from '@/shared/constants';
import type {
  ComposerAttachmentItem,
  ComposerAttachmentQueue,
  UploadedComposerAttachment,
} from '@/shared/types';
import { createClientRequestId } from '@/shared/utils';

type AttachmentUploader = (
  file: File,
  options: { requestId: string; signal: AbortSignal; onProgress: (progress: number) => void },
) => Promise<unknown>;

/**
 * A phone's uplink is shared: sending all ten files at once would stretch each
 * past Cloudflare's response window, which is the failure per-file requests fix.
 * The limit is across scopes for the same reason.
 */
const MAX_CONCURRENT_UPLOADS = 3;

const NO_ATTACHMENTS: readonly ComposerAttachmentItem[] = Object.freeze([]);

/**
 * Creates the queue `useChatComposerState` keeps for its lifetime. It lives
 * outside React so an upload outlives a session switch and a send can read the
 * current state synchronously.
 */
export function createAttachmentUploadQueue(upload: AttachmentUploader): ComposerAttachmentQueue {
  const scopes = new Map<string, readonly ComposerAttachmentItem[]>();
  // One entry per running upload. An upload whose entry is gone was removed or
  // aborted, which is how its late result gets ignored.
  const controllers = new Map<string, AbortController>();
  const progress = new Map<string, number>();
  const listeners = new Set<() => void>();
  const progressListeners = new Map<string, Set<() => void>>();

  const patch = (id: string, change: Partial<ComposerAttachmentItem>) => {
    for (const [scope, items] of scopes) {
      if (items.some((item) => item.id === id)) {
        scopes.set(scope, items.map((item) => (item.id === id ? { ...item, ...change } : item)));
        return;
      }
    }
  };

  const setProgress = (id: string, value: number) => {
    if ((progress.get(id) ?? 0) === value) return;
    progress.set(id, value);
    progressListeners.get(id)?.forEach((listener) => listener());
  };

  const start = ({ id, file }: ComposerAttachmentItem) => {
    const controller = new AbortController();
    controllers.set(id, controller);
    patch(id, { status: 'uploading' });

    const settle = (change: Partial<ComposerAttachmentItem>) => {
      if (controllers.get(id) !== controller) return;
      controllers.delete(id);
      patch(id, change);
      commit();
    };

    void upload(file, {
      requestId: id,
      signal: controller.signal,
      onProgress: (value) => {
        if (controllers.get(id) === controller) setProgress(id, value);
      },
    }).then(
      (uploaded) => settle({ status: 'done', uploaded }),
      (error: unknown) => settle({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  /** Fills the free upload slots, oldest attachment first, then tells subscribers once. */
  const commit = () => {
    for (const items of scopes.values()) {
      for (const item of items) {
        if (controllers.size >= MAX_CONCURRENT_UPLOADS) break;
        if (item.status === 'queued') start(item);
      }
    }
    listeners.forEach((listener) => listener());
  };

  const getItems = (scope: string) => scopes.get(scope) ?? NO_ATTACHMENTS;

  return {
    add(scope, files) {
      const current = getItems(scope);
      const accepted = files.slice(0, Math.max(0, MAX_ATTACHMENT_COUNT - current.length));
      if (accepted.length === 0) return;
      scopes.set(scope, [...current, ...accepted.map((file): ComposerAttachmentItem => ({
        id: createClientRequestId(),
        file,
        status: file.size > MAX_ATTACHMENT_SIZE_BYTES ? 'tooLarge' : 'queued',
      }))]);
      commit();
    },

    restore(scope, entries: UploadedComposerAttachment[]) {
      if (entries.length === 0) return;
      scopes.set(scope, [...entries.map(({ file, uploaded }): ComposerAttachmentItem => ({
        id: createClientRequestId(),
        file,
        status: 'done',
        uploaded,
      })), ...getItems(scope)]);
      commit();
    },

    remove(id) {
      controllers.get(id)?.abort();
      controllers.delete(id);
      progress.delete(id);
      for (const [scope, items] of scopes) {
        const remaining = items.filter((item) => item.id !== id);
        if (remaining.length === 0) scopes.delete(scope);
        else if (remaining.length !== items.length) scopes.set(scope, remaining);
      }
      commit();
    },

    retry(id) {
      const failed = [...scopes.values()].flat().some((item) => item.id === id && item.status === 'failed');
      if (!failed) return;
      setProgress(id, 0);
      patch(id, { status: 'queued', error: undefined });
      commit();
    },

    take(scope) {
      const items = getItems(scope);
      scopes.delete(scope);
      items.forEach((item) => progress.delete(item.id));
      commit();
      return items;
    },

    abortAll() {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      scopes.clear();
      progress.clear();
      commit();
    },

    getItems,
    isReady: (scope) => getItems(scope).every((item) => item.status === 'done'),
    getProgress: (id) => progress.get(id) ?? 0,

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    subscribeProgress(id, listener) {
      const subscribers = progressListeners.get(id) ?? new Set();
      progressListeners.set(id, subscribers);
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) progressListeners.delete(id);
      };
    },
  };
}
