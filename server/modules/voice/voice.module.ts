import multer from 'multer';

import { createByteLimitTransform } from '@/shared/utils.js';

import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService } from './voice.service.js';

const DEFAULT_VOICE_TIMEOUT_MS = 300_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: frontend-configured custom
    // backends are called directly by the browser and never become SSRF input.
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
  },
  timeoutMs: voiceTimeoutMs,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

/**
 * In-memory storage for audio uploads that never buffers more than `maxBytes`.
 *
 * Mirrors `multer.memoryStorage` (same `{ buffer, size }` result and
 * `_removeFile` contract) but caps the stream through
 * `createByteLimitTransform`, because Multer's `fileSize + 1` Busboy limit
 * lets one extra byte reach a built-in storage before the abort.
 *
 * Consumer: `audioUpload` below; exercised directly by
 * `server/modules/voice/tests/voice-upload-storage.test.ts`.
 */
export function createBoundedMemoryStorage(maxBytes: number): multer.StorageEngine {
  return {
    _handleFile(_request, file, callback) {
      const chunks: Buffer[] = [];
      const gate = createByteLimitTransform(maxBytes);
      let settled = false;
      const finish = (error: Error | null, value?: { buffer: Buffer; size: number }) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(error, value);
      };

      file.stream.once('error', (error) => {
        gate.destroy();
        finish(error);
      });
      gate.on('data', (chunk: Buffer) => chunks.push(chunk));
      gate.once('error', (error) => finish(error));
      gate.once('end', () => {
        const buffer = Buffer.concat(chunks);
        finish(null, { buffer, size: buffer.length });
      });
      file.stream.pipe(gate);
    },

    _removeFile(_request, file, callback) {
      delete (file as { buffer?: Buffer }).buffer;
      callback(null);
    },
  };
}

const VOICE_UPLOAD_MAXIMUM_SIZE_BYTES = 25 * 1024 * 1024;

const audioUpload = multer({
  storage: createBoundedMemoryStorage(VOICE_UPLOAD_MAXIMUM_SIZE_BYTES),
  limits: { fileSize: VOICE_UPLOAD_MAXIMUM_SIZE_BYTES },
});

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  parseAudioUpload: audioUpload.single('audio'),
});
