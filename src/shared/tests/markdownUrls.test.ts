import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  filePathFromFileUrl,
  fileReferenceFromMarkdownHref,
  isFileUrl,
  isWindowsAbsolutePath,
  markdownUrlTransform,
} from '@/shared/utils';

// Antigravity renders plan links as `[name.md](file:///Users/.../brain/<id>/name.md)`.
// Before these helpers existed, react-markdown's default URL transform stripped
// the `file:` scheme, the anchor fell back to the bare link text, and clicking
// the plan link produced a 404 in the editor. The same transform now also has
// to keep the local paths markdown images use.

test('isFileUrl matches file URLs case-insensitively and rejects everything else', () => {
  assert.equal(isFileUrl('file:///Users/azrael/plan.md'), true);
  assert.equal(isFileUrl('FILE:///C:/plan.md'), true);
  assert.equal(isFileUrl('https://example.com/plan.md'), false);
  assert.equal(isFileUrl('/Users/azrael/plan.md'), false);
  assert.equal(isFileUrl(undefined), false);
  assert.equal(isFileUrl(''), false);
});

test('isWindowsAbsolutePath recognizes both separator forms and percent-escaped backslashes', () => {
  assert.equal(isWindowsAbsolutePath('C:\\Users\\plan.md'), true);
  assert.equal(isWindowsAbsolutePath('C:/Users/plan.md'), true);
  assert.equal(isWindowsAbsolutePath('C:%5CUsers%5Cplan.md'), true);
  assert.equal(isWindowsAbsolutePath('/Users/plan.md'), false);
  assert.equal(isWindowsAbsolutePath('file:///C:/plan.md'), false);
  assert.equal(isWindowsAbsolutePath(undefined), false);
});

test('filePathFromFileUrl decodes a plain local file URL', () => {
  assert.equal(
    filePathFromFileUrl('file:///Users/azrael/.gemini/antigravity-cli/brain/28b2c337/plan.md'),
    '/Users/azrael/.gemini/antigravity-cli/brain/28b2c337/plan.md',
  );
});

test('filePathFromFileUrl decodes percent-escaped spaces and non-ASCII names', () => {
  assert.equal(
    filePathFromFileUrl('file:///Users/azrael/My%20Plans/%E6%9D%83%E9%99%90%E8%AE%A1%E5%88%92.md'),
    '/Users/azrael/My Plans/权限计划.md',
  );
});

test('filePathFromFileUrl accepts an explicit localhost host', () => {
  assert.equal(
    filePathFromFileUrl('file://localhost/Users/azrael/plan.md'),
    '/Users/azrael/plan.md',
  );
});

test('filePathFromFileUrl rejects remote hosts and non-file URLs', () => {
  assert.equal(filePathFromFileUrl('file://server/share/plan.md'), undefined);
  assert.equal(filePathFromFileUrl('https://example.com/plan.md'), undefined);
  assert.equal(filePathFromFileUrl('/Users/azrael/plan.md'), undefined);
  assert.equal(filePathFromFileUrl(undefined), undefined);
});

test('markdownUrlTransform keeps local paths verbatim', () => {
  const fileUrl = 'file:///Users/azrael/plan%20a.md';
  assert.equal(markdownUrlTransform(fileUrl), fileUrl);
  assert.equal(markdownUrlTransform('C:\\Users\\plan.png'), 'C:\\Users\\plan.png');
});

test('markdownUrlTransform delegates other URLs to the default transform', () => {
  assert.equal(
    markdownUrlTransform('https://example.com/plan.md'),
    'https://example.com/plan.md',
  );
  // A relative path has no scheme to strip, so it survives untouched.
  assert.equal(markdownUrlTransform('../public/a.png'), '../public/a.png');
  // Dangerous schemes must still be stripped by the default transform.
  assert.equal(markdownUrlTransform('javascript:alert(1)'), '');
});

test('fileReferenceFromMarkdownHref turns local references into editor paths', () => {
  assert.equal(
    fileReferenceFromMarkdownHref('file:///Users/azrael/brain/plan.md'),
    '/Users/azrael/brain/plan.md',
  );
  assert.equal(fileReferenceFromMarkdownHref('src/My%20File.ts:12'), 'src/My File.ts:12');
  assert.equal(fileReferenceFromMarkdownHref('C:%5CUsers%5Cplan.md'), 'C:\\Users\\plan.md');
});

test('fileReferenceFromMarkdownHref leaves web URLs and empty hrefs alone', () => {
  assert.equal(
    fileReferenceFromMarkdownHref('https://example.com/a%20b'),
    'https://example.com/a%20b',
  );
  assert.equal(fileReferenceFromMarkdownHref(undefined), undefined);
  assert.equal(fileReferenceFromMarkdownHref(''), undefined);
});

// 上游 #1711：Markdown 会把本地路径里的 Unicode 与空格百分号编码后才交给链接
// 渲染；解码必须在边界处一次完成，且单个坏转义不能挡住其余合法转义的解码。
test.each([
  ['/workspace/자료/경력-원장.md', '/workspace/자료/경력-원장.md'],
  ['/workspace/%EC%9E%90%EB%A3%8C/%EA%B2%BD%EB%A0%A5-%EC%9B%90%EC%9E%A5.md', '/workspace/자료/경력-원장.md'],
  ['/workspace/资料/完成记录.md', '/workspace/资料/完成记录.md'],
  ['/workspace/caf%C3%A9/r%C3%A9sum%C3%A9.md', '/workspace/café/résumé.md'],
  ['/workspace/My Report/진행 100%.md', '/workspace/My Report/진행 100%.md'],
  ['/workspace/100%-complete%20draft.md', '/workspace/100%-complete draft.md'],
  ['/workspace/literal%2520.md', '/workspace/literal%20.md'],
  ['/workspace/name%23part%3F%2B.md', '/workspace/name#part?+.md'],
  ['/workspace/notes.md%3A12', '/workspace/notes.md:12'],
  ['./notes.md%3A12:9', './notes.md:12:9'],
  ['notes%2Emd', 'notes.md'],
  ['/workspace/자료/100%complete.md', '/workspace/자료/100%complete.md'],
  ['/workspace/자료/%draft%2520.md', '/workspace/자료/%draft%20.md'],
  ['/workspace/자료/bad%E0%A4%20draft.md', '/workspace/자료/bad%E0%A4 draft.md'],
  ['/workspace/%FF%EC%9E%90%EB%A3%8C.md', '/workspace/%FF자료.md'],
])('decodes %s to %s', (href, expected) => {
  assert.equal(fileReferenceFromMarkdownHref(href), expected);
});
