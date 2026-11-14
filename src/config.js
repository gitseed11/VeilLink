import { writeJsonAtomic, readJsonIfExists } from './storage.js';
import {
  AppError,
  DEFAULT_LIMITS,
  asString,
  effectiveAuthMode,
  isPlainObject,
  sanitizeText,
  validateBaseUrl
} from './util.js';

function defaultConfig() {
  return {
    version: 1,
    upstream: {
      baseUrl: '',
      protocol: 'anthropic',
      authMode: 'auto',
      apiKeyEnc: null,
      model: '',
      timeoutMs: 300000
    },
    public: {
      baseUrl: ''
    },
    limits: { ...DEFAULT_LIMITS }
  };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('config.json must contain a JSON object.');
  }
  const defaults = defaultConfig();
  const upstream = isPlainObject(raw.upstream) ? raw.upstream : {};
  const publicConfig = isPlainObject(raw.public) ? raw.public : {};
  const limits = isPlainObject(raw.limits) ? raw.limits : {};

  const protocol = ['anthropic', 'openai'].includes(upstream.protocol)
    ? upstream.protocol
    : defaults.upstream.protocol;
  const authMode = ['auto', 'none', 'x-api-key', 'bearer'].includes(upstream.authMode)
    ? upstream.authMode
    : defaults.upstream.authMode;

  let baseUrl = '';
  try {
    baseUrl = validateBaseUrl(upstream.baseUrl, { allowEmpty: true });
  } catch {
    baseUrl = '';
  }

  let publicBaseUrl = '';
  try {
    publicBaseUrl = normalizePublicBaseUrl(publicConfig.baseUrl);
  } catch {
    publicBaseUrl = '';
  }

  return {
    version: 1,
    upstream: {
      baseUrl,
      protocol,
      authMode,
      apiKeyEnc: isPlainObject(upstream.apiKeyEnc) ? upstream.apiKeyEnc : null,
      model: sanitizeText(upstream.model, 240),
      timeoutMs: boundedInteger(upstream.timeoutMs, defaults.upstream.timeoutMs, 10000, 900000)
    },
    public: {
      baseUrl: publicBaseUrl
    },
    limits: {
      bodyBytes: boundedInteger(limits.bodyBytes, DEFAULT_LIMITS.bodyBytes, 1_048_576, 100_000_000),
      requestsPerMinutePerKey: boundedInteger(
        limits.requestsPerMinutePerKey,
        DEFAULT_LIMITS.requestsPerMinutePerKey,
        1,
        100000
      ),
      concurrentPerKey: boundedInteger(
        limits.concurrentPerKey,
        DEFAULT_LIMITS.concurrentPerKey,
        1,
        100
      ),
      requestsPerMinutePerIp: boundedInteger(
        limits.requestsPerMinutePerIp,
        DEFAULT_LIMITS.requestsPerMinutePerIp,
        1,
        100000
      ),
      authFailuresPerTenMinutesPerIp: boundedInteger(
        limits.authFailuresPerTenMinutesPerIp,
        DEFAULT_LIMITS.authFailuresPerTenMinutesPerIp,
        1,
        10000
      )
    }
  };
}

function normalizePublicBaseUrl(raw) {
  const text = asString(raw).trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new AppError(400, 'invalid_request_error', 'Public URL is not valid.');
  }
  if (url.protocol !== 'https:') {
    throw new AppError(400, 'invalid_request_error', 'Public URL must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'invalid_request_error', 'Public URL must not contain credentials, query, or fragment.');
  }
  return text.replace(/\/+$/, '');
}

export class ConfigStore {
  static async load(paths, secretBox) {
    let raw = await readJsonIfExists(paths.configFile, null);
    if (!raw) {
      raw = defaultConfig();
      await writeJsonAtomic(paths.configFile, raw, { mode: 0o600 });
    }
    const normalized = normalizeConfig(raw);
    const store = new ConfigStore(paths, secretBox, normalized);
    store.upstreamApiKey = '';
    if (normalized.upstream.apiKeyEnc) {
      try {
        store.upstreamApiKey = secretBox.decryptString(normalized.upstream.apiKeyEnc, 'upstream-api-key-v1');
      } catch {
        throw new Error('The stored upstream API key cannot be decrypted. Restore data/master.key, or stop the service and run npm run upstream:reset to clear the stored upstream key.');
      }
    }
    return store;
  }

  constructor(paths, secretBox, config) {
    this.paths = paths;
    this.secretBox = secretBox;
    this.config = config;
    this.upstreamApiKey = '';
  }

