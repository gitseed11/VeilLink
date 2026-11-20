import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { ConfigStore } from './config.js';
import { SecretBox, AdminAuth } from './secrets.js';
import { KeyStore } from './keys.js';
import { LogStore } from './logger.js';
import { SlidingWindowLimiter, ConcurrencyLimiter } from './rate-limit.js';
import { createAdminServer } from './admin-server.js';
import { createPublicServer, configurePublicServer } from './public-server.js';
import { SessionStore } from './sessions.js';
import { createPaths, resolveDataDir } from './paths.js';
import { ensureDirPrivate } from './storage.js';
import { hardenDirectory } from './permissions.js';
import { TunnelStatus } from './tunnel-status.js';
import { ByteBudget, closeServer, nowIso } from './util.js';

function parseLockOwner(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        token: typeof parsed.token === 'string' ? parsed.token : ''
      };
    }
  } catch {
    // Fall through to the legacy plain-PID format.
  }
  const pid = Number.parseInt(String(text || '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? { pid, token: '' } : null;
}

function reclaimGateName(lockFile) {
  const key = path.resolve(lockFile).toLowerCase();
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\veillink-lock-${digest}`;
}

async function acquireReclaimGate(lockFile) {
  if (process.platform !== 'win32') {
    // On non-Windows the file gate remains fail-closed: a crashed reclaim
    // leaves the gate behind and requires manual confirmation before removal.
    const gateFile = `${lockFile}.reclaim`;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        const handle = await fs.open(gateFile, 'wx', 0o600);
        return { kind: 'file', handle, gateFile };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error(
      'Another VeilLink process is reclaiming the data-directory lock. ' +
        'Wait for it to finish; if no instance is running, verify and remove data/veillink.lock.reclaim.'
    );
  }

  // A Windows named pipe is an OS-backed mutex: the name disappears when the
  // owning process exits or crashes, so there is no stale gate to clean up.
  const pipeName = reclaimGateName(lockFile);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const server = await new Promise((resolve, reject) => {
        const candidate = net.createServer((socket) => socket.destroy());
        const onError = (error) => {
          candidate.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          candidate.removeListener('error', onError);
          resolve(candidate);
        };
        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(pipeName);
      });
      server.on('error', () => {});
      return { kind: 'pipe', server, pipeName };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(
    'Another VeilLink process is reclaiming the data-directory lock. ' +
      'Wait for it to finish and retry.'
  );
}

async function releaseReclaimGate(gate) {
  if (!gate) return;
  if (gate.kind === 'pipe') {
    await new Promise((resolve) => gate.server.close(() => resolve()));
    return;
  }
  await gate.handle.close().catch(() => {});
  await fs.rm(gate.gateFile, { force: true }).catch(() => {});
}

async function reclaimStaleLock(lockFile, expectedText) {
  const gate = await acquireReclaimGate(lockFile);
  try {
    if (gate.kind === 'pipe') {
      // 1.2.1 and earlier used a file gate. While the pipe gate is held it is
      // inert, so remove a legacy or crash-left file to keep the data dir clean.
      await fs.rm(`${lockFile}.reclaim`, { force: true }).catch(() => {});
    }
    const latest = await fs.readFile(lockFile, 'utf8').catch(() => null);
    if (latest === expectedText) {
      await fs.rm(lockFile, { force: true }).catch(() => {});
    }
    return true;
  } finally {
    await releaseReclaimGate(gate);
  }
}

async function acquireDataLock(paths) {
  const lockFile = path.join(paths.dataDir, 'veillink.lock');
  const token = crypto.randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString()
        })}\n`,
        'utf8'
      );
      return { handle, lockFile, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let text = '';
      try {
        text = await fs.readFile(lockFile, 'utf8');
      } catch {
        text = '';
      }
      const owner = parseLockOwner(text);
      if (!owner) {
        // Never reclaim an incomplete lock automatically: the owner may be
        // paused between creating the file and writing its PID. Fail closed
        // and require the operator to verify and remove a genuinely stale
        // lock file.
        throw new Error(
          'The data directory lock is incomplete or unreadable. ' +
            'Verify no other VeilLink instance is running, then remove data/veillink.lock.'
        );
      }
      let alive = false;
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (probeError) {
        alive = probeError?.code === 'EPERM';
      }
      if (alive) {
        throw new Error(
          `The data directory is already in use by VeilLink PID ${owner.pid}. ` +
            'Stop the other instance before starting another one.'
        );
      }
      // Serialize stale-lock reclamation across processes. The re-read inside
      // the gate ensures a newly created lock is never removed by a contender
      // that raced with the previous owner.
      await reclaimStaleLock(lockFile, text);
    }
  }
  throw new Error('Unable to acquire the VeilLink data-directory lock.');
}

async function releaseDataLock(lock) {
  if (!lock) return;
  try {
    const text = await fs.readFile(lock.lockFile, 'utf8').catch(() => '');
    const owner = parseLockOwner(text);
    await lock.handle.close().catch(() => {});
    if (owner && owner.token && owner.token === lock.token) {
      await fs.rm(lock.lockFile, { force: true }).catch(() => {});
    }
  } catch {
    await lock.handle.close().catch(() => {});
  }
}

