import crypto from 'node:crypto';
import net from 'node:net';

export const APP_NAME = 'VeilLink';
export const APP_VERSION = '1.0.0';

export const DEFAULT_ADMIN_PORT = 8787;
export const DEFAULT_PUBLIC_PORT = 8788;

export const KEY_PREFIX = 'sk-';
export const KEY_BODY_LENGTH = 24;
export const KEY_ALPHABET = '0123456789@#%&abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const DEFAULT_LIMITS = Object.freeze({
  bodyBytes: 100_000_000,
  requestsPerMinutePerKey: 120,
  concurrentPerKey: 6,
  requestsPerMinutePerIp: 600,
  authFailuresPerTenMinutesPerIp: 30
});

export class AppError extends Error {
  constructor(status, type, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.type = type;
    this.publicMessage = options.publicMessage || message;
    this.internalDetail = options.internalDetail || '';
    this.headers = options.headers || {};
    this.close = options.close === true;
  }
}

export function requestId() {
  return `vl_${crypto.randomBytes(12).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function nowMs() {
  return Date.now();
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function sanitizeText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  text = text.replace(/\bsk-[A-Za-z0-9@#%&_-]{20,}\b/g, 'sk-[REDACTED]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [REDACTED]');
  text = text.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"']+/gi, '$1[REDACTED]');
  text = text.replace(/(x-api-key\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
  return text;
}

export function redactKnownSecret(value, secret) {
  let text = String(value ?? '');
  if (typeof secret === 'string' && secret.length >= 4) {
    text = text.split(secret).join('[REDACTED]');
  }
  return redactSecrets(text);
}

export class StreamingSecretScrubber {
  constructor(secrets = []) {
    this.secrets = secrets.filter(
      (secret) => typeof secret === 'string' && secret.length >= 4
    );
    this.maxLength = this.secrets.reduce(
      (max, secret) => Math.max(max, secret.length),
      0
    );
    this.buffer = '';
  }

  push(text) {
    if (typeof text !== 'string' || !text) return '';
    if (!this.secrets.length) return text;
    this.buffer += text;
    for (const secret of this.secrets) {
      this.buffer = this.buffer.split(secret).join('[REDACTED]');
    }
    let holdback = 0;
    for (const secret of this.secrets) {
      const max = Math.min(secret.length - 1, this.buffer.length);
      for (let length = max; length > 0; length -= 1) {
        if (this.buffer.endsWith(secret.slice(0, length))) {
          holdback = Math.max(holdback, length);
          break;
        }
      }
    }
    if (this.buffer.length <= holdback) return '';
    const output = this.buffer.slice(0, this.buffer.length - holdback);
    this.buffer = holdback > 0 ? this.buffer.slice(-holdback) : '';
    return output;
  }

  flush() {
    let output = this.buffer;
    this.buffer = '';
    for (const secret of this.secrets) {
      output = output.split(secret).join('[REDACTED]');
    }
    return output;
  }
}

function collectTextLikeValues(value, output, depth = 0) {
  if (depth > 20 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTextLikeValues(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (typeof value.text === 'string') output.push(value.text);
  if (typeof value.thinking === 'string') output.push(value.thinking);
  if (typeof value.signature === 'string') output.push(value.signature);
  if (typeof value.partial_json === 'string') output.push(value.partial_json);
  if (typeof value.arguments === 'string') output.push(value.arguments);
  for (const key of ['content', 'delta', 'message', 'choices', 'input']) {
    if (value[key]) collectTextLikeValues(value[key], output, depth + 1);
  }
}

export function assertNoSplitSecret(value, secret) {
  if (typeof secret !== 'string' || secret.length < 4) return;
  const strings = [];
  collectTextLikeValues(value, strings);
  if (strings.some((text) => text.includes(secret))) {
    // A contiguous echo is handled by the normal redaction path.
    return;
  }
  if (strings.join('').includes(secret)) {
    throw new AppError(
      502,
      'api_error',
      'The local gateway response contained a protected credential.'
    );
  }
}

function scrubSecretString(input, secrets) {
  let text = String(input ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return redactSecrets(text);
}

export function scrubSecretsDeep(value, secrets = []) {
  if (typeof value === 'string') {
    return scrubSecretString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecretsDeep(item, secrets));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[scrubSecretString(key, secrets)] = scrubSecretsDeep(item, secrets);
    }
    return out;
  }
  return value;
}

export function sanitizeForLog(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value).slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeForLog(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (/^(api[-_]?key(enc)?|authorization|secret(enc)?|password|cookie|token)$/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeForLog(item, depth + 1);
      }
    }
    return out;
  }
  return '[unserializable]';
}

export function validateBaseUrl(raw, { allowEmpty = true } = {}) {
  const text = asString(raw).trim();
  if (!text) {
    if (allowEmpty) return '';
    throw new AppError(400, 'invalid_request_error', 'Upstream base URL is required.');
  }
  if (text.length > 500) {
    throw new AppError(400, 'invalid_request_error', 'Upstream base URL is too long.');
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new AppError(400, 'invalid_request_error', 'Upstream base URL is not a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'invalid_request_error', 'Upstream base URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new AppError(400, 'invalid_request_error', 'Credentials must not be embedded in the upstream URL.');
  }
  if (url.search || url.hash) {
    throw new AppError(400, 'invalid_request_error', 'Upstream base URL must not contain a query or fragment.');
  }
  const endpointPath = url.pathname.replace(/\/+$/, '');
  if (
    /\/messages(?:\/count_tokens)?$/i.test(endpointPath) ||
    /\/(?:chat\/)?completions$/i.test(endpointPath) ||
    /\/(?:responses|embeddings|models)$/i.test(endpointPath)
  ) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Use the base URL only, not a full API endpoint path.'
    );
  }

  return text.replace(/\/+$/, '');
}

export function buildUpstreamUrl(baseUrl, endpointPath, search = '') {
  const base = new URL(baseUrl);
  const endpoint = endpointPath.replace(/^\/+/, '');
  let path = base.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1') && endpoint.startsWith('v1/')) {
    path = `${path}/${endpoint.slice(3)}`;
  } else {
    path = `${path}/${endpoint}`;
  }
  base.pathname = path.replace(/\/{2,}/g, '/');
  base.search = search || '';
  base.hash = '';
  return base;
}

export function effectiveAuthMode(protocol, authMode) {
  if (authMode === 'none' || authMode === 'x-api-key' || authMode === 'bearer') {
    return authMode;
  }
  return protocol === 'openai' ? 'bearer' : 'x-api-key';
}

function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function validIp(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  return net.isIP(candidate) ? candidate : '';
}

export function clientIp(req, { trustForwarded = true } = {}) {
  const remote = req.socket?.remoteAddress || '';
  if (!isLoopbackAddress(remote) || !trustForwarded) return remote || 'unknown';
  const cf = validIp(req.headers['cf-connecting-ip']);
  if (cf) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = validIp(xff.split(',')[0]);
    if (first) return first;
  }
  return remote || 'unknown';
}

export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string' || !header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export function hostHeaderAllowed(host, port) {
  if (typeof host !== 'string' || !host) return false;
  const lower = host.toLowerCase();
  return (
    lower === `127.0.0.1:${port}` ||
    lower === `localhost:${port}` ||
    lower === `[::1]:${port}`
  );
}

export function adminOriginAllowed(origin, port) {
  if (!origin) return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://[::1]:${port}`
  );
}

