import http from 'node:http';
import {
  AppError,
  applySecurityHeaders,
  clientIp,
  createBodyLease,
  isOpenAIProtocol,
  nowMs,
  readJsonBody,
  readOptionalJsonBody,
  requestId,
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

function parseTarget(req) {
  try {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    return { path: parsed.pathname, search: parsed.search || '' };
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

function hasStoredReferenceValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isStoredContainer(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
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

function anthropicContentHasFileReference(content) {
  const blocks = Array.isArray(content)
    ? content
    : (content && typeof content === 'object' ? [content] : []);
  if (!blocks.length) return false;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.source !== undefined && block.source !== null) {
      if (typeof block.source !== 'object' || Array.isArray(block.source)) return true;
      if (block.source.type === 'file' || hasStoredReferenceValue(block.source.file_id)) {
        return true;
      }
      if (
        block.source.type === 'content' &&
        anthropicContentHasFileReference(block.source.content)
      ) {
        return true;
      }
    }
    if (block.type === 'tool_result' && anthropicContentHasFileReference(block.content)) {
      return true;
    }
  }
  return false;
}

function guardStoredReferences(body, protocol) {
  if (!body || typeof body !== 'object') return;
  if (protocol === 'anthropic') {
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (anthropicContentHasFileReference(message?.content)) {
          throw new AppError(
            400,
            'invalid_request_error',
            'Stored file references are not supported by this gateway.',
            { code: 'unsupported_parameter', param: 'messages' }
          );
        }
      }
    }
    if (isStoredContainer(body.container)) {
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
  if (isStoredContainer(body.container)) {
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
    }
  }
}

const MAX_TRACKED_RESPONSES = 5000;

export function createPublicServer(context) {
  const { configStore, keyStore, logStore, limiter, concurrency, bodyBudget, stats } = context;
  const responseOwners = new Map();

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

  const hasUnsafeInputItem = (input) => {
    const items = Array.isArray(input)
      ? input
      : (input && typeof input === 'object' ? [input] : []);
    return items.some((item) => {
      if (!item || typeof item !== 'object') return false;
      if (item.id === undefined) return false;
      const hasType = typeof item.type === 'string' && item.type.trim() !== '';
      const hasRole = typeof item.role === 'string' && item.role.trim() !== '';
      const hasContent =
        (typeof item.content === 'string' && item.content !== '') ||
        (Array.isArray(item.content) && item.content.length > 0);
      if (!hasType && !hasRole && !hasContent) return true;
      if ((hasRole || item.type === 'message') && !hasContent) return true;
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
    if (body.background === true) {
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
    let bodyLease = null;
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
      let upstream = configStore.runtimeUpstream();
      if (upstream.protocol !== protocol) {
        throw new AppError(409, 'invalid_request_error', 'The active upstream protocol changed. Retry the request.');
      }

      if (route.kind === 'models') {
        const models = syntheticModelList(upstream.protocol, upstream.models);
        writeJson(res, 200, models, requestHeaders(protocol, id));
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
        writeJson(res, 200, model, requestHeaders(protocol, id));
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
      const appError =
        error instanceof AppError
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
