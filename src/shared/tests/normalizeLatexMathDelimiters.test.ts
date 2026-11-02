import assert from 'node:assert/strict';

import { test } from 'vitest';

import { normalizeLatexMathDelimiters } from '@/shared/utils';

test('rewrites display-math bracket delimiters into the dollar form remark-math parses', () => {
  assert.equal(
    normalizeLatexMathDelimiters('\\[ \\mathcal L_{\\text{sup}} \\]'),
    '$$ \\mathcal L_{\\text{sup}} $$',
  );
});

test('rewrites inline-math bracket delimiters', () => {
  assert.equal(normalizeLatexMathDelimiters('before \\( a+b \\) after'), 'before $$ a+b $$ after');
});

test('keeps a multi-line display formula intact', () => {
  assert.equal(
    normalizeLatexMathDelimiters('\\[\nE = mc^2\n\\]'),
    '$$\nE = mc^2\n$$',
  );
});

test('leaves fenced code blocks untouched, including closing with a longer fence', () => {
  const source = '```latex\n\\[ x \\]\n````\n\n\\[ y \\]';
  assert.equal(
    normalizeLatexMathDelimiters(source),
    '```latex\n\\[ x \\]\n````\n\n$$ y $$',
  );
});

test('leaves tilde fences untouched', () => {
  const source = '~~~\n\\( a \\)\n~~~';
  assert.equal(normalizeLatexMathDelimiters(source), source);
});

test('leaves inline code spans untouched', () => {
  assert.equal(
    normalizeLatexMathDelimiters('use `\\[ x \\]` for display, \\( y \\) for inline'),
    'use `\\[ x \\]` for display, $$ y $$ for inline',
  );
});

test('promotes single-dollar inline math whose content reads as LaTeX', () => {
  assert.equal(
    normalizeLatexMathDelimiters('每层 $64\\times 64$ 矩阵状态 $S_t$ 与 $k_t, v_t \\in \\mathbb{R}$：'),
    '每层 $$64\\times 64$$ 矩阵状态 $$S_t$$ 与 $$k_t, v_t \\in \\mathbb{R}$$：',
  );
});

test('promotes a lone variable between dollars', () => {
  assert.equal(normalizeLatexMathDelimiters('$x$ 和 $y$'), '$$x$$ 和 $$y$$');
});

test('keeps currency amounts and ranges literal', () => {
  assert.equal(normalizeLatexMathDelimiters('价格 $5，成本 $10'), '价格 $5，成本 $10');
  assert.equal(normalizeLatexMathDelimiters('售价 $5.00$ 起'), '售价 $5.00$ 起');
  assert.equal(normalizeLatexMathDelimiters('区间 $5-$10 元'), '区间 $5-$10 元');
});

test('leaves escaped dollars, existing dollar display math, and code spans alone', () => {
  assert.equal(normalizeLatexMathDelimiters('\\$x\\$'), '\\$x\\$');
  assert.equal(normalizeLatexMathDelimiters('$$ y = 1 $$'), '$$ y = 1 $$');
  assert.equal(normalizeLatexMathDelimiters('`$x_t$` 与 $y_t$'), '`$x_t$` 与 $$y_t$$');
});

test('returns text without math delimiters unchanged', () => {
  const source = 'plain $5 and $$block$$ text';
  assert.equal(normalizeLatexMathDelimiters(source), source);
});

test('rejects dollars that do not hug their content or follow a backslash or dollar', () => {
  assert.equal(normalizeLatexMathDelimiters('$ x_t$ 与 $x_t $'), '$ x_t$ 与 $x_t $');
  assert.equal(normalizeLatexMathDelimiters('$x_t\\$'), '$x_t\\$');
  assert.equal(normalizeLatexMathDelimiters('a$x_t$b'), 'a$$x_t$$b');
  assert.equal(normalizeLatexMathDelimiters('第一行\n$x_t$ 开头'), '第一行\n$$x_t$$ 开头');
});

test('single-dollar matching stays lookbehind-free and equivalent to the lookbehind form', () => {
  // Safari < 16.4 cannot parse lookbehind; the client bundle must not carry one.
  // The pre-rewrite pattern is the behavioral reference.
  const reference = /(?<![\\$])\$(?![$\s])([^\n$]+?)(?<!\s)(?<!\\)\$(?!\$)/g;
  const referenceConvert = (value: string) =>
    value.replace(reference, (match, body: string) =>
      /[\\_^={}]/.test(body) || /^[A-Za-z]$/.test(body) ? '$$' + body + '$$' : match,
    );

  const alphabet = ['$', '$', '$', 'x', '_', ' ', '\\', '\n', '5', '{', 'a'];
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let i = 0; i < 5000; i += 1) {
    let sample = '';
    const length = 1 + (next() % 12);
    for (let j = 0; j < length; j += 1) sample += alphabet[next() % alphabet.length];
    // No brackets, backticks or fences in the alphabet, so only the dollar pass applies.
    assert.equal(normalizeLatexMathDelimiters(sample), referenceConvert(sample), JSON.stringify(sample));
  }
});