export function applySecurityHeaders(res, { hsts = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (hsts) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

export function writeJson(res, status, payload, headers = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  res.end(body);
}

export function sendAnthropicError(res, error, id = '') {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const type = asString(error.type, 'api_error');
  const message = asString(error.publicMessage || error.message, 'Request failed.');
  const headers = { ...(error.headers || {}) };
  if (id) headers['request-id'] = id;
  if (error.close) headers.Connection = 'close';
  writeJson(res, status, {
    type: 'error',
    error: {
      type,
      message: redactSecrets(message)
    },
    request_id: id || undefined
  }, headers);
}

export function sendAdminError(res, status, code, message) {
  writeJson(res, status, {
    error: {
      code,
      message: redactSecrets(message)
    }
  });
}

export class ByteBudget {
  constructor(limitBytes) {
    this.limitBytes = limitBytes;
    this.usedBytes = 0;
  }

  reserve(bytes) {
    const amount = Number(bytes) || 0;
    if (amount <= 0) return true;
    if (this.usedBytes + amount > this.limitBytes) return false;
    this.usedBytes += amount;
    return true;
  }

  release(bytes) {
    const amount = Number(bytes) || 0;
    if (amount <= 0) return;
    this.usedBytes = Math.max(0, this.usedBytes - amount);
  }
}

export function createBodyLease(budget) {
  let reserved = 0;
  return {
    reserve(bytes) {
      if (!budget.reserve(bytes)) return false;
      reserved += Number(bytes) || 0;
      return true;
    },
    release() {
      budget.release(reserved);
      reserved = 0;
    },
    get bytes() {
      return reserved;
    }
  };
}

export function readBody(req, limit, lease = null) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new AppError(413, 'request_too_large', 'Request body is too large.', {
        publicMessage: `Request body exceeds the ${limit} byte limit.`,
        close: true
      }));
      return;
    }

    let size = 0;
    let settled = false;
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.resume();
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) return;
      if (lease && !lease.reserve(chunk.length)) {
        fail(new AppError(429, 'rate_limit_error', 'Server is busy.', {
          publicMessage: 'The server is temporarily busy processing another large request. Retry shortly.',
          headers: { 'Retry-After': '2' },
          close: true
        }));
        return;
      }
      size += chunk.length;
      if (size > limit) {
        fail(new AppError(413, 'request_too_large', 'Request body is too large.', {
          publicMessage: `Request body exceeds the ${limit} byte limit.`,
          close: true
        }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error) => fail(new AppError(400, 'invalid_request_error', 'Request body could not be read.', {
      internalDetail: error.message
    }));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', () => fail(new AppError(400, 'invalid_request_error', 'Client disconnected.')));
  });
}

