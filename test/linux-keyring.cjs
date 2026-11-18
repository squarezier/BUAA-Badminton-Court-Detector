'use strict';

// Run in isolated D-Bus sessions with a real Secret Service and again without one.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { Preferences } = require('../src/preferences.cjs');

const [mode, profile] = process.argv.slice(-2);
app.setName('Houyu Linux Keyring Regression');
app.setPath('userData', path.resolve(profile));
app.enableSandbox();
app.commandLine.appendSwitch('password-store', mode === 'unavailable' ? 'basic' : 'gnome-libsecret');
const connection = {
  provider: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-4333-8444-555555555555',
  secret: 'synthetic-linux-keyring-check',
};

app.whenReady().then(async () => {
  assert.equal(process.platform, 'linux');
  const file = path.join(profile, 'settings.json');
  const prefs = new Preferences(file, safeStorage);
  if (mode === 'read') {
    await prefs.load();
    assert.deepEqual(prefs.connection, connection, 'a fresh process must decrypt the stored connection');
  } else {
    assert.equal(await prefs.saveConnection(connection), mode === 'write');
    const saved = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(saved, /feishu\.cn|synthetic-linux-keyring-check/);
    assert.equal(Boolean(JSON.parse(saved).encryptedToken), mode === 'write');
  }
  console.log('Linux secret service check passed:', mode);
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
