import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_METRICS_PORT = 20241;

function requestReady(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/ready',
          timeout: timeoutMs,
          headers: { accept: 'application/json' }
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size <= 64 * 1024) chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode !== 200) {
              finish({ ok: false, error: `HTTP ${response.statusCode}` });
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              const body = JSON.parse(text);
              const count = Number(
                body?.readyConnections ?? body?.ready_connections ?? 0
              );
              finish({
                ok: true,
                readyConnections: Number.isFinite(count) ? Math.max(0, count) : 0
              });
            } catch {
              const match = text.match(/readyConnections["'\s:=]+(\d+)/i);
              if (match) {
                finish({ ok: true, readyConnections: Number(match[1]) || 0 });
              } else {
                finish({ ok: false, error: 'Invalid /ready response' });
              }
            }
          });
          response.on('error', (error) => finish({ ok: false, error: error.message }));
        }
      );
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    req.on('error', (error) => finish({ ok: false, error: error.message }));
  });
}

export class TunnelStatus {
  constructor({
    paths,
    metricsPort = Number(process.env.VEILLINK_TUNNEL_METRICS_PORT) || DEFAULT_METRICS_PORT,
    refreshMs = 5000
  }) {
    this.paths = paths;
    const parsedPort = Number(metricsPort);
    this.metricsPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_METRICS_PORT;
    this.refreshMs = refreshMs;
    this.state = {
      mode: 'unknown',
      enabled: false,
      available: false,
      readyConnections: 0,
      checkedAt: null,
      lastError: '',
      metricsPort: this.metricsPort
    };
    this.timer = null;
    this.inFlight = null;
  }

  async readStateFile() {
    try {
      const text = await fs.readFile(
        path.join(this.paths.dataDir, 'tunnel-state.json'),
        'utf8'
      );
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  stateFileFresh(stateFile) {
    if (!stateFile || typeof stateFile.updatedAt !== 'string') return false;
    const updated = Date.parse(stateFile.updatedAt);
    if (!Number.isFinite(updated)) return false;
    const age = Date.now() - updated;
    return age >= -5_000 && age <= 30_000;
  }

  async detectEnabled() {
    try {
      await fs.access(path.join(this.paths.tunnelDir, 'config.yml'));
      await fs.access(path.join(this.paths.root, 'bin', 'cloudflared.exe'));
      return true;
    } catch {
      return false;
    }
  }

  async detectResidualTunnel() {
    try {
      const raw = await fs.readFile(
        path.join(this.paths.dataDir, 'cloudflared.pid'),
        'utf8'
      );
      const pid = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code === 'EPERM';
      }
    } catch {
      return false;
    }
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const stateFile = await this.readStateFile();
      const enabled = await this.detectEnabled();
      if (stateFile?.mode === 'disabled') {
        if (await this.detectResidualTunnel()) {
          this.state = {
            mode: 'error',
            enabled: true,
            available: false,
            readyConnections: 0,
            checkedAt: new Date().toISOString(),
            lastError: 'A cloudflared process is still running while the tunnel is disabled.',
            metricsPort: this.metricsPort
          };
          return this.state;
        }
        this.state = {
          mode: 'disabled',
          enabled: false,
          available: false,
          readyConnections: 0,
          checkedAt: new Date().toISOString(),
          lastError: typeof stateFile.error === 'string' ? stateFile.error : '',
          metricsPort: this.metricsPort
        };
        return this.state;
      }
      if (stateFile?.mode === 'error') {
        this.state = {
          mode: 'error',
          enabled: true,
          available: false,
          readyConnections: 0,
          checkedAt: new Date().toISOString(),
          lastError: typeof stateFile.error === 'string' && stateFile.error
            ? stateFile.error
            : 'Tunnel reported an error.',
          metricsPort: this.metricsPort
        };
        return this.state;
      }
      if (!enabled) {
        if (await this.detectResidualTunnel()) {
          this.state = {
            mode: 'error',
            enabled: true,
            available: false,
            readyConnections: 0,
            checkedAt: new Date().toISOString(),
            lastError: 'A cloudflared process is still running while the tunnel config is missing.',
            metricsPort: this.metricsPort
          };
          return this.state;
        }
        this.state = {
          mode: 'disabled',
          enabled: false,
          available: false,
          readyConnections: 0,
          checkedAt: new Date().toISOString(),
          lastError: '',
          metricsPort: this.metricsPort
        };
        return this.state;
      }
      const result = await requestReady(this.metricsPort);
      const fresh = this.stateFileFresh(stateFile);
      const stale = stateFile?.mode === 'running' && !fresh;
      const ready = Boolean(result.ok && result.readyConnections > 0);
      let lastError = '';
      if (stale) {
        lastError = 'Watchdog heartbeat is stale.';
      } else if (!result.ok) {
        lastError = stateFile && typeof stateFile.error === 'string' && stateFile.error
          ? stateFile.error
          : (result.error || 'unavailable');
      }
      this.state = {
        mode: stale ? 'unknown' : 'running',
        enabled: true,
        available: ready && !stale,
        readyConnections: result.readyConnections || 0,
        checkedAt: new Date().toISOString(),
        lastError,
        metricsPort: this.metricsPort
      };
      return this.state;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.refreshMs);
    this.timer.unref?.();
  }

  snapshot() {
    return { ...this.state };
  }

  async close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => {});
  }
}