export async function readJsonBody(req, limit, lease = null) {
  const buffer = await readBody(req, limit, lease);
  if (!buffer.length) {
    throw new AppError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new AppError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  if (!isPlainObject(value)) {
    throw new AppError(400, 'invalid_request_error', 'Request body must be a JSON object.');
  }
  return value;
}

export function approxTextTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateInputTokens(body) {
  let total = 0;

  const visitContent = (content) => {
    if (typeof content === 'string') {
      total += approxTextTokens(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        total += approxTextTokens(block.text);
      } else if (block.type === 'image') {
        total += 1600;
      } else if (block.type === 'document') {
        total += 2500;
      } else if (block.type === 'video') {
        total += 5000;
      } else if (block.type === 'tool_use') {
        total += approxTextTokens(block.name || '') + approxTextTokens(JSON.stringify(block.input || {}));
      } else if (block.type === 'tool_result') {
        visitContent(block.content);
      } else if (block.type === 'thinking') {
        total += approxTextTokens(block.thinking);
      } else {
        total += approxTextTokens(JSON.stringify(block));
      }
    }
  };

  if (Array.isArray(body?.system)) visitContent(body.system);
  else if (typeof body?.system === 'string') total += approxTextTokens(body.system);

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      visitContent(message?.content);
      total += 4;
    }
  }
  if (Array.isArray(body?.tools)) {
    total += approxTextTokens(JSON.stringify(body.tools));
  }
  return Math.max(1, total);
}

export async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}