export class Runtime {
  constructor({ dataDir, adminPort, publicPort, hardenPermissions = true }) {
    this.dataDir = dataDir;
    this.requestedAdminPort = adminPort;
    this.requestedPublicPort = publicPort;
    this.hardenPermissions = hardenPermissions;
    this.permissionWarning = '';
    this.startedAt = nowIso();
    this.adminPort = null;
    this.publicPort = null;
    this.stopped = false;
  }

  async init() {
    const paths = createPaths(this.dataDir);
    this.paths = paths;
    await ensureDirPrivate(paths.dataDir);
    await ensureDirPrivate(paths.logsDir);
    await ensureDirPrivate(paths.tunnelDir);
    this.dataLock = await acquireDataLock(paths);
    if (this.hardenPermissions) {
      const rootPermissions = await hardenDirectory(paths.root);
      const dataPermissions = await hardenDirectory(paths.dataDir);
      const failure = !rootPermissions.ok ? rootPermissions : !dataPermissions.ok ? dataPermissions : null;
      if (failure) {
        this.permissionWarning = failure.error;
        if (process.platform === 'win32' && process.env.VEILLINK_ALLOW_INSECURE_ACL !== '1') {
          throw new Error(
            `无法收紧 VeilLink 目录 ACL: ${failure.error}. ` +
              '请以当前 Windows 用户运行 scripts/setup-acl.ps1；仅在明确接受风险时设置 VEILLINK_ALLOW_INSECURE_ACL=1。'
          );
        }
      }
    }

    this.secretBox = await SecretBox.load(paths);
    this.configStore = await ConfigStore.load(paths, this.secretBox);
    this.keyStore = await KeyStore.load(paths, this.secretBox);
    this.logStore = await LogStore.load(paths);
    this.adminAuth = new AdminAuth(paths);
    this.adminTokenInfo = await this.adminAuth.init();
    this.limiter = new SlidingWindowLimiter();
    this.concurrency = new ConcurrencyLimiter();
    this.globalConcurrency = new ConcurrencyLimiter();
    this.bodyBudget = new ByteBudget(128 * 1024 * 1024);
    this.responseBudget = new ByteBudget(1152 * 1024 * 1024);
    this.stats = {
      requestsTotal: 0,
      requestsOk: 0,
      requestsError: 0,
      active: 0,
      lastUpstream: null
    };
    this.sessions = new SessionStore();
    this.tunnelStatus = new TunnelStatus({ paths });
    this.tunnelStatus.start();

    const context = {
      configStore: this.configStore,
      keyStore: this.keyStore,
      logStore: this.logStore,
      adminAuth: this.adminAuth,
      limiter: this.limiter,
      concurrency: this.concurrency,
      globalConcurrency: this.globalConcurrency,
      bodyBudget: this.bodyBudget,
      responseBudget: this.responseBudget,
      activeKeyResponses: new Map(),
      tunnelStatus: this.tunnelStatus,
      stats: this.stats,
      startedAt: this.startedAt,
      adminPort: this.requestedAdminPort,
      publicPort: this.requestedPublicPort,
      getPublicPort: () => this.publicPort || this.requestedPublicPort,
      sessions: this.sessions
    };

    this.adminState = createAdminServer(context);
    this.adminServer = this.adminState.server;
    this.publicServer = configurePublicServer(createPublicServer(context));
    return this;
  }

  async start() {
    await this.init();
    await listen(this.adminServer, this.requestedAdminPort, '127.0.0.1');
    this.adminPort = this.adminServer.address().port;
    try {
      await listen(this.publicServer, this.requestedPublicPort, '127.0.0.1');
      this.publicPort = this.publicServer.address().port;
    } catch (error) {
      await closeServer(this.adminServer);
      throw error;
    }
    return this;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    let closeError = null;
    const closePart = async (operation) => {
      try {
        await operation();
      } catch (error) {
        closeError = closeError || error;
      }
    };
    try {
      await closePart(async () => this.sessions?.close());
      await closePart(() => closeServer(this.publicServer));
      await closePart(() => closeServer(this.adminServer));
      await closePart(() => this.tunnelStatus?.close());
      await closePart(async () => this.limiter?.close());
      await closePart(() => this.keyStore?.close());
      await closePart(() => this.logStore?.close());
    } finally {
      if (this.dataLock) {
        const lock = this.dataLock;
        this.dataLock = null;
        await releaseDataLock(lock);
      }
    }
    if (closeError) throw closeError;
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function createRuntime({
  dataDir = '',
  adminPort = 8787,
  publicPort = 8788,
  hardenPermissions = true
} = {}) {
  const resolvedDataDir = resolveDataDir(dataDir);
  const runtime = new Runtime({
    dataDir: resolvedDataDir,
    adminPort,
    publicPort,
    hardenPermissions
  });
  return runtime;
}
