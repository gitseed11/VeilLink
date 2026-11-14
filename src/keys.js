import crypto from 'node:crypto';
import {
  AppError,
  KEY_ALPHABET,
  KEY_BODY_LENGTH,
  KEY_PREFIX,
  nowIso,
  sanitizeText
} from './util.js';
import { readJsonIfExists, writeJsonAtomic } from './storage.js';

const KEY_PATTERN = /^sk-[A-Za-z0-9@#%&]{24}$/;
const MAX_KEYS = 200;

function generateKeyBody(length = KEY_BODY_LENGTH) {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  }
  return result;
}

export function generateApiKey() {
  return `${KEY_PREFIX}${generateKeyBody()}`;
}

export function isValidApiKeyShape(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function keyId() {
  return `key_${crypto.randomBytes(8).toString('hex')}`;
}

function safeRecord(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    lastIp: record.lastIp,
    allowedDevice: record.allowedDevice,
    active: !record.revokedAt
  };
}

export class KeyStore {
  static async load(paths, secretBox) {
    const raw = await readJsonIfExists(paths.keysFile, null);
    if (!raw) {
      const initial = { version: 1, keys: [] };
      await writeJsonAtomic(paths.keysFile, initial, { mode: 0o600 });
      return new KeyStore(paths, secretBox, initial.keys);
    }
    if (!raw || raw.version !== 1 || !Array.isArray(raw.keys)) {
      throw new Error('data/keys.json is invalid.');
    }
    for (const record of raw.keys) {
      if (
        !record ||
        typeof record.id !== 'string' ||
        typeof record.index !== 'string' ||
        !record.secretEnc ||
        typeof record.createdAt !== 'string'
      ) {
        throw new Error('data/keys.json contains an invalid key record.');
      }
    }
    return new KeyStore(paths, secretBox, raw.keys);
  }

  constructor(paths, secretBox, keys) {
    this.paths = paths;
    this.secretBox = secretBox;
    this.keys = keys;
    this.byIndex = new Map();
    this.unreadableCount = 0;
    for (const record of keys) {
      this.byIndex.set(record.index, record);
      try {
        this.secretBox.decryptString(record.secretEnc, 'client-api-key-v1');
      } catch {
        this.unreadableCount += 1;
      }
    }
    this.dirty = false;
    this.flushTimer = null;
    this.writeChain = Promise.resolve();
  }

  get size() {
    return this.keys.length;
  }

  activeCount() {
    return this.keys.filter((record) => !record.revokedAt).length;
  }

  list() {
    return [...this.keys]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((record) => safeRecord(record));
  }

  find(id) {
    return this.keys.find((record) => record.id === id) || null;
  }

  safe(id) {
    const record = this.find(id);
    return record ? safeRecord(record) : null;
  }

  async generate({ name = '', allowedDevice = '' } = {}) {
    const activeCount = this.keys.filter((record) => !record.revokedAt).length;
    if (activeCount >= MAX_KEYS) {
      throw new AppError(409, 'invalid_request_error', `The key limit (${MAX_KEYS}) has been reached.`);
    }
    let key = generateApiKey();
    let index = this.secretBox.apiKeyIndex(key);
    let attempts = 0;
    while (this.byIndex.has(index) && attempts < 5) {
      key = generateApiKey();
      index = this.secretBox.apiKeyIndex(key);
      attempts += 1;
    }
    if (this.byIndex.has(index)) {
      throw new Error('Unable to generate a unique API key.');
    }

    const record = {
      id: keyId(),
      name: sanitizeText(name, 80) || '未命名密钥',
      index,
      secretEnc: this.secretBox.encryptString(key, 'client-api-key-v1'),
      createdAt: nowIso(),
      revokedAt: null,
      lastUsedAt: null,
      lastIp: null,
      allowedDevice: sanitizeText(allowedDevice, 120)
    };
    this.keys.push(record);
    this.byIndex.set(index, record);
    try {
      await this.persist();
    } catch (error) {
      this.keys.pop();
      this.byIndex.delete(index);
      throw error;
    }
    return { key, record: safeRecord(record) };
  }

  authenticate(key) {
    if (!isValidApiKeyShape(key)) {
      return { ok: false, reason: 'invalid' };
    }
    const index = this.secretBox.apiKeyIndex(key);
    const record = this.byIndex.get(index);
    if (!record) {
      return { ok: false, reason: 'invalid' };
    }
    let storedKey = '';
    try {
      storedKey = this.secretBox.decryptString(record.secretEnc, 'client-api-key-v1');
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    const expected = Buffer.from(storedKey, 'utf8');
    const actual = Buffer.from(key, 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return { ok: false, reason: 'invalid' };
    }
    if (record.revokedAt) {
      return { ok: false, reason: 'revoked', record };
    }
    return { ok: true, record };
  }

  deviceAllowed(record, suppliedDevice) {
    if (!record.allowedDevice) return true;
    const expected = String(record.allowedDevice).trim().toLowerCase();
    const actual = String(suppliedDevice || '').trim().toLowerCase();
    return Boolean(actual) && actual === expected;
  }

  touch(record, ip) {
    record.lastUsedAt = nowIso();
    record.lastIp = String(ip || '').slice(0, 80);
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch(() => {});
      }, 2000);
      this.flushTimer.unref?.();
    }
  }

  async reveal(id) {
    const record = this.find(id);
    if (!record) {
      throw new AppError(404, 'not_found_error', 'API key not found.');
    }
    try {
      return this.secretBox.decryptString(record.secretEnc, 'client-api-key-v1');
    } catch {
      throw new Error('The API key cannot be decrypted. Check data/master.key.');
    }
  }

  async revoke(id) {
    const record = this.find(id);
    if (!record) {
      throw new AppError(404, 'not_found_error', 'API key not found.');
    }
    if (!record.revokedAt) {
      const previous = record.revokedAt;
      record.revokedAt = nowIso();
      try {
        await this.persist();
      } catch (error) {
        record.revokedAt = previous;
        throw error;
      }
    }
    return safeRecord(record);
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.persist();
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  async persist() {
    const snapshot = {
      version: 1,
      keys: this.keys
    };
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => writeJsonAtomic(this.paths.keysFile, snapshot, { mode: 0o600 }));
    return this.writeChain;
  }

  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      await this.persist();
    }
  }
}

