import http from 'node:http';
import {
  AppError,
  applySecurityHeaders,
  clientIp,
  createBodyLease,
  nowMs,
  readJsonBody,
  requestId,
  sendAnthropicError,
  writeJson
} from './util.js';
import { proxyAnthropic } from './upstream/anthropic.js';
import { proxyOpenAI } from './upstream/openai.js';

function parseTarget(req) {
  try {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    return { path: parsed.pathname, search: parsed.search || '' };
  } catch {
    return null;
  }
}

function routeFor(path, method) {
  if (path === '/v1/messages') {
    return method === 'POST' ? { kind: 'messages' } : { kind: 'method', allow: 'POST' };
  }
  if (path === '/v1/messages/count_tokens') {
    return method === 'POST' ? { kind: 'count_tokens' } : { kind: 'method', allow: 'POST' };
  }
  if (path === '/v1/models') {
    return method === 'GET' ? { kind: 'models' } : { kind: 'method', allow: 'GET' };
  }
  return null;
}

function extractApiKeys(req) {
  const candidates = [];
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    candidates.push(xApiKey.trim());
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) candidates.push(match[1].trim());
  }
  return [...new Set(candidates)];
}

function extractDevice(req) {
  const value = req.headers['x-veillink-device'];
  if (typeof value === 'string') return value.trim();
  return '';
}

function safeWriteError(res, error, id) {
  if (res.destroyed) return;
  sendAnthropicError(res, error, id);
}

