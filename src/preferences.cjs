'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { CAMPUSES, intervalSeconds, validTarget, targetFields } = require('./courts.cjs');
const { decodePushConnection, encodePushConnection } = require('./push-connection.cjs');

const defaultOptions = { campus: 'shahe', interval: 2 };

class Preferences {
  constructor(file, storage, platform = process.platform) {
    this.platform = platform;
    this.file = file;
    this.storage = storage;
    this.options = { ...defaultOptions, targets: {} };
    this.provider = null;
    this.sessionConnection = null;
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

  async decrypt() {
    if (!await this.storage.isAsyncEncryptionAvailable()) throw new Error('OS encryption unavailable');
    const plain = await this.storage.decryptStringAsync(this.verifiedCiphertext(Buffer.from(this.encrypted, 'base64')));
    const connection = decodePushConnection(plain.result);
    if (!connection) throw new Error('Invalid stored notification connection');
    return { connection, rotate: plain.shouldReEncrypt };
  }

  async readConnection() {
    if (!this.encrypted) return this.sessionConnection;
    const { connection } = await this.decrypt();
    this.provider = connection.provider;
    return connection;
  }

  async load() {
    let data;
    let handle;
    try {
      const entry = await fs.lstat(this.file);
      if (!entry.isFile() || entry.nlink !== 1) throw new Error('Invalid settings file');
      handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== entry.dev || info.ino !== entry.ino ||
          info.size > 8192 || (process.getuid && info.uid !== process.getuid())) throw new Error('Invalid settings file');
      const bytes = Buffer.alloc(8193);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 8192) throw new Error('Settings file too big');
      data = JSON.parse(bytes.toString('utf8', 0, length));
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = '本地设置无法读取，已恢复默认设置。';
      return;
    } finally { await handle?.close(); }
    if (data?.options && typeof data.options === 'object') {
      const stored = data.options;
      const campus = typeof stored.campus === 'string' && Object.hasOwn(CAMPUSES, stored.campus) ? stored.campus : defaultOptions.campus;
      const seconds = intervalSeconds(stored.interval);
      const interval = seconds === null ? defaultOptions.interval : seconds / 60;
      const targets = stored.targets;
      if (campus !== stored.campus || seconds === null) this.warning = '校区或检查间隔已恢复默认，已保留提醒目标。';
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
    let decoded;
    try {
      decoded = await this.decrypt();
      this.provider = decoded.connection.provider;
    } catch {
      this.provider = null;
      this.warning = '系统安全存储暂时无法读取通知配置。';
      return;
    }
    if (decoded.rotate) {
      try {
        const renewed = await this.seal(decoded.connection);
        await this.persist(this.options, renewed);
        this.encrypted = renewed;
      } catch {
        this.warning = '加密配置暂时无法更新，已保留原有配置。';
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

  saveConnection(connection, sessionOnly = false) {
    return this.enqueue(async () => {
      let encrypted = null;
      if (connection && !sessionOnly) {
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
      this.provider = connection?.provider ?? null;
      this.sessionConnection = encrypted ? null : connection;
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
