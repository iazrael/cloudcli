import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Layout-contract guard for the transcript scroll stack.
 *
 * `content-visibility: auto` on `.chat-message` rows made off-screen rows
 * flip between their `contain-intrinsic-size` estimate and real height at
 * the browser's render-band edge; every flip forced native scroll anchoring
 * to compensate, flipping more rows — a self-sustaining geometry oscillation
 * users saw as flicker/jump while scrolling up (re-introduced twice via
 * upstream merges). Off-screen skipping is LazyMessageRow's job, whose
 * placeholders reuse measured heights and keep geometry stable. This test
 * exists because no unit seam can exercise a real layout engine; the
 * end-to-end guard is scripts/perf/chat-scroll-up-stability.mjs.
 */
describe('transcript row CSS', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/index.css'), 'utf8');

  it('never applies content-visibility to chat message rows', () => {
    const chatMessageBlocks = css.match(/\.chat-message[^{]*\{[^}]*\}/g) ?? [];
    const offenders = chatMessageBlocks.filter((block) =>
      /content-visibility\s*:\s*auto/.test(block));
    expect(offenders, `content-visibility:auto found on: ${offenders.join(' | ')}`).toHaveLength(0);
  });
});
