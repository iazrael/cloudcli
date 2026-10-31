import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { test } from 'vitest';

const localesPath = 'src/modules/i18n/locales';
const readLocale = (locale: string, namespace: string) =>
  JSON.parse(readFileSync(`${localesPath}/${locale}/${namespace}.json`, 'utf8'));

test('every locale has permission naming and append-queue translations', () => {
  for (const locale of readdirSync(localesPath)) {
    const chat = readLocale(locale, 'chat');
    assert.equal(typeof chat.composer.permissionCycleHint, 'string', locale);
    assert.ok(chat.composer.permissionTriggerLabel.includes('{{mode}}'), locale);
    assert.ok(chat.composer.permissionTriggerLabel.includes('{{heading}}'), locale);
    assert.equal(typeof chat.input.hintText.appendQueued, 'string', locale);
    assert.equal(typeof chat.input.queue.append, 'string', locale);
    assert.equal(typeof chat.input.queue.notCombinable, 'string', locale);
  }
});

test('English and Chinese queue errors keep their message interpolation', () => {
  for (const locale of ['en', 'zh-CN']) {
    const queue = readLocale(locale, 'chat').input.queue;
    assert.ok(queue.failed.includes('{{message}}'));
    assert.equal(typeof queue.clearFailed, 'string');
    assert.equal(typeof queue.confirmDelivery, 'string');
    // The fork's direct-send affordance still has its own translation.
    assert.equal(typeof queue.forceSendButton, 'string');
  }
});

test('expansion settings have English, French and Chinese labels', () => {
  for (const locale of ['en', 'fr', 'zh-CN']) {
    const settings = readLocale(locale, 'settings').appearanceSettings.keepProjectsExpanded;
    for (const key of ['section', 'label', 'description']) assert.equal(typeof settings[key], 'string');
  }
});
