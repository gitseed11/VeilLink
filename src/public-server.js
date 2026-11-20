import http from 'node:http';
import {
  AppError,
  applySecurityHeaders,
  assertNoSplitSecret,
  clientIp,
  createBodyLease,
  isOpenAIProtocol,
  nowMs,
  readJsonBody,
  readOptionalJsonBody,
  redactSecrets,
  requestId,
  scrubSecretsDeep,
  sendAnthropicError,
  sendOpenAIError,
  writeJson
} from './util.js';
import { proxyAnthropic } from './upstream/anthropic.js';
import { proxyOpenAI } from './upstream/openai.js';
import {
  assertModelAllowed,
  requestModel,
  syntheticModel,
  syntheticModelList
} from './upstream/models.js';

const ROUTES = {
  anthropic: [
    { pattern: /^\/v1\/messages$/, methods: { POST: { kind: 'messages', body: 'required', modelRequired: true } } },
    { pattern: /^\/v1\/messages\/count_tokens$/, methods: { POST: { kind: 'count_tokens', body: 'required', modelRequired: true } } },
    { pattern: /^\/v1\/models$/, methods: { GET: { kind: 'models' } } },
    { pattern: /^\/v1\/models\/(.+)$/, methods: { GET: { kind: 'model', modelParam: 1 } } }
  ],
  'openai-responses': [
    { pattern: /^\/v1\/responses$/, methods: { POST: { kind: 'responses_create', body: 'required', modelRequired: true } } },
    { pattern: /^\/v1\/responses\/compact$/, methods: { POST: { kind: 'responses_compact', body: 'required', modelRequired: true } } },
    { pattern: /^\/v1\/responses\/input_tokens$/, methods: { POST: { kind: 'responses_input_tokens', body: 'required', modelRequired: false } } },
    // Stored Response lifecycle endpoints are intentionally not exposed: the
    // gateway uses one upstream credential, so upstream object IDs are not
    // scoped to a VeilLink API key and would allow cross-client access.
    { pattern: /^\/v1\/models$/, methods: { GET: { kind: 'models' } } },
    { pattern: /^\/v1\/models\/(.+)$/, methods: { GET: { kind: 'model', modelParam: 1 } } }
  ],
  'openai-chat': [
    { pattern: /^\/v1\/chat\/completions$/, methods: {
      POST: { kind: 'chat_create', body: 'required', modelRequired: true }
    } },
    // Stored Chat Completion lifecycle endpoints are intentionally not exposed
    // for the same cross-client ownership reason as Responses lifecycle.
    { pattern: /^\/v1\/models$/, methods: { GET: { kind: 'models' } } },
    { pattern: /^\/v1\/models\/(.+)$/, methods: { GET: { kind: 'model', modelParam: 1 } } }
  ]
};

function canonicalApiPath(path) {
  let normalized = path;
  // Accept exactly one duplicated /v1 prefix (clients that append /v1 to a
  // base URL that already ends in /v1). Do not keep collapsing extra levels:
  // /v1/v1/v1/... is not a documented alias and should be a 404.
  if (normalized.startsWith('/v1/v1/')) normalized = normalized.slice(3);
  if (
    normalized === '/models' ||
    normalized.startsWith('/models/') ||
    normalized === '/messages' ||
    normalized.startsWith('/messages/') ||
    normalized === '/responses' ||
    normalized.startsWith('/responses/') ||
    normalized === '/chat/completions'
  ) {
    return `/v1${normalized}`;
  }
  return normalized;
}

function parseTarget(req) {
  const raw = req.url || '/';
  if (
    typeof raw !== 'string' ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    raw.includes('#')
  ) {
    return null;
  }
  const question = raw.indexOf('?');
  const rawPath = question === -1 ? raw : raw.slice(0, question);
  // Reject dot segments and encoded dot segments. Node's URL parser would
  // normalize them, while a fronting WAF or path filter may see a different
  // path. A single encoded dot inside a model id (e.g. gpt-4%2E1) is allowed.
  for (const segment of rawPath.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\\') ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)
    ) {
      return null;
    }
  }
  try {
    const parsed = new URL(raw, 'http://127.0.0.1');
    return {
      path: canonicalApiPath(parsed.pathname),
      rawPath: parsed.pathname,
      search: parsed.search || ''
    };
  } catch {
    return null;
  }
}

function decodePathValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(400, 'invalid_request_error', 'Invalid URL encoding.');
  }
}

function matchRoute(protocol, path, method) {
  const routes = ROUTES[protocol] || [];
  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const handler = route.methods[method];
    if (!handler) {
      return { allow: [...Object.keys(route.methods), 'OPTIONS'].join(', ') };
    }
    const resolved = { ...handler };
    if (handler.idParam) resolved.id = decodePathValue(match[handler.idParam]);
    if (handler.modelParam) resolved.modelId = decodePathValue(match[handler.modelParam]);
    return { handler: resolved };
  }
  return null;
}

function routeForAnyMethod(protocol, path) {
  const routes = ROUTES[protocol] || [];
  for (const route of routes) {
    if (route.pattern.test(path)) return route;
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

function isJsonRequest(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  return contentType.split(';', 1)[0].trim() === 'application/json';
}

function requestHeaders(protocol, id) {
  return isOpenAIProtocol(protocol)
    ? { 'request-id': id, 'x-request-id': id }
    : { 'request-id': id };
}

function sendProtocolError(res, error, id, protocol) {
  if (isOpenAIProtocol(protocol)) sendOpenAIError(res, error, id);
  else sendAnthropicError(res, error, id);
}

function queryHasStream(search) {
  try {
    return new URLSearchParams(search).get('stream') === 'true';
  } catch {
    return false;
  }
}

const ALLOWED_QUERY_KEYS = new Set([
  'api-version',
  'beta',
  'limit',
  'after_id',
  'before_id',
  'lifecycle',
  'lifecycle[]'
]);

function queryHasDisallowedKey(search) {
  try {
    const params = new URLSearchParams(search);
    for (const key of params.keys()) {
      if (!ALLOWED_QUERY_KEYS.has(key)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function anthropicModelListOptions(search) {
  let params;
  try {
    params = new URLSearchParams(search);
  } catch {
    return {};
  }
  const options = {};
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError(400, 'invalid_request_error', 'limit must be an integer between 1 and 1000.', {
        code: 'invalid_parameter',
        param: 'limit'
      });
    }
    options.limit = limit;
  }
  const lifecycles = [
    ...params.getAll('lifecycle'),
    ...params.getAll('lifecycle[]')
  ];
  if (lifecycles.length > 3) {
    throw new AppError(400, 'invalid_request_error', 'lifecycle may be specified at most 3 times.', {
      code: 'invalid_parameter',
      param: 'lifecycle'
    });
  }
  for (const lifecycle of lifecycles) {
    if (
      lifecycle !== 'active' &&
      lifecycle !== 'deprecated' &&
      lifecycle !== 'retired'
    ) {
      throw new AppError(
        400,
        'invalid_request_error',
        'lifecycle must be active, deprecated, or retired.',
        { code: 'invalid_parameter', param: 'lifecycle' }
      );
    }
  }
  if (lifecycles.length > 0) {
    options.lifecycles = lifecycles;
    options.lifecycle = lifecycles.includes('active') ? 'active' : lifecycles[0];
  }
  const afterId = params.get('after_id');
  if (afterId !== null) options.afterId = afterId;
  const beforeId = params.get('before_id');
  if (beforeId !== null) {
    if (options.afterId !== undefined) {
      throw new AppError(
        400,
        'invalid_request_error',
        'after_id and before_id cannot be used together.',
        { code: 'invalid_parameter', param: 'before_id' }
      );
    }
    options.beforeId = beforeId;
  }
  return options;
}

function hasStoredReferenceValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isStoredContainer(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = value.trim();
    return text !== '' && text !== 'auto';
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    // OpenAI Code Interpreter accepts container: "auto" or { type: "auto" }
    // to request a fresh container. Only IDs or file references are stored
    // objects that could cross client boundaries.
    if (value.type === 'auto' && !hasStoredReferenceValue(value.id) && !hasStoredReferenceValue(value.file_ids)) {
      return false;
    }
    return true;
  }
  return true;
}

function containsStoredReference(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsStoredReference(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    if (
      (key === 'file_id' || key === 'connector_id' || key === 'container_id') &&
      hasStoredReferenceValue(item)
    ) {
      return true;
    }
    if (
      (key === 'file_ids' ||
        key === 'vector_store_ids' ||
        key === 'connector_ids' ||
        key === 'container_ids') &&
      hasStoredReferenceValue(item)
    ) {
      return true;
    }
    if (containsStoredReference(item, depth + 1)) return true;
  }
  return false;
}

function containsToolStoredReference(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsToolStoredReference(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    // Tool parameter schemas legitimately declare keys named file_id or
    // container_id. They are type definitions, not runtime object references.
    // file_search.filters is also metadata, not a stored-object reference.
    if (key === 'parameters' || key === 'input_schema' || key === 'filters') {
      continue;
    }
    if (
      (key === 'file_id' ||
        key === 'file_ids' ||
        key === 'connector_id' ||
        key === 'connector_ids' ||
        key === 'container_id' ||
        key === 'container_ids' ||
        key === 'vector_store_ids') &&
      hasStoredReferenceValue(item)
    ) {
      return true;
    }
    if (containsToolStoredReference(item, depth + 1)) return true;
  }
  return false;
}

const STORED_REFERENCE_KEYS = [
  'file_id',
  'file_ids',
  'container_id',
  'container_ids',
  'connector_id',
  'connector_ids',
  'vector_store_ids'
];

const ANTHROPIC_STORED_KEYS = new Set(STORED_REFERENCE_KEYS);

function anthropicHasStoredReference(value, depth = 0) {
  if (depth > 16 || value === null || value === undefined || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => anthropicHasStoredReference(item, depth + 1));
  }
  if (
    [...ANTHROPIC_STORED_KEYS].some((key) => hasStoredReferenceValue(value[key]))
  ) {
    return true;
  }
  if (value.source !== null && typeof value.source === 'object') {
    if (Array.isArray(value.source)) {
      if (anthropicHasStoredReference(value.source, depth + 1)) return true;
    } else {
      if (value.source.type === 'file') return true;
      if (hasStoredReferenceValue(value.source.file_id)) return true;
      if (
        value.source.type === 'content' &&
        anthropicHasStoredReference(value.source.content, depth + 1)
      ) {
        return true;
      }
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'source' || ANTHROPIC_STORED_KEYS.has(key)) continue;
    // Tool arguments are opaque payloads; a tool may legitimately receive
    // file_id/container_id as its own input. They are not Anthropic content
    // source references. Tool schemas are exempt for the same reason.
    if (value.type === 'tool_use' && key === 'input') continue;
    if (anthropicHasStoredReference(item, depth + 1)) return true;
  }
  return false;
}

function guardStoredReferences(body, protocol) {
  if (!body || typeof body !== 'object') return;
  for (const key of STORED_REFERENCE_KEYS) {
    if (hasStoredReferenceValue(body[key])) {
      throw new AppError(
        400,
        'invalid_request_error',
        'Stored file references are not supported by this gateway.',
        { code: 'unsupported_parameter', param: key }
      );
    }
  }
  if (protocol === 'anthropic') {
    if (body.system !== undefined && anthropicHasStoredReference(body.system)) {
      throw new AppError(
        400,
        'invalid_request_error',
        'Stored file references are not supported by this gateway.',
        { code: 'unsupported_parameter', param: 'system' }
      );
    }
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (anthropicHasStoredReference(message)) {
          throw new AppError(
            400,
            'invalid_request_error',
            'Stored file references are not supported by this gateway.',
            { code: 'unsupported_parameter', param: 'messages' }
          );
        }
      }
    }
    if (isStoredContainer(body.container) || isStoredContainer(body.container_id)) {
      throw new AppError(
        400,
        'invalid_request_error',
        'Stored container references are not supported by this gateway.',
        { code: 'unsupported_parameter', param: 'container' }
      );
    }
    return;
  }

  if (body.prompt !== undefined && body.prompt !== null) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Reusable prompt objects are not supported by this gateway.',
      { code: 'unsupported_parameter', param: 'prompt' }
    );
  }
  if (protocol === 'openai-chat' && containsStoredReference(body.messages)) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Stored file references are not supported by this gateway.',
      { code: 'unsupported_parameter', param: 'messages' }
    );
  }
  if (containsStoredReference(body.input)) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Stored file references are not supported by this gateway.',
      { code: 'unsupported_parameter', param: 'input' }
    );
  }
  if (isStoredContainer(body.container) || isStoredContainer(body.container_id)) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Stored container references are not supported by this gateway.',
      { code: 'unsupported_parameter', param: 'container' }
    );
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      if (tool.type === 'file_search' && hasStoredReferenceValue(tool.vector_store_ids)) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Stored vector-store references are not supported by this gateway.',
          { code: 'unsupported_parameter', param: 'tools' }
        );
      }
      if (tool.type === 'code_interpreter' && isStoredContainer(tool.container)) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Stored container references are not supported by this gateway.',
          { code: 'unsupported_parameter', param: 'tools' }
        );
      }
      if (
        tool.type === 'mcp' &&
        hasStoredReferenceValue(tool.connector_id)
      ) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Stored connector references are not supported by this gateway.',
          { code: 'unsupported_parameter', param: 'tools' }
        );
      }
      if (containsToolStoredReference(tool)) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Stored file references are not supported by this gateway.',
          { code: 'unsupported_parameter', param: 'tools' }
        );
      }
    }
  }
}

