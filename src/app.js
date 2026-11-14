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
import { ByteBudget, closeServer, nowIso } from './util.js';

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
    this.bodyBudget = new ByteBudget(128 * 1024 * 1024);
    this.stats = {
      requestsTotal: 0,
      requestsOk: 0,
      requestsError: 0,
      active: 0,
      lastUpstream: null
    };
    this.sessions = new SessionStore();

    const context = {
      configStore: this.configStore,
      keyStore: this.keyStore,
      logStore: this.logStore,
      adminAuth: this.adminAuth,
      limiter: this.limiter,
      concurrency: this.concurrency,
      bodyBudget: this.bodyBudget,
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
    this.sessions?.close();
    await closeServer(this.publicServer);
    await closeServer(this.adminServer);
    this.limiter?.close();
    await this.keyStore?.close();
    await this.logStore?.close();
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
