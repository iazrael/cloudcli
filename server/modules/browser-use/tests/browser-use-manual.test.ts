import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isManualKeyAllowed,
  isManualPointWithinViewport,
  normalizeManualUrl,
} from '@/modules/browser-use/browser-use.service.js';

test('normalizeManualUrl defaults bare hosts to http for LAN addresses', () => {
  assert.equal(normalizeManualUrl('192.168.1.1'), 'http://192.168.1.1/');
  assert.equal(normalizeManualUrl(' localhost:3001 '), 'http://localhost:3001/');
  assert.equal(normalizeManualUrl('nas.local:5000/admin'), 'http://nas.local:5000/admin');
});

test('normalizeManualUrl keeps explicit protocols and rejects non-http ones', () => {
  assert.equal(normalizeManualUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeManualUrl('http://10.0.0.2:8080/x'), 'http://10.0.0.2:8080/x');
  assert.throws(() => normalizeManualUrl('file:///etc/passwd'));
  assert.throws(() => normalizeManualUrl('ftp://example.com'));
  assert.throws(() => normalizeManualUrl(''));
  assert.throws(() => normalizeManualUrl('   '));
});

test('isManualKeyAllowed only accepts the remote-control whitelist', () => {
  for (const key of [
    'Enter', 'Backspace', 'Delete', 'Tab', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
  ]) {
    assert.equal(isManualKeyAllowed(key), true, key);
  }

  for (const key of ['a', 'A', 'Meta+a', 'ControlLeft', 'F12', '']) {
    assert.equal(isManualKeyAllowed(key), false, key);
  }
});

test('isManualPointWithinViewport bounds points to the session viewport', () => {
  const viewport = { width: 1024, height: 768 };
  assert.equal(isManualPointWithinViewport({ x: 0, y: 0 }, viewport), true);
  assert.equal(isManualPointWithinViewport({ x: 1023.5, y: 767.5 }, viewport), true);
  assert.equal(isManualPointWithinViewport({ x: 1024, y: 100 }, viewport), false);
  assert.equal(isManualPointWithinViewport({ x: 100, y: 768 }, viewport), false);
  assert.equal(isManualPointWithinViewport({ x: -1, y: 10 }, viewport), false);
  assert.equal(isManualPointWithinViewport({ x: Number.NaN, y: 10 }, viewport), false);
  assert.equal(isManualPointWithinViewport({ x: 10, y: 10 }, null), false);
});