export function createPublicServer(context) {
  const { configStore, keyStore, logStore, limiter, concurrency, bodyBudget, stats } = context;

  return http.createServer({ maxHeaderSize: 32 * 1024 }, async (req, res) => {
    const id = requestId();
    const started = nowMs();
    const ip = clientIp(req);
    const parsedTarget = parseTarget(req);
    let keyRecord = null;
    let meta = {};
    let logError = null;
    let acquiredKey = false;
    let bodyLease = null;
    const limits = configStore.limits;

    applySecurityHeaders(res, { hsts: true });
    res.setHeader('request-id', id);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');

    stats.requestsTotal += 1;
    stats.active += 1;

    try {
      if (!parsedTarget) {
        throw new AppError(400, 'invalid_request_error', 'Invalid request target.');
      }
      const { path, search } = parsedTarget;

      // Rate-limit every public request, including unknown paths and OPTIONS,
      // so an unauthenticated client cannot use the 404 path to flood logs.
      const ipLimit = limiter.take(`ip:${ip}`, limits.requestsPerMinutePerIp, 60_000);
      if (!ipLimit.allowed) {
        throw new AppError(429, 'rate_limit_error', 'Too many requests.', {
          headers: { 'Retry-After': String(ipLimit.retryAfterSeconds) }
        });
      }

      if (req.method === 'OPTIONS') {
        const route = routeFor(path, 'POST') || routeFor(path, 'GET');
        if (!route) throw new AppError(404, 'not_found_error', 'Not found.');
        res.statusCode = 204;
        res.setHeader('Allow', path === '/v1/models' ? 'GET, OPTIONS' : 'POST, OPTIONS');
        res.end();
        stats.requestsOk += 1;
        return;
      }

      const route = routeFor(path, req.method);
      if (!route) {
        throw new AppError(404, 'not_found_error', 'Not found.');
      }
      if (route.kind === 'method') {
        res.setHeader('Allow', route.allow);
        throw new AppError(405, 'invalid_request_error', 'Method not allowed.');
      }

      const candidates = extractApiKeys(req);
      let auth = { ok: false, reason: 'missing' };
      for (const candidate of candidates) {
        auth = keyStore.authenticate(candidate);
        if (auth.ok) break;
      }

      if (!auth.ok) {
        const failureLimit = limiter.take(
          `authfail:${ip}`,
          limits.authFailuresPerTenMinutesPerIp,
          10 * 60_000
        );
        if (!failureLimit.allowed) {
          throw new AppError(429, 'rate_limit_error', 'Too many failed authentication attempts.', {
            headers: { 'Retry-After': String(failureLimit.retryAfterSeconds) }
          });
        }
        logError = auth.reason === 'revoked' ? 'Revoked API key' : 'Invalid API key';
        throw new AppError(401, 'authentication_error', 'Invalid API key.');
      }

      keyRecord = auth.record;
      if (!keyStore.deviceAllowed(keyRecord, extractDevice(req))) {
        logError = 'Device header mismatch';
        throw new AppError(403, 'permission_error', 'This device is not authorized for the API key.');
      }

      const keyRate = limiter.take(
        `key:${keyRecord.id}`,
        limits.requestsPerMinutePerKey,
        60_000
      );
      if (!keyRate.allowed) {
        throw new AppError(429, 'rate_limit_error', 'API key rate limit exceeded.', {
          headers: { 'Retry-After': String(keyRate.retryAfterSeconds) }
        });
      }
      if (!concurrency.acquire(keyRecord.id, limits.concurrentPerKey)) {
        throw new AppError(429, 'rate_limit_error', 'Too many concurrent requests for this API key.', {
          headers: { 'Retry-After': '2' }
        });
      }
      acquiredKey = true;

      keyStore.touch(keyRecord, ip);
      const upstream = configStore.runtimeUpstream();
      if (!upstream.configured) {
        throw new AppError(503, 'api_error', 'The local gateway is not configured yet.');
      }
      if (upstream.protocol === 'openai' && !upstream.model) {
        throw new AppError(503, 'api_error', 'The upstream model is not configured.');
      }

      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      let body = null;
      if (route.kind !== 'models') {
        if (!contentType.startsWith('application/json')) {
          throw new AppError(415, 'invalid_request_error', 'Content-Type must be application/json.');
        }
        bodyLease = createBodyLease(bodyBudget);
        body = await readJsonBody(req, limits.bodyBytes, bodyLease);
        if (typeof body.model === 'string') meta.model = body.model;
        meta.stream = body.stream === true;
      }

      const proxy =
        upstream.protocol === 'openai'
          ? proxyOpenAI
          : proxyAnthropic;
      meta = {
        ...meta,
        ...(await proxy({
          req,
          res,
          path,
          search,
          body,
          upstream,
          requestId: id
        }))
      };

      if (meta.status && meta.status < 400 && !meta.error) stats.requestsOk += 1;
      else stats.requestsError += 1;
      if (meta.upstreamStatus || meta.status < 500) {
        stats.lastUpstream = {
          time: new Date().toISOString(),
          ok: !meta.error && (!meta.status || meta.status < 400),
          status: meta.upstreamStatus || meta.status || null,
          latencyMs: nowMs() - started,
          error: meta.error || null,
          detail: meta.upstreamStatus ? `Upstream HTTP ${meta.upstreamStatus}` : null
        };
      }
    } catch (error) {
      stats.requestsError += 1;
      const appError =
        error instanceof AppError
          ? error
          : new AppError(500, 'api_error', 'Internal server error.', {
              internalDetail: error?.message || 'Unknown error'
            });
      logError = appError.type || logError || 'api_error';
      if (appError.status >= 500 && error instanceof AppError) {
        stats.lastUpstream = {
          time: new Date().toISOString(),
          ok: false,
          status: appError.status,
          latencyMs: nowMs() - started,
          error: appError.type,
          detail: null
        };
      }
      if (!res.headersSent) {
        safeWriteError(res, appError, id);
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } finally {
      bodyLease?.release();
      if (acquiredKey && keyRecord) concurrency.release(keyRecord.id);
      stats.active = Math.max(0, stats.active - 1);
      const durationMs = nowMs() - started;
      let status = res.statusCode;
      if (res.destroyed && !res.writableEnded) status = 499;
      logStore.add({
        id,
        kind: 'request',
        method: req.method,
        path: parsedTarget?.path || '',
        status,
        durationMs,
        keyId: keyRecord?.id || null,
        keyName: keyRecord?.name || null,
        ip,
        model: meta.model || null,
        stream: meta.stream === true,
        inputTokens: meta.inputTokens ?? null,
        outputTokens: meta.outputTokens ?? null,
        upstreamStatus: meta.upstreamStatus ?? null,
        error: logError || meta.error || (status >= 400 ? 'Request failed' : null)
      });
    }
  });
}

export function configurePublicServer(server) {
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  return server;
}
