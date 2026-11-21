// @ts-nocheck -- web-push does not provide declarations in this project.
import webPush from 'web-push';

import { getConnection } from '../database/index.js';

let cachedKeys = null;

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const db = getConnection();
  const row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get();
  if (row) {
    cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  // RFC 8292 requires the subject to be an origin the deployment controls.
  // Apple rejects placeholder TLDs (.local) with 403 BadJwtToken on every
  // send, so deployments must set VAPID_SUBJECT; the default is only a
  // valid-format placeholder.
  const subject = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';
  webPush.setVapidDetails(
    subject,
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
