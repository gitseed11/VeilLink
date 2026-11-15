import fs from 'node:fs/promises';
import { sanitizeForLog, nowIso, redactSecrets } from './util.js';
import { ensureDirPrivate } from './storage.js';

const MAX_MEMORY = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class LogStore {
  constructor(paths) {
    this.paths = paths;
    this.entries = [];
    this.writeChain = Promise.resolve();
    this.fileBytes = 0;
    this.writeFailures = 0;
  }

  static async load(paths) {
    const store = new LogStore(paths);
    await ensureDirPrivate(paths.logsDir);
    try {
      const stat = await fs.stat(paths.accessLogFile);
      if (stat.size > MAX_FILE_BYTES) {
        await fs.rm(`${paths.accessLogFile}.1`, { force: true });
        await fs.rename(paths.accessLogFile, `${paths.accessLogFile}.1`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      const text = await fs.readFile(paths.accessLogFile, 'utf8');
      const lines = text.trimEnd().split('\n').slice(-MAX_MEMORY);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item && typeof item === 'object') store.entries.push(item);
        } catch {
          // Ignore a torn final line, keep the rest of the log usable.
        }
      }
      const stat = await fs.stat(paths.accessLogFile);
      store.fileBytes = stat.size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return store;
  }

  add(entry) {
    const safe = sanitizeForLog({
      id: entry.id,
      time: entry.time || nowIso(),
      kind: entry.kind || 'request',
      method: entry.method || '',
      path: entry.path || '',
      status: entry.status ?? null,
      durationMs: entry.durationMs ?? null,
      keyId: entry.keyId || null,
      keyName: entry.keyName || null,
      ip: entry.ip || null,
      model: entry.model || null,
      stream: entry.stream === true,
      inputTokens: entry.inputTokens ?? null,
      outputTokens: entry.outputTokens ?? null,
      upstreamStatus: entry.upstreamStatus ?? null,
      error: entry.error || null,
      action: entry.action || null,
      detail: entry.detail || null
    });
    this.entries.push(safe);
    if (this.entries.length > MAX_MEMORY) {
      this.entries.splice(0, this.entries.length - MAX_MEMORY);
    }
    const line = `${JSON.stringify(safe)}\n`;
    this.fileBytes += Buffer.byteLength(line);
    this.writeChain = this.writeChain
      .then(() => fs.appendFile(this.paths.accessLogFile, line, { mode: 0o600 }))
      .then(() => {
        if (this.fileBytes > MAX_FILE_BYTES) return this.rotate();
      })
      .catch((error) => {
        this.writeFailures += 1;
        if (this.writeFailures === 1) {
          console.error(`[VeilLink] Log write failed: ${redactSecrets(error.message)}`);
        }
      });
    return safe;
  }

  audit(action, { ip = '', detail = '' } = {}) {
    return this.add({
      kind: 'audit',
      action,
      ip,
      detail
    });
  }

  list(limit = 100) {
    const count = Math.min(Math.max(Number(limit) || 100, 1), MAX_MEMORY);
    return this.entries.slice(-count).reverse();
  }

  async rotate() {
    await fs.rm(`${this.paths.accessLogFile}.1`, { force: true });
    await fs.rename(this.paths.accessLogFile, `${this.paths.accessLogFile}.1`).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    this.fileBytes = 0;
  }

  async clear() {
    this.entries = [];
    this.writeChain = this.writeChain.then(async () => {
      await fs.rm(this.paths.accessLogFile, { force: true });
      await fs.rm(`${this.paths.accessLogFile}.1`, { force: true });
      this.fileBytes = 0;
    });
    await this.writeChain;
  }

  async close() {
    await this.writeChain.catch(() => {});
  }
}
