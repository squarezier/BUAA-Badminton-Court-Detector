'use strict';

const { parseToken } = require('./courts.cjs');

const FEISHU_WEBHOOK = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,128}$/;

function feishuConnection(value) {
  if (!value || typeof value !== 'object') return null;
  const { webhook, secret = '' } = value;
  if (typeof webhook !== 'string' || webhook.length > 256 || !FEISHU_WEBHOOK.test(webhook.trim())) return null;
  if (typeof secret !== 'string' || secret.length > 256 || /\p{Cc}/u.test(secret.trim())) return null;
  return { provider: 'feishu', webhook: webhook.trim(), secret: secret.trim() };
}

function decodePushConnection(plain) {
  if (typeof plain !== 'string' || plain.length > 1024) return null;
  if (plain.startsWith('{')) {
    try {
      const value = JSON.parse(plain);
      return value?.provider === 'feishu' ? feishuConnection(value) : null;
    } catch { return null; }
  }
  const token = parseToken(plain);
  return token ? { provider: token.startsWith('SCT') ? 'serverchan' : 'pushplus', token } : null;
}

function encodePushConnection(connection) {
  return connection.provider === 'feishu' ? JSON.stringify(connection) : connection.token;
}

module.exports = { feishuConnection, decodePushConnection, encodePushConnection };
