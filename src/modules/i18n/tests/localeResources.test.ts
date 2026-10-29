import assert from 'node:assert/strict';

import { test } from 'vitest';

import i18n, { initI18n, switchLanguage } from '@/modules/i18n/config';
import { loadLocaleResources } from '@/modules/i18n/resources';

test('loadLocaleResources returns the requested language plus the en fallback', async () => {
  const resources = await loadLocaleResources('zh-CN');
  assert.ok(resources['zh-CN']?.common);
  assert.ok(resources['zh-CN']?.chat);
  assert.ok(resources.en?.common);
});

test('loadLocaleResources omits namespaces a language does not translate', async () => {
  // ja ships no git.json upstream; the missing namespace must fall back at
  // lookup time instead of being fabricated as an empty object.
  const resources = await loadLocaleResources('ja');
  assert.equal(resources.ja?.git, undefined);
  assert.ok(resources.ja?.chat);
  assert.ok(resources.en?.git);
});

test('loadLocaleResources for en loads en exactly once', async () => {
  const resources = await loadLocaleResources('en');
  assert.deepEqual(Object.keys(resources), ['en']);
});

test('loadLocaleResources for a language without files falls back to en only', async () => {
  const resources = await loadLocaleResources('xx-YY');
  assert.deepEqual(Object.keys(resources), ['en']);
});

test('initI18n loads the saved language bundles and is repeatable', async () => {
  await initI18n();
  await initI18n();
  assert.ok(i18n.hasResourceBundle('en', 'common'));
});

test('switchLanguage loads bundles before changing the language', async () => {
  await switchLanguage('fr');
  assert.equal(i18n.language, 'fr');
  assert.ok(i18n.hasResourceBundle('fr', 'common'));
  assert.ok(i18n.hasResourceBundle('fr', 'settings'));

  await switchLanguage('zh-CN');
  assert.equal(i18n.language, 'zh-CN');
  assert.ok(i18n.hasResourceBundle('zh-CN', 'common'));
  // Bundles loaded once stay available when switching back.
  assert.ok(i18n.hasResourceBundle('fr', 'common'));
});

test('switchLanguage ignores unsupported language codes', async () => {
  await switchLanguage('en');
  await switchLanguage('klingon');
  assert.equal(i18n.language, 'en');
});
