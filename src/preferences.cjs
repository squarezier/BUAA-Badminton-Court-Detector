'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { validOptions, parseToken } = require('./courts.cjs');

class Preferences {
  constructor(file, storage) {
    this.file = file;
    this.storage = storage;
    this.options = { campus: 'shahe', interval: 2 };
    this.token = null;
    this.encrypted = null;
    this.warning = '';
    this.writing = Promise.resolve();
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
    if (validOptions(data?.options)) this.options = { campus: data.options.campus, interval: data.options.interval };
    if (typeof data?.encryptedToken !== 'string' || !/^[A-Za-z0-9+/=]{8,4096}$/.test(data.encryptedToken)) return;
    this.encrypted = data.encryptedToken;
    let plain;
    try {
      if (!await this.storage.isAsyncEncryptionAvailable()) throw new Error('OS encryption unavailable');
      plain = await this.storage.decryptStringAsync(Buffer.from(this.encrypted, 'base64'));
      this.token = parseToken(plain.result);
      if (!this.token) throw new Error('Invalid stored push token');
    } catch {
      this.token = null;
      this.warning = '系统安全存储暂时无法读取令牌，请重新配置微信通知。';
      return;
    }
    if (plain.shouldReEncrypt) {
      try {
        const renewed = (await this.storage.encryptStringAsync(this.token)).toString('base64');
        await this.persist(this.options, renewed);
        this.encrypted = renewed;
      } catch {
        this.warning = '系统安全存储暂时无法更新，本次仍可使用已读取的令牌。';
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

  saveToken(token) {
    return this.enqueue(async () => {
      let encrypted = null;
      if (token) {
        try {
          if (await this.storage.isAsyncEncryptionAvailable()) {
            encrypted = (await this.storage.encryptStringAsync(token)).toString('base64');
          }
        } catch {
          // The token stays in memory if the OS vault is unavailable.
        }
      }
      await this.persist(this.options, encrypted);
      this.encrypted = encrypted;
      this.token = token;
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
