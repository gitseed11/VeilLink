import zlib from 'node:zlib';
import {
  APP_VERSION,
  assertNoSplitSecret,
  redactKnownSecret,
  redactSecrets
} from '../util.js';

const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ANTHROPIC_VERSION = '2026-10-21';

// Only fixed, standard advisory header names are forwarded. Arbitrary
// upstream header names could carry an encoded credential in the name itself.
const SAFE_RATE_LIMIT_HEADER = /^(?:retry-after|x-ratelimit-(?:limit|remaining|reset)(?:-(?:requests|tokens))?|anthropic-ratelimit-(?:requests|tokens|input-tokens|output-tokens)-(?:limit|remaining|reset))$/;

// Rate-limit values are numbers, durations, or timestamps. Reject anything
// else so an upstream cannot smuggle an encoded credential through a value.
const SAFE_RATE_LIMIT_VALUE = [
  /^\d+(?:\.\d+)?$/,
  /^\d+(?:\.\d+)?(?:ms|s|m|h|d)(?:\s*\d+(?:\.\d+)?(?:ms|s|m|h|d))*$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/
];

function isSafeRateLimitValue(value) {
  return SAFE_RATE_LIMIT_VALUE.some((pattern) => pattern.test(value));
}

function headerValue(value) {
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : '';
}

export function upstreamAuthHeaders(upstream) {
  const headers = {};
  if (upstream.apiKey) {
    if (upstream.authMode === 'bearer') {
      headers.Authorization = `Bearer ${upstream.apiKey}`;
    } else if (upstream.authMode === 'x-api-key') {
      headers['x-api-key'] = upstream.apiKey;
    }
  }
  return headers;
}

export function anthropicUpstreamHeaders(req, upstream, { stream = false, hasBody = true } = {}) {
  const clientAgent = headerValue(req?.headers?.['user-agent']).slice(0, 160);
  const headers = {
    accept: stream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'identity',
    'anthropic-version':
      headerValue(req?.headers?.['anthropic-version']) || DEFAULT_ANTHROPIC_VERSION,
    'user-agent': `VeilLink/${APP_VERSION}${clientAgent ? ` (${clientAgent})` : ''}`,
    ...upstreamAuthHeaders(upstream)
  };
  if (hasBody) headers['content-type'] = 'application/json';
  const beta = headerValue(req?.headers?.['anthropic-beta']);
  if (beta) headers['anthropic-beta'] = beta;
  const app = headerValue(req?.headers?.['x-app']);
  if (app) headers['x-app'] = app;
  return headers;
}

export function openaiUpstreamHeaders(req, upstream, { stream = false, hasBody = true } = {}) {
  const clientAgent = headerValue(req?.headers?.['user-agent']).slice(0, 160);
  const headers = {
    accept: stream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'identity',
    'user-agent': `VeilLink/${APP_VERSION}${clientAgent ? ` (${clientAgent})` : ''}`,
    ...upstreamAuthHeaders(upstream)
  };
  if (hasBody) headers['content-type'] = 'application/json';
  const beta = headerValue(req?.headers?.['openai-beta']);
  if (beta) headers['openai-beta'] = beta;
  return headers;
}

export function rateLimitHeaders(headers, secret = '') {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (!SAFE_RATE_LIMIT_HEADER.test(lower)) continue;
    // Header names are forwarded too; an upstream must not be able to put
    // the credential itself into the name while the value passes cleanly.
    const safeName = redactKnownSecret(lower, secret);
    if (safeName !== lower || safeName.includes('[REDACTED]')) continue;
    const text = redactKnownSecret(String(value), secret);
    if (!text.includes('[REDACTED]') && isSafeRateLimitValue(text)) {
      out[safeName] = text;
    }
  }
  if (secret) {
    try {
      assertNoSplitSecret(out, secret);
    } catch {
      // These headers are advisory only. Drop the whole set rather than risk
      // letting two headers reconstruct the upstream secret at the client.
      return {};
    }
  }
  return out;
}

export function decodeResponseBody(buffer, headers) {
  const encoding = String(headers['content-encoding'] || '').toLowerCase().trim();
  if (!encoding || encoding === 'identity') return buffer;
  const options = { maxOutputLength: MAX_DECOMPRESSED_BYTES };
  if (encoding === 'gzip') return zlib.gunzipSync(buffer, options);
  if (encoding === 'deflate') return zlib.inflateSync(buffer, options);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer, options);
  throw new Error(`Unsupported upstream content encoding: ${encoding}`);
}

export function parseErrorBody(buffer, headers, secrets = []) {
  let text = '';
  try {
    text = decodeResponseBody(buffer, headers).toString('utf8');
  } catch {
    text = buffer.toString('utf8');
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  let message = '';
  if (parsed && typeof parsed === 'object') {
    message =
      parsed.error?.message ||
      parsed.message ||
      parsed.error?.type ||
      '';
  }
  if (!message) {
    const flat = text.replace(/\s+/g, ' ').trim();
    message = flat ? flat.slice(0, 300) : 'Upstream returned an error.';
  }
  let sanitized = redactSecrets(String(message));
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }
  return {
    parsed,
    text: sanitized.slice(0, 500)
  };
}

export function guardErrorBody(parsedError, secret) {
  if (!parsedError || typeof secret !== 'string' || secret.length < 4) return parsedError;
  try {
    assertNoSplitSecret(parsedError.parsed ?? parsedError.text, secret);
    return parsedError;
  } catch {
    return {
      parsed: null,
      text: 'The local gateway rejected an unsafe upstream error response.'
    };
  }
}

export function publicErrorForUpstream(status, message) {
  if (status === 400 || status === 422) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: message || 'The upstream rejected the request.'
    };
  }
  if (status === 404) {
    return {
      status: 404,
      type: 'not_found_error',
      message: message || 'The requested resource was not found upstream.'
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 502,
      type: 'api_error',
      message: 'Upstream authentication failed. Check the gateway configuration.'
    };
  }
  if (status === 429) {
    return {
      status: 429,
      type: 'rate_limit_error',
      message: message || 'The upstream rate limit was reached.'
    };
  }
  if (status === 413) {
    return {
      status: 413,
      type: 'request_too_large',
      message: 'The upstream rejected the request as too large.'
    };
  }
  if (status === 529) {
    return {
      status: 529,
      type: 'overloaded_error',
      message: 'The upstream is overloaded. Retry later.'
    };
  }
  return {
    status: 502,
    type: 'api_error',
    message: 'The local gateway returned an error.'
  };
}

export function isEventStream(response) {
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  return contentType.includes('text/event-stream');
}

export function isJsonContentType(value) {
  const type = String(value || 'application/json').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

export function safeUpstreamErrorType(value, fallback = 'api_error') {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

