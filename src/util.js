import crypto from 'node:crypto';
import net from 'node:net';

export const APP_NAME = 'VeilLink';
export const APP_VERSION = '1.2.1';

export const DEFAULT_ADMIN_PORT = 8787;
export const DEFAULT_PUBLIC_PORT = 8788;

export const KEY_PREFIX = 'sk-';
export const KEY_BODY_LENGTH = 56;
export const KEY_ALPHABET = '0123456789@#%&abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const DEFAULT_LIMITS = Object.freeze({
  bodyBytes: 100_000_000,
  requestsPerMinutePerKey: 240,
  concurrentPerKey: 12,
  globalConcurrent: 64,
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
    this.code = options.code || null;
    this.param = options.param || null;
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
  text = text.replace(
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9@#%&_-]{20,}(?![A-Za-z0-9@#%&_-])/g,
    'sk-[REDACTED]'
  );
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

const OPAQUE_STRING_KEYS = new Set([
  'encrypted_content',
  'b64_json'
]);
const OPAQUE_BINARY_PARENT_TYPES = new Set([
  'audio',
  'image',
  'video',
  'input_audio',
  'image_generation_call',
  'image_generation'
]);

function isOpaquePayloadField(key, parent) {
  const lower = String(key || '').toLowerCase();
  if (OPAQUE_STRING_KEYS.has(lower)) return true;
  if (lower !== 'data' && lower !== 'result') return false;
  if (!parent || typeof parent !== 'object') return false;
  return OPAQUE_BINARY_PARENT_TYPES.has(String(parent.type || '').toLowerCase());
}