  get limits() {
    return this.config.limits;
  }

  runtimeUpstream() {
    const upstream = this.config.upstream;
    return {
      baseUrl: upstream.baseUrl,
      protocol: upstream.protocol,
      authMode: effectiveAuthMode(upstream.protocol, upstream.authMode),
      apiKey: this.upstreamApiKey,
      model: upstream.model,
      timeoutMs: upstream.timeoutMs,
      configured: Boolean(upstream.baseUrl)
    };
  }

  safeSnapshot() {
    const upstream = this.config.upstream;
    return {
      baseUrl: upstream.baseUrl,
      protocol: upstream.protocol,
      authMode: upstream.authMode,
      effectiveAuthMode: effectiveAuthMode(upstream.protocol, upstream.authMode),
      model: upstream.model,
      timeoutMs: upstream.timeoutMs,
      hasApiKey: Boolean(this.upstreamApiKey),
      configured: Boolean(upstream.baseUrl)
    };
  }

  async update(input) {
    if (!isPlainObject(input)) {
      throw new AppError(400, 'invalid_request_error', 'Configuration body must be a JSON object.');
    }
    const next = structuredClone(this.config);
    const upstreamInput = isPlainObject(input.upstream) ? input.upstream : input;

    if ('baseUrl' in upstreamInput) {
      next.upstream.baseUrl = validateBaseUrl(upstreamInput.baseUrl, { allowEmpty: true });
    }
    if ('protocol' in upstreamInput) {
      if (!['anthropic', 'openai'].includes(upstreamInput.protocol)) {
        throw new AppError(400, 'invalid_request_error', 'Protocol must be anthropic or openai.');
      }
      next.upstream.protocol = upstreamInput.protocol;
    }
    if ('authMode' in upstreamInput) {
      if (!['auto', 'none', 'x-api-key', 'bearer'].includes(upstreamInput.authMode)) {
        throw new AppError(400, 'invalid_request_error', 'Invalid upstream authentication mode.');
      }
      next.upstream.authMode = upstreamInput.authMode;
    }
    if ('model' in upstreamInput) {
      next.upstream.model = sanitizeText(upstreamInput.model, 240);
    }
    if ('timeoutMs' in upstreamInput) {
      const timeout = Number(upstreamInput.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 900000) {
        throw new AppError(400, 'invalid_request_error', 'Timeout must be between 10 and 900 seconds.');
      }
      next.upstream.timeoutMs = timeout;
    }

    let nextApiKey = this.upstreamApiKey;
    let apiKeyChanged = false;
    const clearApiKey = input.clearApiKey === true || upstreamInput.clearApiKey === true;
    const suppliedApiKey = typeof upstreamInput.apiKey === 'string' ? upstreamInput.apiKey.trim() : '';
    if (suppliedApiKey) {
      if (suppliedApiKey.length > 8192 || /[\r\n]/.test(suppliedApiKey)) {
        throw new AppError(400, 'invalid_request_error', 'Upstream API key is invalid.');
      }
      nextApiKey = suppliedApiKey;
      apiKeyChanged = true;
    } else if (clearApiKey) {
      nextApiKey = '';
      apiKeyChanged = true;
    }

    if (next.upstream.protocol === 'openai' && next.upstream.baseUrl && !next.upstream.model) {
      throw new AppError(400, 'invalid_request_error', 'OpenAI protocol requires an upstream model name.');
    }
    if (next.upstream.baseUrl && !/^https?:\/\//i.test(next.upstream.baseUrl)) {
      throw new AppError(400, 'invalid_request_error', 'Upstream base URL must use HTTP or HTTPS.');
    }

    if ('public' in input) {
      const publicInput = isPlainObject(input.public) ? input.public : {};
      if ('baseUrl' in publicInput) {
        next.public.baseUrl = normalizePublicBaseUrl(publicInput.baseUrl);
      }
    } else if ('publicBaseUrl' in input) {
      next.public.baseUrl = normalizePublicBaseUrl(input.publicBaseUrl);
    }

    if (apiKeyChanged) {
      next.upstream.apiKeyEnc = nextApiKey
        ? this.secretBox.encryptString(nextApiKey, 'upstream-api-key-v1')
        : null;
    }

    await writeJsonAtomic(this.paths.configFile, next, { mode: 0o600 });
    this.config = next;
    if (apiKeyChanged) this.upstreamApiKey = nextApiKey;
    return this.safeSnapshot();
  }
}
