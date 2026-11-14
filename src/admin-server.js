import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  APP_NAME,
  APP_VERSION,
  AppError,
  adminOriginAllowed,
  applySecurityHeaders,
  clientIp,
  hostHeaderAllowed,
  parseCookies,
  readJsonBody,
  requestId,
  sanitizeForLog,
  sendAdminError,
  writeJson
} from './util.js';
import {
  SessionStore,
  clearSessionCookie,
  sessionCookie
} from './sessions.js';
import { testUpstream } from './upstream/test.js';

const MAX_ADMIN_BODY = 1024 * 1024;
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/favicon.png', { file: 'favicon.png', type: 'image/png' }]
]);

function adminSecurityHeaders(res) {
  applySecurityHeaders(res);
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function methodIsMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
}

function isJsonRequest(req) {
  return String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.get('vl_session') || '';
}

async function readAdminJson(req) {
  if (!isJsonRequest(req)) {
    throw new AppError(415, 'invalid_request_type', 'Content-Type must be application/json.');
  }
  return readJsonBody(req, MAX_ADMIN_BODY);
}

function requireMutationGuard(req, res, adminPort) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendAdminError(res, 403, 'forbidden', 'Cross-site request rejected.');
    return false;
  }
  if (!adminOriginAllowed(req.headers.origin, adminPort)) {
    sendAdminError(res, 403, 'forbidden', 'Origin rejected.');
    return false;
  }
  if (methodIsMutation(req.method) && !req.headers['x-veillink-csrf']) {
    sendAdminError(res, 403, 'forbidden', 'Missing CSRF header.');
    return false;
  }
  return true;
}

async function requireSession(req, res, sessions, adminAuth) {
  const token = sessionFromRequest(req);
  try {
    await adminAuth.reloadIfChanged();
  } catch {
    writeJson(res, 401, {
      error: { code: 'login_required', message: '管理凭据已变更，请重新登录。' }
    });
    return null;
  }
  const session = sessions.get(token, adminAuth.revision);
  if (!session) {
    writeJson(res, 401, {
      error: { code: 'login_required', message: '登录已失效，请重新输入管理令牌。' }
    });
    return null;
  }
  const csrf = String(req.headers['x-veillink-csrf'] || '');
  if (!session.csrfToken || csrf !== session.csrfToken) {
    writeJson(res, 403, {
      error: { code: 'csrf_failed', message: 'CSRF 校验失败，请重新登录。' }
    });
    return null;
  }
  return { token, session };
}