function collectTextLikeValues(value, output, depth = 0) {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextLikeValues(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    // Opaque encrypted payloads and media bytes can contain arbitrary 3-gram
    // sequences. Scanning them produces false-positive credential alarms and
    // they cannot be reassembled into a meaningful upstream credential.
    if (isOpaquePayloadField(key, value)) continue;
    output.push(key);
    collectTextLikeValues(item, output, depth + 1);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fragmentPattern(secret) {
  const grams = new Set();
  for (let index = 0; index + 3 <= secret.length; index += 1) {
    grams.add(secret.slice(index, index + 3));
  }
  return new RegExp([...grams].map(escapeRegExp).join('|'), 'g');
}

function collectSecretFragments(text, secret, pattern, fragments) {
  if (typeof text !== 'string' || text.length < 3) return false;
  let added = false;
  for (const match of text.matchAll(pattern)) {
    let secretIndex = secret.indexOf(match[0]);
    while (secretIndex !== -1) {
      let length = 3;
      while (
        secretIndex + length < secret.length &&
        match.index + length < text.length &&
        text[match.index + length] === secret[secretIndex + length]
      ) {
        length += 1;
      }
      for (let fragmentLength = 3; fragmentLength <= length; fragmentLength += 1) {
        const fragment = secret.slice(secretIndex, secretIndex + fragmentLength);
        if (!fragments.has(fragment)) {
          fragments.add(fragment);
          added = true;
        }
      }
      secretIndex = secret.indexOf(match[0], secretIndex + 1);
    }
  }
  return added;
}

function fragmentsCanFormSecret(fragments, secret) {
  const reachable = new Array(secret.length + 1).fill(false);
  reachable[0] = true;
  for (let index = 0; index < secret.length; index += 1) {
    if (!reachable[index]) continue;
      for (const fragment of fragments) {
        if (fragment.length >= 1 && secret.startsWith(fragment, index)) {
          reachable[index + fragment.length] = true;
        }
      }
  }
  return reachable[secret.length];
}

export function assertNoSplitSecret(value, secret) {
  if (typeof secret !== 'string' || secret.length < 4) return;
  const strings = [];
  collectTextLikeValues(value, strings);
  if (strings.some((text) => text.includes(secret))) {
    // A contiguous echo is handled by the normal redaction path.
    return;
  }
  const joined = strings.join('');
  if (joined.includes(secret)) {
    throw new AppError(
      502,
      'api_error',
      'The local gateway response contained a protected credential.'
    );
  }
  const fragments = new Set();
  const pattern = fragmentPattern(secret);
  for (const text of strings) {
    if (text.length >= 1 && text.length <= 2 && secret.includes(text)) {
      fragments.add(text);
    }
    collectSecretFragments(text, secret, pattern, fragments);
  }
  if (fragmentsCanFormSecret(fragments, secret)) {
    throw new AppError(
      502,
      'api_error',
      'The local gateway response contained a protected credential.'
    );
  }
}

export class CrossFieldSecretGuard {
  constructor(secrets = []) {
    this.secrets = secrets.filter(
      (secret) => typeof secret === 'string' && secret.length >= 4
    );
    this.maxLength = this.secrets.reduce(
      (max, secret) => Math.max(max, secret.length),
      0
    );
    this.tail = '';
    this.fragments = new Set();
    this.patterns = this.secrets.map((secret) => ({
      secret,
      pattern: fragmentPattern(secret)
    }));
  }

  pushText(text) {
    if (!this.secrets.length || typeof text !== 'string' || !text) return;
    const combined = this.tail + text;
    for (const secret of this.secrets) {
      if (combined.includes(secret) || (text + this.tail).includes(secret)) {
        throw new AppError(
          502,
          'api_error',
          'The local gateway response contained a protected credential.'
        );
      }
    }
    for (const { secret, pattern } of this.patterns) {
      let added = false;
      if (text.length >= 1 && text.length <= 2 && secret.includes(text)) {
        this.fragments.add(text);
        added = true;
      }
      if (collectSecretFragments(text, secret, pattern, this.fragments)) {
        added = true;
      }
      if (added && fragmentsCanFormSecret(this.fragments, secret)) {
        throw new AppError(
          502,
          'api_error',
          'The local gateway response contained a protected credential.'
        );
      }
    }
    const holdback = Math.max(0, this.maxLength - 1);
    this.tail = holdback > 0 ? combined.slice(-holdback) : '';
  }

  pushValue(value) {
    if (!this.secrets.length) return;
    const strings = [];
    collectTextLikeValues(value, strings);
    for (const text of strings) this.pushText(text);
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

function scrubOpaqueString(input, secrets) {
  let text = String(input ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text;
}

export function scrubSecretsDeep(value, secrets = [], opaque = false) {
  if (typeof value === 'string') {
    return opaque
      ? scrubOpaqueString(value, secrets)
      : scrubSecretString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecretsDeep(item, secrets, opaque));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const lower = key.toLowerCase();
      const childOpaque =
        opaque ||
        lower === 'encrypted_content' ||
        lower === 'b64_json' ||
        ((lower === 'data' || lower === 'result') && typeof item === 'string');
      out[scrubSecretString(key, secrets)] = scrubSecretsDeep(
        item,
        secrets,
        childOpaque
      );
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
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Use HTTPS for non-loopback upstream gateways; plain HTTP is only allowed for localhost.'
    );
  }
  if (url.username || url.password) {
    throw new AppError(400, 'invalid_request_error', 'Credentials must not be embedded in the upstream URL.');
  }
  if (url.search || url.hash) {
    throw new AppError(400, 'invalid_request_error', 'Upstream base URL must not contain a query or fragment.');
  }
  const endpointPath = url.pathname.replace(/\/+$/, '');
  if (
    /\/(?:messages|responses|models|chat\/completions)(?:\/.*)?$/i.test(endpointPath) ||
    /\/(?:chat\/)?completions$/i.test(endpointPath)
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

export function isOpenAIProtocol(protocol) {
  return protocol === 'openai-responses' || protocol === 'openai-chat';
}

export function effectiveAuthMode(protocol, authMode) {
  if (authMode === 'none' || authMode === 'x-api-key' || authMode === 'bearer') {
    return authMode;
  }
  // Keep the historical auto behavior to avoid breaking compatible upstreams:
  // Anthropic accepts x-api-key, OpenAI uses Bearer. Users can explicitly
  // select bearer for Anthropic upstreams that require the newer header.
  return isOpenAIProtocol(protocol) ? 'bearer' : 'x-api-key';
}

function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function isLoopbackHost(host) {
  const normalized = String(host || '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1'
  );
}

function validIp(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  return net.isIP(candidate) ? candidate : '';
}

export function clientIp(req, { trustForwarded = true } = {}) {
  const remote = req.socket?.remoteAddress || '';
  if (!isLoopbackAddress(remote) || !trustForwarded) return remote || 'unknown';
  // Only Cloudflare's authoritative header is trusted from the loopback
  // tunnel. Client-supplied X-Forwarded-For values are not rate-limit keys.
  const cf = validIp(req.headers['cf-connecting-ip']);
  if (cf) return cf;
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

export function sendOpenAIError(res, error, id = '') {
  const status = Number.isInteger(error.status) ? error.status : 500;
  let type = asString(error.type, 'api_error');
  let code = error.code || null;
  if (type === 'request_too_large') {
    type = 'invalid_request_error';
    code = code || 'request_too_large';
  } else if (type === 'overloaded_error') {
    type = 'api_error';
    code = code || 'overloaded';
  }
  const message = asString(error.publicMessage || error.message, 'Request failed.');
  const headers = { ...(error.headers || {}) };
  if (id) {
    headers['request-id'] = id;
    headers['x-request-id'] = id;
  }
  if (error.close) headers.Connection = 'close';
  writeJson(res, status, {
    error: {
      message: redactSecrets(message),
      type,
      param: error.param || null,
      code
    }
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

export async function readOptionalJsonBody(req, limit, lease = null) {
  const buffer = await readBody(req, limit, lease);
  if (!buffer.length) return null;
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

export async function closeServer(server, { graceMs = 5000 } = {}) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        // Older Node versions may not expose this helper.
      }
      finish();
    }, graceMs);
    timer.unref?.();
    server.close(() => finish());
  });
}