const MAX_TRACKED_RESPONSES = 5000;
// Approximate per-request response admission: SSE event 32 MB plus
// tool/signature buffers, and 32 MB collected JSON plus up to 64 MB
// decompression output. JSON object/string copies are not fully covered.
const RESPONSE_RESERVE_STREAM = 48 * 1024 * 1024;
const RESPONSE_RESERVE_JSON = 96 * 1024 * 1024;

export function createPublicServer(context) {
  const {
    configStore,
    keyStore,
    logStore,
    limiter,
    concurrency,
    globalConcurrency,
    bodyBudget,
    responseBudget,
    activeKeyResponses = new Map(),
    stats
  } = context;
  const responseOwners = new Map();

  const registerActiveResponse = (keyId, response) => {
    if (!keyId) return () => {};
    let responses = activeKeyResponses.get(keyId);
    if (!responses) {
      responses = new Set();
      activeKeyResponses.set(keyId, responses);
    }
    responses.add(response);
    return () => {
      responses.delete(response);
      if (!responses.size) activeKeyResponses.delete(keyId);
    };
  };

  const rememberResponseOwner = (responseId, keyId) => {
    if (!responseId || !keyId) return;
    responseOwners.delete(responseId);
    responseOwners.set(responseId, keyId);
    while (responseOwners.size > MAX_TRACKED_RESPONSES) {
      responseOwners.delete(responseOwners.keys().next().value);
    }
  };

  const containsExplicitItemReference = (value, depth = 0) => {
    if (depth > 12 || value === null || value === undefined) return false;
    if (Array.isArray(value)) {
      return value.some((item) => containsExplicitItemReference(item, depth + 1));
    }
    if (typeof value !== 'object') return false;
    if (value.type === 'item_reference') return true;
    return Object.values(value).some((item) =>
      containsExplicitItemReference(item, depth + 1)
    );
  };

  const hasInlineReasoningPayload = (item) => {
    const hasTextPart = (parts) =>
      Array.isArray(parts) &&
      parts.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          typeof part.text === 'string' &&
          part.text.trim() !== ''
      );
    if (hasTextPart(item.summary) || hasTextPart(item.content)) return true;
    return (
      typeof item.encrypted_content === 'string' &&
      item.encrypted_content.trim() !== ''
    );
  };

  const hasUnknownReasoningPayload = (item) => {
    const allowed = new Set([
      'type',
      'id',
      'summary',
      'content',
      'encrypted_content',
      'status'
    ]);
    return Object.entries(item).some(([key, value]) => {
      if (allowed.has(key) || value === null || value === undefined) return false;
      if (typeof value === 'string') return value.trim() !== '';
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    });
  };

  const hasUnsafeInputItem = (input) => {
    const items = Array.isArray(input)
      ? input
      : (input && typeof input === 'object' ? [input] : []);
    return items.some((item) => {
      if (!item || typeof item !== 'object') return false;
      if (item.type === 'reasoning') {
        return !hasInlineReasoningPayload(item) || hasUnknownReasoningPayload(item);
      }
      if (item.type === 'compaction') {
        return !(
          typeof item.encrypted_content === 'string' &&
          item.encrypted_content.trim() !== ''
        );
      }
      if (item.id === undefined) return false;
      const hasType = typeof item.type === 'string' && item.type.trim() !== '';
      const hasRole = typeof item.role === 'string' && item.role.trim() !== '';
      const hasContent =
        (typeof item.content === 'string' && item.content !== '') ||
        (Array.isArray(item.content) && item.content.length > 0);
      if (!hasType && !hasRole && !hasContent) return true;
      if ((hasRole || item.type === 'message') && !hasContent) return true;
      const hasPayload = [
        item.arguments,
        item.input,
        item.output,
        item.queries,
        item.action,
        item.result,
        item.tools,
        item.revised_prompt
      ].some((value) => hasStoredReferenceValue(value));
      const hasPresentPayload = (obj, key) =>
        Object.prototype.hasOwnProperty.call(obj, key) &&
        obj[key] !== null &&
        obj[key] !== undefined;
      const hasKnownEmptyPayload =
        (item.type === 'function_call_output' && hasPresentPayload(item, 'output')) ||
        (item.type === 'function_call' && hasPresentPayload(item, 'arguments')) ||
        (item.type === 'custom_tool_call' && hasPresentPayload(item, 'input')) ||
        (item.type === 'custom_tool_call_output' && hasPresentPayload(item, 'output'));
      if (!hasContent && !hasPayload && !hasKnownEmptyPayload) return true;
      return false;
    });
  };

  const guardResponseReferences = (body, keyId) => {
    if (!body || typeof body !== 'object') return;
    if (
      body.input !== undefined &&
      (containsExplicitItemReference(body.input) || hasUnsafeInputItem(body.input))
    ) {
      throw new AppError(
        400,
        'invalid_request_error',
        'item_reference is not supported by this gateway.',
        { code: 'unsupported_parameter', param: 'input' }
      );
    }
    if (body.conversation !== undefined && body.conversation !== null) {
      throw new AppError(
        400,
        'invalid_request_error',
        'Conversations are not exposed by this gateway.',
        { code: 'unsupported_parameter', param: 'conversation' }
      );
    }
    if (body.background !== undefined && body.background !== false) {
      throw new AppError(
        400,
        'invalid_request_error',
        'Background responses are not exposed by this gateway.',
        { code: 'unsupported_parameter', param: 'background' }
      );
    }
    if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
      if (
        typeof body.previous_response_id !== 'string' ||
        !body.previous_response_id
      ) {
        throw new AppError(
          400,
          'invalid_request_error',
          'previous_response_id must be a non-empty string.',
          { code: 'invalid_parameter', param: 'previous_response_id' }
        );
      }
      if (responseOwners.get(body.previous_response_id) !== keyId) {
        throw new AppError(
          404,
          'invalid_request_error',
          'Previous response is not available for this API key.',
          { code: 'previous_response_not_found', param: 'previous_response_id' }
        );
      }
    }
  };

  return http.createServer({ maxHeaderSize: 32 * 1024 }, async (req, res) => {
    const id = requestId();
    const started = nowMs();
    const ip = clientIp(req);
    const parsedTarget = parseTarget(req);
    const protocol = configStore.config.upstream.protocol;
    let keyRecord = null;
    let meta = {};
    let logError = null;
    let acquiredKey = false;
    let acquiredGlobal = false;
    let bodyLease = null;
    let unregisterActive = null;
    const limits = configStore.limits;

    applySecurityHeaders(res, { hsts: true });
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('request-id', id);
    if (isOpenAIProtocol(protocol)) res.setHeader('x-request-id', id);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');

    stats.requestsTotal += 1;
    stats.active += 1;

    try {
      // Rate-limit every public request before validating the target, so
      // malformed targets cannot bypass the per-IP budget.
      const ipLimit = limiter.take(`ip:${ip}`, limits.requestsPerMinutePerIp, 60_000);
      if (!ipLimit.allowed) {
        throw new AppError(429, 'rate_limit_error', 'Too many requests.', {
          headers: { 'Retry-After': String(ipLimit.retryAfterSeconds) }
        });
      }
      if (!parsedTarget) {
        throw new AppError(400, 'invalid_request_error', 'Invalid request target.');
      }
      const { path, search } = parsedTarget;
      if (queryHasDisallowedKey(search)) {
        throw new AppError(
          400,
          'invalid_request_error',
          'Only api-version, beta, limit, after_id, before_id, lifecycle, and lifecycle[] query parameters are accepted.',
          { code: 'unsupported_parameter', param: 'query' }
        );
      }

      if (req.method === 'OPTIONS') {
        const route = routeForAnyMethod(protocol, path);
        if (!route) throw new AppError(404, 'not_found_error', 'Not found.');
        res.statusCode = 204;
        res.setHeader('Allow', [...Object.keys(route.methods), 'OPTIONS'].join(', '));
        res.end();
        stats.requestsOk += 1;
        return;
      }

      const matched = matchRoute(protocol, path, req.method);
      if (!matched) {
        throw new AppError(404, 'not_found_error', 'Not found.');
      }
      if (!matched.handler) {
        res.setHeader('Allow', matched.allow);
        throw new AppError(405, 'invalid_request_error', 'Method not allowed.');
      }
      const route = matched.handler;

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
      unregisterActive = registerActiveResponse(keyRecord.id, res);

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
      if (!globalConcurrency.acquire('global', limits.globalConcurrent)) {
        throw new AppError(429, 'rate_limit_error', 'The gateway is busy.', {
          publicMessage: 'The gateway is temporarily busy. Retry shortly.',
          headers: { 'Retry-After': '2' }
        });
      }
      acquiredGlobal = true;

      keyStore.touch(keyRecord, ip);
      let upstream = configStore.runtimeUpstream();
      if (upstream.protocol !== protocol) {
        throw new AppError(409, 'invalid_request_error', 'The active upstream protocol changed. Retry the request.');
      }

      if (route.kind === 'models') {
        const options = protocol === 'anthropic' ? anthropicModelListOptions(search) : {};
        const models = syntheticModelList(upstream.protocol, upstream.models, options);
        const safeModels = scrubSecretsDeep(
          models,
          upstream.apiKey ? [upstream.apiKey] : []
        );
        if (upstream.apiKey) assertNoSplitSecret(safeModels, upstream.apiKey);
        writeJson(res, 200, safeModels, requestHeaders(protocol, id));
        meta = { status: 200, stream: false };
        stats.requestsOk += 1;
        return;
      }
      if (route.kind === 'model') {
        const model = syntheticModel(upstream.protocol, route.modelId, upstream.models);
        if (!model) {
          assertModelAllowed(route.modelId, upstream.models, protocol);
          throw new AppError(404, 'not_found_error', 'Model is not configured.');
        }
        const safeModel = scrubSecretsDeep(
          model,
          upstream.apiKey ? [upstream.apiKey] : []
        );
        if (upstream.apiKey) assertNoSplitSecret(safeModel, upstream.apiKey);
        writeJson(res, 200, safeModel, requestHeaders(protocol, id));
        meta = { status: 200, stream: false, model: route.modelId };
        stats.requestsOk += 1;
        return;
      }

      if (!upstream.configured) {
        throw new AppError(503, 'api_error', 'The local gateway is not configured yet.');
      }
      if (upstream.models.length === 0) {
        throw new AppError(503, 'api_error', 'The upstream model list is not configured.');
      }

      let body = null;
      if (route.body === 'required') {
        if (!isJsonRequest(req)) {
          throw new AppError(415, 'invalid_request_error', 'Content-Type must be application/json.');
        }
        bodyLease = createBodyLease(bodyBudget);
        body = await readJsonBody(req, limits.bodyBytes, bodyLease);
      } else if (route.body === 'optional') {
        const declared = Number(req.headers['content-length']);
        const chunked = typeof req.headers['transfer-encoding'] === 'string';
        if (isJsonRequest(req) || declared > 0 || chunked) {
          if (!isJsonRequest(req)) {
            throw new AppError(415, 'invalid_request_error', 'Content-Type must be application/json.');
          }
          bodyLease = createBodyLease(bodyBudget);
          body = await readOptionalJsonBody(req, limits.bodyBytes, bodyLease);
        } else {
          req.resume();
        }
      } else {
        req.resume();
      }

      if (configStore.config.upstream.protocol !== protocol) {
        throw new AppError(409, 'invalid_request_error', 'The active upstream protocol changed. Retry the request.');
      }
      upstream = configStore.runtimeUpstream();
      if (body) {
        if (typeof body.model === 'string') {
          meta.model = body.model.length <= 240 ? body.model : '[invalid-model]';
        }
        meta.stream = body.stream === true;
      }
      if (route.kind === 'responses_get' && queryHasStream(search)) meta.stream = true;
      if (route.modelRequired) {
        assertModelAllowed(requestModel(body), upstream.models, protocol);
      } else if (route.kind === 'responses_input_tokens') {
        const model = requestModel(body);
        if (model !== '') {
          assertModelAllowed(model, upstream.models, protocol);
        } else if (body && body.model !== undefined && body.model !== null) {
          throw new AppError(400, 'invalid_request_error', 'Request model must be a string.', {
            code: 'invalid_parameter',
            param: 'model'
          });
        }
      }
      if (body) {
        if (isOpenAIProtocol(protocol)) guardResponseReferences(body, keyRecord.id);
        guardStoredReferences(body, protocol);
      }

      const proxy = isOpenAIProtocol(upstream.protocol) ? proxyOpenAI : proxyAnthropic;
      const reservedBytes = body?.stream === true
        ? RESPONSE_RESERVE_STREAM
        : RESPONSE_RESERVE_JSON;
      if (responseBudget && !responseBudget.reserve(reservedBytes)) {
        throw new AppError(429, 'rate_limit_error', 'The gateway is busy.', {
          publicMessage: 'The gateway is temporarily busy. Retry shortly.',
          headers: { 'Retry-After': '2' }
        });
      }
      try {
        meta = {
          ...meta,
          ...(await proxy({
            req,
            res,
            path,
            search,
            body,
            upstream,
            requestId: id,
            route
          }))
        };
      } finally {
        responseBudget?.release(reservedBytes);
      }
      if (body && typeof body.model === 'string') meta.model = body.model;

      if (route.kind === 'responses_create' && meta.responseId) {
        rememberResponseOwner(meta.responseId, keyRecord.id);
      }
      if (meta.status && meta.status < 400 && !meta.error) stats.requestsOk += 1;
      else stats.requestsError += 1;
      if (meta.upstreamStatus || meta.status < 500) {
        stats.lastUpstream = {
          time: new Date().toISOString(),
          ok: !meta.error && (!meta.status || meta.status < 400),
          status: meta.upstreamStatus || meta.status || null,
          upstreamStatus: meta.upstreamStatus ?? null,
          latencyMs: nowMs() - started,
          error: meta.error || null,
          detail: meta.upstreamStatus ? `Upstream HTTP ${meta.upstreamStatus}` : null
        };
      }
    } catch (error) {
      stats.requestsError += 1;
      const isAppError = error instanceof AppError;
      if (!isAppError) {
        console.error(
          `[VeilLink] ${id} internal error: ${redactSecrets(error?.stack || error?.message || String(error))}`
        );
      }
      const appError =
        isAppError
          ? error
          : new AppError(500, 'api_error', 'Internal server error.', {
              internalDetail: error?.message || 'Unknown error'
            });
      logError = logError || appError.type || 'api_error';
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
        if (!req.complete) res.setHeader('Connection', 'close');
        sendProtocolError(res, appError, id, protocol);
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } finally {
      bodyLease?.release();
      unregisterActive?.();
      if (acquiredGlobal) globalConcurrency.release('global');
      if (acquiredKey && keyRecord) concurrency.release(keyRecord.id);
      stats.active = Math.max(0, stats.active - 1);
      const durationMs = nowMs() - started;
      let status = res.statusCode;
      if (res.destroyed && !res.writableEnded) status = 499;
      logStore.add({
        id,
        kind: 'request',
        method: req.method,
        path: parsedTarget?.rawPath || parsedTarget?.path || '',
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
