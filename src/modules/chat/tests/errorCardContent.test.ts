import { describe, expect, it } from 'vitest';

import { parseErrorCardContent } from '@/modules/chat/utils/errorCardContent';

describe('parseErrorCardContent', () => {
  it('extracts the nested adapter message from an engine error object', () => {
    const content = JSON.stringify({
      name: 'AiSdkModelAdapterError',
      data: {
        message: 'captcha verify failed',
        code: 'invalid_model_request',
        attribution: { reason: 'auth_failed', statusCode: 400 },
      },
    });

    const parsed = parseErrorCardContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.message).toBe('captcha verify failed');
    expect(JSON.parse(parsed?.detailJson ?? '')).toEqual(JSON.parse(content));
  });

  it('falls back to the top-level message, then code, then name', () => {
    const flat = parseErrorCardContent(JSON.stringify({ message: 'boom', code: 'X' }));
    expect(flat?.message).toBe('boom');

    const codeOnly = parseErrorCardContent(JSON.stringify({ code: 'E1' }));
    expect(codeOnly?.message).toBe('E1');

    const nameOnly = parseErrorCardContent(JSON.stringify({ name: 'AbortError' }));
    expect(nameOnly?.message).toBe('AbortError');
  });

  it('keeps plain-text errors verbatim', () => {
    expect(parseErrorCardContent('provider auth failed')).toBeNull();
    expect(parseErrorCardContent('{"broken')).toBeNull();
    expect(parseErrorCardContent(JSON.stringify(['not', 'an', 'object']))).toBeNull();
  });

  it('falls back to the raw content when no readable field exists', () => {
    const empty = parseErrorCardContent('{}');
    expect(empty?.message).toBe('{}');
  });
});