export function createAdminServer(context) {
  const {
    configStore,
    keyStore,
    logStore,
    adminAuth,
    limiter,
    stats,
    startedAt,
    adminPort,
    getPublicPort,
    sessions = new SessionStore()
  } = context;
  const state = { sessions };

  const server = http.createServer({ maxHeaderSize: 32 * 1024 }, async (req, res) => {
    const id = requestId();
    const ip = clientIp(req, { trustForwarded: false });
    const actualAdminPort = server.address()?.port || adminPort;
    adminSecurityHeaders(res);
    res.setHeader('request-id', id);

    if (!hostHeaderAllowed(req.headers.host, actualAdminPort)) {
      sendAdminError(res, 403, 'forbidden', 'This listener only accepts loopback administration requests.');
      return;
    }
    if (!requireMutationGuard(req, res, actualAdminPort)) return;

    const pathname = (() => {
      try {
        return new URL(req.url || '/', `http://127.0.0.1:${actualAdminPort}`).pathname;
      } catch {
        return null;
      }
    })();
    if (!pathname) {
      sendAdminError(res, 400, 'bad_request', 'Invalid request path.');
      return;
    }

    try {
      if (pathname === '/admin/api/login' && req.method === 'POST') {
        if (req.headers['x-veillink-csrf'] !== '1') {
          sendAdminError(res, 403, 'forbidden', 'Missing CSRF header.');
          return;
        }
        if (limiter.blocked(`adminlogin:${ip}`, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS)) {
          sendAdminError(res, 429, 'too_many_attempts', '尝试次数过多，请稍后再试。');
          return;
        }
        const body = await readAdminJson(req);
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const valid = token ? await adminAuth.verify(token) : false;
        if (!valid) {
          limiter.take(`adminlogin:${ip}`, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS);
          logStore.audit('管理员登录失败', { ip });
          sendAdminError(res, 401, 'invalid_token', '管理令牌不正确。');
          return;
        }
        const created = state.sessions.create(ip, adminAuth.revision);
        res.setHeader('Set-Cookie', sessionCookie(created.token, created.maxAgeSeconds));
        logStore.audit('管理员登录', { ip });
        writeJson(res, 200, { ok: true, csrfToken: created.csrfToken });
        return;
      }

      if (pathname === '/admin/api/logout' && req.method === 'POST') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        state.sessions.destroy(auth.token);
        res.setHeader('Set-Cookie', clearSessionCookie());
        logStore.audit('管理员退出', { ip });
        writeJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/admin/api/state' && req.method === 'GET') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        writeJson(res, 200, {
          app: {
            name: APP_NAME,
            version: APP_VERSION,
            node: process.version
          },
          server: {
            startedAt,
            now: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            adminUrl: `http://127.0.0.1:${actualAdminPort}`,
            adminPort: actualAdminPort,
            publicPort: typeof getPublicPort === 'function' ? getPublicPort() : null,
            dataDir: path.basename(configStore.paths.dataDir)
          },
          upstream: configStore.safeSnapshot(),
          public: {
            baseUrl: configStore.config.public.baseUrl
          },
          limits: { ...configStore.limits },
          stats: sanitizeForLog({
            requestsTotal: stats.requestsTotal,
            requestsOk: stats.requestsOk,
            requestsError: stats.requestsError,
            active: stats.active,
            lastUpstream: stats.lastUpstream
          }),
          keys: keyStore.list(),
          logs: logStore.list(150),
          security: {
            deviceHeader: 'X-VeilLink-Device',
            machineHint: os.hostname(),
            adminTokenFile: path.join(
              path.basename(configStore.paths.dataDir),
              'ADMIN_TOKEN.txt'
            ),
            adminTokenFileMatches: adminAuth.info?.tokenFileMatches === true,
            unreadableKeys: keyStore.unreadableCount || 0
          }
        });
        return;
      }

      if (pathname === '/admin/api/config' && req.method === 'PUT') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        const body = await readAdminJson(req);
        const snapshot = await configStore.update(body);
        logStore.audit('更新网关配置', {
          ip,
          detail: sanitizeForLog({
            baseUrl: snapshot.baseUrl,
            protocol: snapshot.protocol,
            model: snapshot.model,
            hasApiKey: snapshot.hasApiKey
          })
        });
        writeJson(res, 200, { ok: true, upstream: snapshot, public: { baseUrl: configStore.config.public.baseUrl } });
        return;
      }

      if (pathname === '/admin/api/upstream/test' && req.method === 'POST') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        const result = await testUpstream(configStore.runtimeUpstream());
        stats.lastUpstream = {
          time: new Date().toISOString(),
          ok: result.ok,
          status: result.status || null,
          latencyMs: result.latencyMs,
          error: result.ok ? null : 'gateway test failed'
        };
        logStore.audit(result.ok ? '网关测试成功' : '网关测试失败', {
          ip,
          detail: sanitizeForLog({
            status: result.status,
            latencyMs: result.latencyMs,
            error: result.ok ? null : 'gateway test failed'
          })
        });
        writeJson(res, 200, result);
        return;
      }

      if (pathname === '/admin/api/keys' && req.method === 'POST') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        const body = await readAdminJson(req);
        const generated = await keyStore.generate({
          name: body.name,
          allowedDevice: body.allowedDevice
        });
        logStore.audit('生成 API 密钥', {
          ip,
          detail: { id: generated.record.id, name: generated.record.name, deviceBound: Boolean(generated.record.allowedDevice) }
        });
        writeJson(res, 200, { ok: true, key: generated.key, record: generated.record });
        return;
      }

      const keyAction = pathname.match(/^\/admin\/api\/keys\/(key_[A-Za-z0-9_-]+)\/(reveal|revoke)$/);
      if (keyAction && req.method === 'POST') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        const [, keyId, action] = keyAction;
        if (action === 'reveal') {
          const key = await keyStore.reveal(keyId);
          const record = keyStore.safe(keyId);
          logStore.audit('查看 API 密钥', { ip, detail: { id: keyId, name: record?.name || null } });
          writeJson(res, 200, { ok: true, key, record });
        } else {
          const record = await keyStore.revoke(keyId);
          logStore.audit('吊销 API 密钥', { ip, detail: { id: keyId, name: record.name } });
          writeJson(res, 200, { ok: true, record });
        }
        return;
      }

      if (pathname === '/admin/api/logs' && req.method === 'GET') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        const url = new URL(req.url || '/', `http://127.0.0.1:${actualAdminPort}`);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 150, 1), 500);
        writeJson(res, 200, { logs: logStore.list(limit) });
        return;
      }

      if (pathname === '/admin/api/logs/clear' && req.method === 'POST') {
        const auth = await requireSession(req, res, state.sessions, adminAuth);
        if (!auth) return;
        await logStore.clear();
        logStore.audit('清空请求日志', { ip });
        writeJson(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/admin/api/')) {
        sendAdminError(res, 404, 'not_found', 'Not found.');
        return;
      }

      if (req.method !== 'GET') {
        sendAdminError(res, 405, 'method_not_allowed', 'Method not allowed.');
        return;
      }

      const asset = STATIC_FILES.get(pathname);
      if (!asset) {
        sendAdminError(res, 404, 'not_found', 'Not found.');
        return;
      }
      const data = await fs.readFile(path.join(configStore.paths.webDir, asset.file));
      res.statusCode = 200;
      res.setHeader('Content-Type', asset.type);
      res.setHeader('Content-Length', data.length);
      res.end(data);
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(500, 'internal_error', 'Internal server error.', {
              internalDetail: error?.message || 'Unknown error'
            });
      if (!res.headersSent) {
        sendAdminError(res, appError.status, appError.type, appError.publicMessage);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 30_000;
  state.server = server;
  return state;
}
