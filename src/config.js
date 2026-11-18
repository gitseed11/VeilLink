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

export const CONFIG_VERSION = 2;
export const MAX_UPSTREAM_MODELS = 5;
const MAX_MODEL_LENGTH = 240;
export const PROTOCOLS = Object.freeze([
  'anthropic',
  'openai-responses',
  'openai-chat'
]);

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    upstream: {
      baseUrl: '',
      protocol: 'anthropic',
      authMode: 'auto',
      apiKeyEnc: null,
      models: [],
      timeoutMs: 2400000
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

function cleanModelName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function normalizeModelArray(value, { strict = false } = {}) {
  if (!Array.isArray(value)) {
    if (strict) {
      throw new AppError(400, 'invalid_request_error', 'Upstream models must be an array.');
    }
    return [];
  }
  if (value.length > MAX_UPSTREAM_MODELS) {
    if (strict) {
      throw new AppError(
        400,
        'invalid_request_error',
        `At most ${MAX_UPSTREAM_MODELS} upstream models may be configured.`
      );
    }
  }
  const models = [];
  for (const item of value) {
    if (strict && typeof item === 'string' && /[\u0000-\u001f\u007f]/.test(item)) {
      throw new AppError(
        400,
        'invalid_request_error',
        'Upstream model names must not contain control characters.'
      );
    }
    const model = cleanModelName(item);
    if (!model) {
      if (strict) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Upstream model names must be non-empty strings.'
        );
      }
      continue;
    }
    if (model.length > MAX_MODEL_LENGTH) {
      if (strict) {
        throw new AppError(400, 'invalid_request_error', 'An upstream model name is too long.');
      }
      continue;
    }
    if (models.includes(model)) {
      if (strict) {
        throw new AppError(
          400,
          'invalid_request_error',
          `Duplicate upstream model name: ${sanitizeText(model, 120)}`
        );
      }
      continue;
    }
    if (models.length >= MAX_UPSTREAM_MODELS) continue;
    models.push(model);
  }
  return models;
}

function modelsFromRaw(upstream) {
  if (Array.isArray(upstream.models)) {
    return normalizeModelArray(upstream.models);
  }
  const legacy = cleanModelName(upstream.model);
  return legacy ? [legacy] : [];
}

function normalizeProtocol(value) {
  if (value === 'openai') return 'openai-chat';
  return PROTOCOLS.includes(value) ? value : 'anthropic';
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('config.json must contain a JSON object.');
  }
  const defaults = defaultConfig();
  const upstream = isPlainObject(raw.upstream) ? raw.upstream : {};
  const publicConfig = isPlainObject(raw.public) ? raw.public : {};
  const limits = isPlainObject(raw.limits) ? raw.limits : {};

  const protocol = normalizeProtocol(upstream.protocol);
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
    version: CONFIG_VERSION,
    upstream: {
      baseUrl,
      protocol,
      authMode,
      apiKeyEnc: isPlainObject(upstream.apiKeyEnc) ? upstream.apiKeyEnc : null,
      models: modelsFromRaw(upstream),
      timeoutMs: boundedInteger(upstream.timeoutMs, defaults.upstream.timeoutMs, 10000, 2400000)
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

function configNeedsRewrite(raw) {
  if (!isPlainObject(raw)) return true;
  if (raw.version !== CONFIG_VERSION) return true;
  if (!isPlainObject(raw.upstream)) return true;
  if (raw.upstream.protocol === 'openai') return true;
  if (!PROTOCOLS.includes(raw.upstream.protocol)) return true;
  if (!Array.isArray(raw.upstream.models)) return true;
  if ('model' in raw.upstream) return true;
  return false;
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
    let rewrite = false;
    if (!raw) {
      raw = defaultConfig();
      await writeJsonAtomic(paths.configFile, raw, { mode: 0o600 });
    } else if (configNeedsRewrite(raw)) {
      rewrite = true;
    }
    const normalized = normalizeConfig(raw);
    if (JSON.stringify(normalized) !== JSON.stringify(raw)) rewrite = true;
    const store = new ConfigStore(paths, secretBox, normalized);
    store.upstreamApiKey = '';
    if (normalized.upstream.apiKeyEnc) {
      try {
        store.upstreamApiKey = secretBox.decryptString(normalized.upstream.apiKeyEnc, 'upstream-api-key-v1');
      } catch {
        throw new Error('The stored upstream API key cannot be decrypted. Restore data/master.key, or stop the service and run npm run upstream:reset to clear the stored upstream key.');
      }
    }
    if (rewrite) {
      await writeJsonAtomic(paths.configFile, normalized, { mode: 0o600 });
    }
    return store;
  }

  constructor(paths, secretBox, config) {
    this.paths = paths;
    this.secretBox = secretBox;
    this.config = config;
    this.upstreamApiKey = '';
    this.updateChain = Promise.resolve();
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
      models: [...upstream.models],
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
      models: [...upstream.models],
      timeoutMs: upstream.timeoutMs,
      hasApiKey: Boolean(this.upstreamApiKey),
      configured: Boolean(upstream.baseUrl)
    };
  }

  async update(input) {
    const run = this.updateChain.then(() => this.applyUpdate(input));
    this.updateChain = run.catch(() => {});
    return run;
  }

  async applyUpdate(input) {
    if (!isPlainObject(input)) {
      throw new AppError(400, 'invalid_request_error', 'Configuration body must be a JSON object.');
    }
    const next = structuredClone(this.config);
    const upstreamInput = isPlainObject(input.upstream) ? input.upstream : input;

    if ('baseUrl' in upstreamInput) {
      next.upstream.baseUrl = validateBaseUrl(upstreamInput.baseUrl, { allowEmpty: true });
    }
    if ('protocol' in upstreamInput) {
      const protocol = upstreamInput.protocol === 'openai'
        ? 'openai-chat'
        : upstreamInput.protocol;
      if (!PROTOCOLS.includes(protocol)) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Protocol must be anthropic, openai-responses, or openai-chat.'
        );
      }
      next.upstream.protocol = protocol;
    }
    if ('authMode' in upstreamInput) {
      if (!['auto', 'none', 'x-api-key', 'bearer'].includes(upstreamInput.authMode)) {
        throw new AppError(400, 'invalid_request_error', 'Invalid upstream authentication mode.');
      }
      next.upstream.authMode = upstreamInput.authMode;
    }
    if ('models' in upstreamInput) {
      next.upstream.models = normalizeModelArray(upstreamInput.models, { strict: true });
    } else if ('model' in upstreamInput) {
      const legacy = typeof upstreamInput.model === 'string' ? upstreamInput.model : '';
      next.upstream.models = legacy.trim()
        ? normalizeModelArray([legacy], { strict: true })
        : [];
    }
    if ('timeoutMs' in upstreamInput) {
      const timeout = Number(upstreamInput.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 2400000) {
        throw new AppError(400, 'invalid_request_error', 'Timeout must be between 10 and 2400 seconds.');
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

    if (next.upstream.baseUrl && next.upstream.models.length === 0) {
      throw new AppError(
        400,
        'invalid_request_error',
        'At least one upstream model is required when a gateway address is configured.'
      );
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
