'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { CAMPUSES, validOptions, validTarget, targetFields } = require('./courts.cjs');
const { decodePushConnection, encodePushConnection } = require('./push-connection.cjs');

const defaultOptions = { campus: 'shahe', interval: 2 };

class Preferences {
  constructor(file, storage, platform = process.platform) {
    this.platform = platform;
    this.file = file;
    this.storage = storage;
    this.options = { ...defaultOptions, targets: {} };
    this.connection = null;
    this.encrypted = null;
    this.warning = '';
    this.writing = Promise.resolve();
  }

  verifiedCiphertext(bytes) {
    // In the pinned Chromium runtime v11 identifies Secret Service and v12 the Secret portal.
    // An unavailable Linux keyring can otherwise select a shared fallback key.
    if (this.platform === 'linux' && !['v11', 'v12'].includes(bytes.toString('ascii', 0, 3))) {
      throw new Error('No supported Linux secret provider');
    }
    return bytes;
  }

  async seal(connection) {
    const bytes = await this.storage.encryptStringAsync(encodePushConnection(connection));
    return this.verifiedCiphertext(bytes).toString('base64');
  }

  async load() {
    let data;
    try {
      const info = await fs.stat(this.file);
      if (info.size > 8192) throw new Error('Settings file too big');
      data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = '本地设置无法读取，已恢复默认设置。';
      return;
    }
    if (data?.options && typeof data.options === 'object') {
      const stored = data.options;
      const campus = typeof stored.campus === 'string' && Object.hasOwn(CAMPUSES, stored.campus) ? stored.campus : defaultOptions.campus;
      const interval = validOptions({ campus, interval: stored.interval }) ? stored.interval : defaultOptions.interval;
      const targets = stored.targets;
      if (campus !== stored.campus || interval !== stored.interval) this.warning = '校区或检查间隔已恢复默认，已保留提醒目标。';
      this.options = { campus, interval, targets: {} };
      if (targets !== undefined) {
        const readable = targets !== null && typeof targets === 'object' && !Array.isArray(targets);
        for (const id of Object.keys(CAMPUSES)) {
          if (readable && !Object.hasOwn(targets, id)) continue;
          this.options.targets[id] = readable && validTarget(targets[id]) ? targetFields(targets[id]) : null;
        }
      }
    }
    if (typeof data?.encryptedToken !== 'string' || !/^[A-Za-z0-9+/=]{8,4096}$/.test(data.encryptedToken)) return;
    this.encrypted = data.encryptedToken;
    let plain;
    try {
      if (!await this.storage.isAsyncEncryptionAvailable()) throw new Error('OS encryption unavailable');
      plain = await this.storage.decryptStringAsync(this.verifiedCiphertext(Buffer.from(this.encrypted, 'base64')));
      this.connection = decodePushConnection(plain.result);
      if (!this.connection) throw new Error('Invalid stored notification connection');
    } catch {
      this.connection = null;
      this.warning = '系统安全存储暂时无法读取通知配置。';
      return;
    }
    if (plain.shouldReEncrypt) {
      try {
        const renewed = await this.seal(this.connection);
        await this.persist(this.options, renewed);
        this.encrypted = renewed;
      } catch {
        this.warning = '系统安全存储暂时无法更新，本次仍可使用已读取的通知配置。';
      }
    }
  }

  enqueue(operation) {
    const current = this.writing.then(operation);
    this.writing = current.catch(() => {});
    return current;
  }

  saveOptions(options) {
    return this.enqueue(async () => {
      await this.persist(options, this.encrypted);
      this.options = options;
    });
  }

  saveConnection(connection) {
    return this.enqueue(async () => {
      let encrypted = null;
      if (connection) {
        try {
          if (await this.storage.isAsyncEncryptionAvailable()) {
            encrypted = await this.seal(connection);
          }
        } catch {
          // A new connection can be used for this session if the vault is unavailable.
        }
        if (!encrypted && this.encrypted) throw new Error('Cannot replace the saved notification connection');
      }
      await this.persist(this.options, encrypted);
      this.encrypted = encrypted;
      this.connection = connection;
      this.warning = '';
      return Boolean(encrypted);
    });
  }

  async persist(options, encryptedToken) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, options, encryptedToken }), { flag: 'wx', mode: 0o600, flush: true });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

module.exports = { Preferences };
