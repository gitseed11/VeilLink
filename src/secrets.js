import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { writeFileAtomic, writeJsonAtomic, readJsonIfExists, readTextIfExists, fileMtimeMs } from './storage.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ADMIN_HASH_BYTES = 32;

function decodeKey(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    const buffer = Buffer.from(value, 'base64url');
    return buffer.length === 32 ? buffer : null;
  } catch {
    return null;
  }
}

export class SecretBox {
  static async load(paths) {
    let master = null;
    const existing = await readTextIfExists(paths.masterKeyFile);
    if (existing) {
      master = decodeKey(existing);
      if (!master) {
        throw new Error('data/master.key is invalid. Restore it from backup or reinitialize the data directory.');
      }
    } else {
      master = crypto.randomBytes(32);
      await writeFileAtomic(paths.masterKeyFile, `${master.toString('base64url')}\n`, { mode: 0o600 });
    }
    return new SecretBox(master);
  }

  constructor(masterKey) {
    this.masterKey = Buffer.from(masterKey);
    this.indexKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        this.masterKey,
        Buffer.from('veillink-key-index-salt'),
        Buffer.from('api-key-index-v1'),
        32
      )
    );
  }

  aad(context) {
    return Buffer.from(`veillink|${context}|v1`, 'utf8');
  }

  encryptString(plaintext, context = 'generic') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      data: ciphertext.toString('base64url')
    };
  }

  decryptString(payload, context = 'generic') {
    if (!payload || payload.v !== 1 || payload.alg !== 'aes-256-gcm') {
      throw new Error('Unsupported encrypted value.');
    }
    const iv = Buffer.from(payload.iv || '', 'base64url');
    const tag = Buffer.from(payload.tag || '', 'base64url');
    const data = Buffer.from(payload.data || '', 'base64url');
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('Encrypted value is malformed.');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAAD(this.aad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  apiKeyIndex(apiKey) {
    return crypto
      .createHmac('sha256', this.indexKey)
      .update(String(apiKey), 'utf8')
      .digest('base64url');
  }
}

async function hashAdminToken(token, salt) {
  const derived = await scrypt(String(token), salt, ADMIN_HASH_BYTES, SCRYPT_OPTIONS);
  return Buffer.from(derived);
}

export function generateAdminToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function adminCredentialRevision(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record), 'utf8').digest('base64url');
}

export class AdminAuth {
  constructor(paths) {
    this.paths = paths;
    this.record = null;
    this.recordMtimeMs = 0;
    this.revision = null;
    this.info = null;
  }

  async init() {
    let record = await readJsonIfExists(this.paths.adminFile, null);
    const existingTokenRaw = await readTextIfExists(this.paths.adminTokenFile);
    const existingToken = existingTokenRaw ? existingTokenRaw.trim() : '';
    let created = false;
    let token = existingToken;

    if (!record) {
      if (!token) token = generateAdminToken();
      if (token.length < 16) {
        throw new Error('data/ADMIN_TOKEN.txt is too short.');
      }
      record = await this.buildRecord(token);
      await writeJsonAtomic(this.paths.adminFile, record, { mode: 0o600 });
      if (!existingToken) {
        await writeFileAtomic(this.paths.adminTokenFile, `${token}\n`, { mode: 0o600 });
      }
      created = true;
    } else if (!record.salt || !record.hash || record.version !== 1) {
      throw new Error('data/admin.json is invalid. Run npm run admin:reset to create a new admin token.');
    }

    this.record = record;
    this.recordMtimeMs = await fileMtimeMs(this.paths.adminFile);
    this.revision = adminCredentialRevision(record);

    let tokenFileMatches = null;
    if (token) {
      tokenFileMatches = await this.verify(token);
      if (!tokenFileMatches && !created) {
        // Never print the token. The file and the record simply disagree.
        tokenFileMatches = false;
      }
    }

    this.info = {
      created,
      tokenGenerated: created ? token : null,
      tokenFileExists: Boolean(existingToken) || created,
      tokenFileMatches
    };
    return this.info;
  }

  async buildRecord(token) {
    const salt = crypto.randomBytes(16);
    const hash = await hashAdminToken(token, salt);
    return {
      version: 1,
      algorithm: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      createdAt: new Date().toISOString()
    };
  }

  async reloadIfChanged() {
    const mtime = await fileMtimeMs(this.paths.adminFile);
    if (mtime !== this.recordMtimeMs) {
      const record = await readJsonIfExists(this.paths.adminFile, null);
      if (!record || !record.salt || !record.hash) {
        throw new Error('Admin credential became unreadable.');
      }
      this.record = record;
      this.recordMtimeMs = mtime;
      this.revision = adminCredentialRevision(record);
    }
  }

  async verify(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) return false;
    await this.reloadIfChanged();
    const salt = Buffer.from(this.record.salt, 'base64url');
    const expected = Buffer.from(this.record.hash, 'base64url');
    const derived = await hashAdminToken(token, salt);
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }

  async reset() {
    const token = generateAdminToken();
    const record = await this.buildRecord(token);
    await writeJsonAtomic(this.paths.adminFile, record, { mode: 0o600 });
    await writeFileAtomic(this.paths.adminTokenFile, `${token}\n`, { mode: 0o600 });
    this.record = record;
    this.recordMtimeMs = await fileMtimeMs(this.paths.adminFile);
    this.revision = adminCredentialRevision(record);
    return token;
  }
}

