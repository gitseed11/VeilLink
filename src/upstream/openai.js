import {
  AppError,
  CrossFieldSecretGuard,
  StreamingSecretScrubber,
  assertNoSplitSecret,
  isOpenAIProtocol,
  redactKnownSecret,
  redactSecrets,
  scrubSecretsDeep,
  writeJson
} from '../util.js';
import { openUpstreamRequest, collectResponse } from './http-client.js';
import {
  openaiUpstreamHeaders,
  decodeResponseBody,
  guardErrorBody,
  isEventStream,
  parseErrorBody,
  publicErrorForUpstream,
  rateLimitHeaders,
  safeUpstreamErrorType
} from './common.js';
import { SSEParser } from './sse.js';
import { buildUpstreamUrl } from '../util.js';

const MAX_JSON_RESPONSE = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15000;

const RESPONSES_TERMINAL = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete'
]);

const OPAQUE_USAGE_KEYS = new Set([
  'encrypted_content',
  'b64_json',
  'data',
  'result'
]);

function hasOpaqueUsageKey(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') stack.push(item);
      }
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (OPAQUE_USAGE_KEYS.has(String(key).toLowerCase())) return true;
      if (item && typeof item === 'object') stack.push(item);
    }
  }
  return false;
}

function sanitizeUsageForOutput(value) {
  if (!value || typeof value !== 'object') return value;
  const root = Array.isArray(value) ? [] : {};
  const stack = [[value, root]];
  while (stack.length > 0) {
    const [source, target] = stack.pop();
    if (Array.isArray(source)) {
      for (const item of source) {
        if (item && typeof item === 'object') {
          const child = Array.isArray(item) ? [] : {};
          target.push(child);
          stack.push([item, child]);
        } else {
          target.push(item);
        }
      }
    } else {
      for (const [key, item] of Object.entries(source)) {
        if (OPAQUE_USAGE_KEYS.has(String(key).toLowerCase())) continue;
        if (item && typeof item === 'object') {
          const child = Array.isArray(item) ? [] : {};
          target[key] = child;
          stack.push([item, child]);
        } else {
          target[key] = item;
        }
      }
    }
  }
  return root;
}

function sanitizeUsageFields(value) {
  if (!value || typeof value !== 'object') return;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') stack.push(item);
      }
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key.toLowerCase() === 'usage' && item && typeof item === 'object') {
        if (hasOpaqueUsageKey(item)) {
          current[key] = sanitizeUsageForOutput(item);
        }
      } else if (item && typeof item === 'object') {
        stack.push(item);
      }
    }
  }
}

function upstreamErrorMessage(error) {
  if (error?.kind === 'timeout') return 'The local gateway timed out.';
  if (error?.kind === 'aborted') return 'The request was aborted.';
  if (error?.kind === 'too_large') return 'The local gateway response was too large.';
  return 'Could not reach the local gateway.';
}

function isJsonContentType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

async function collectBodyOrFail(response, limit, isClientAborted = () => false) {
  try {
    return await collectResponse(response, limit);
  } catch (error) {
    if (isClientAborted()) {
      throw new AppError(499, 'api_error', 'Client disconnected.', {
        internalDetail: 'Client disconnected while reading the upstream body.'
      });
    }
    throw new AppError(502, 'api_error', upstreamErrorMessage(error), {
      internalDetail: redactSecrets(error.message)
    });
  }
}

function scalarErrorField(value) {
  return typeof value === 'string'
    ? value.slice(0, 200)
    : typeof value === 'number'
      ? String(value)
      : null;
}

function normalizedChatError(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const error = source.error && typeof source.error === 'object' ? source.error : source;
  return {
    error: {
      message:
        typeof error.message === 'string' && error.message
          ? error.message
          : 'Upstream stream error',
      type: safeUpstreamErrorType(error.type, 'api_error'),
      param: scalarErrorField(error.param),
      code: scalarErrorField(error.code)
    }
  };
}

function normalizedResponsesError(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const error = source.error && typeof source.error === 'object' ? source.error : source;
  const payload = {
    type: 'error',
    code: scalarErrorField(error.code) || 'upstream_error',
    message:
      typeof error.message === 'string' && error.message
        ? error.message
        : 'Upstream stream error',
    param: scalarErrorField(error.param)
  };
  if (Number.isInteger(source.sequence_number)) {
    payload.sequence_number = source.sequence_number;
  }
  return payload;
}

function usageFromResponse(response) {
  if (response?.object === 'response.input_tokens') {
    return {
      inputTokens: Number(response.input_tokens) || 0,
      outputTokens: 0
    };
  }
  const usage = response?.usage;
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens) || 0,
    outputTokens: Number(usage.output_tokens ?? usage.completion_tokens) || 0
  };
}

function usageFromEvent(protocol, parsed) {
  if (protocol === 'openai-responses') {
    return usageFromResponse(parsed?.response);
  }
  if (parsed?.usage) {
    return {
      inputTokens: Number(parsed.usage.prompt_tokens) || 0,
      outputTokens: Number(parsed.usage.completion_tokens) || 0
    };
  }
  return { inputTokens: 0, outputTokens: 0 };
}

function routeMethod(route) {
  if (
    route.kind === 'responses_get' ||
    route.kind === 'responses_input_items' ||
    route.kind === 'chat_get' ||
    route.kind === 'chat_list' ||
    route.kind === 'chat_messages'
  ) {
    return 'GET';
  }
  if (route.kind === 'responses_delete' || route.kind === 'chat_delete') {
    return 'DELETE';
  }
  return 'POST';
}

function routePath(route) {
  switch (route.kind) {
    case 'responses_create':
      return '/v1/responses';
    case 'responses_compact':
      return '/v1/responses/compact';
    case 'responses_input_tokens':
      return '/v1/responses/input_tokens';
    case 'responses_get':
      return `/v1/responses/${encodeURIComponent(route.id)}`;
    case 'responses_delete':
      return `/v1/responses/${encodeURIComponent(route.id)}`;
    case 'responses_cancel':
      return `/v1/responses/${encodeURIComponent(route.id)}/cancel`;
    case 'responses_input_items':
      return `/v1/responses/${encodeURIComponent(route.id)}/input_items`;
    case 'chat_create':
      return '/v1/chat/completions';
    case 'chat_get':
      return `/v1/chat/completions/${encodeURIComponent(route.id)}`;
    case 'chat_update':
      return `/v1/chat/completions/${encodeURIComponent(route.id)}`;
    case 'chat_delete':
      return `/v1/chat/completions/${encodeURIComponent(route.id)}`;
    case 'chat_list':
      return '/v1/chat/completions';
    case 'chat_messages':
      return `/v1/chat/completions/${encodeURIComponent(route.id)}/messages`;
    default:
      throw new AppError(404, 'not_found_error', 'Not found.');
  }
}

function routeHasBody(route, body) {
  return (
    route.kind === 'responses_create' ||
    route.kind === 'responses_compact' ||
    route.kind === 'chat_create' ||
    route.kind === 'chat_update' ||
    (route.kind === 'responses_cancel' && body !== null) ||
    (route.kind === 'responses_input_tokens' && body !== null)
  );
}

function queryHasStream(search) {
  try {
    return new URLSearchParams(search).get('stream') === 'true';
  } catch {
    return false;
  }
}

function routeStreams(route, body, search) {
  if (route.kind === 'responses_create' || route.kind === 'chat_create') {
    return body?.stream === true;
  }
  if (route.kind === 'responses_get') return queryHasStream(search);
  return false;
}

function openaiErrorPayload(mapped) {
  return {
    error: {
      message: mapped.message,
      type: mapped.type,
      param: null,
      code: null
    }
  };
}

async function writeUpstreamError({ res, response, requestId, upstream }) {
  const status = response.statusCode || 502;
  const buffer = await collectResponse(response, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
  const parsed = guardErrorBody(
    parseErrorBody(buffer, response.headers, [upstream.apiKey]),
    upstream.apiKey
  );
  const mapped = publicErrorForUpstream(status, parsed.text);
  let payload = openaiErrorPayload(mapped);
  // 413, 502 and 529 stay generic: the upstream's own message can include
  // request fragments or internal implementation details.
  if (mapped.status !== 502 && mapped.status !== 529 && mapped.status !== 413) {
    const source = parsed.parsed;
    if (source && typeof source === 'object' && source.error && typeof source.error === 'object') {
      try {
        assertNoSplitSecret(source, upstream.apiKey);
        const safe = scrubSecretsDeep(source, upstream.apiKey ? [upstream.apiKey] : []);
        const scalar = (value) =>
          typeof value === 'string'
            ? value.slice(0, 200)
            : typeof value === 'number'
              ? String(value)
              : null;
        payload = {
          error: {
            message:
              typeof safe.error.message === 'string' && safe.error.message
                ? safe.error.message
                : mapped.message,
            // Preserve explicit OpenAI error types such as insufficient_quota
            // when the status is not a local gateway failure. Clients branch
            // on type/code and must not treat a billing error as a retryable
            // rate limit.
            type: mapped.status === 502 || mapped.status === 529
              ? mapped.type
              : safeUpstreamErrorType(safe.error.type, mapped.type),
            param: scalar(safe.error.param),
            code: scalar(safe.error.code)
          }
        };
      } catch {
        payload = {
          error: {
            message: 'The local gateway rejected an unsafe upstream error response.',
            type: mapped.type,
            param: null,
            code: null
          }
        };
      }
    }
  }
  const forwardedRateLimits = rateLimitHeaders(response.headers, upstream.apiKey);
  assertNoSplitSecret(
    [forwardedRateLimits, payload],
    upstream.apiKey
  );
  writeJson(res, mapped.status, payload, {
    'request-id': requestId,
    'x-request-id': requestId,
    ...forwardedRateLimits
  });
  return {
    status: mapped.status,
    upstreamStatus: status,
    stream: false,
    error: payload?.error?.type || mapped.type,
    detail: parsed.text
  };
}

export async function proxyOpenAI({ req, res, path, search, body, upstream, requestId, route }) {
  if (!isOpenAIProtocol(upstream.protocol)) {
    throw new AppError(500, 'api_error', 'Unsupported upstream protocol.');
  }
  const protocol = upstream.protocol;
  const method = routeMethod(route);
  const upstreamPath = routePath(route);
  const stream = routeStreams(route, body, search);
  const hasBody = routeHasBody(route, body);
  let payloadBuffer = null;
  if (hasBody && body !== null) {
    payloadBuffer = Buffer.from(JSON.stringify(body), 'utf8');
  }

  const url = buildUpstreamUrl(upstream.baseUrl, upstreamPath, search);
  const headers = openaiUpstreamHeaders(req, upstream, {
    stream,
    hasBody: payloadBuffer !== null
  });
  if (payloadBuffer) headers['content-length'] = String(payloadBuffer.length);

  const started = Date.now();
  let upstreamRequest = null;
  let upstreamResponse = null;
  let clientAborted = false;
  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      clientAborted = true;
      abortController.abort();
      upstreamRequest?.destroy();
    }
  };
  res.once('close', onClientClose);

  try {
    ({ request: upstreamRequest, response: upstreamResponse } = await openUpstreamRequest({
      url,
      method,
      headers,
      body: payloadBuffer,
      timeoutMs: upstream.timeoutMs,
      signal: abortController.signal
    }));
  } catch (error) {
    if (clientAborted || error?.kind === 'aborted' || error?.name === 'AbortError') {
      throw new AppError(499, 'api_error', 'Client disconnected.', {
        internalDetail: 'Client disconnected before upstream response headers.'
      });
    }
    throw new AppError(502, 'api_error', upstreamErrorMessage(error), {
      internalDetail: redactSecrets(error.message)
    });
  }
  if (clientAborted || res.destroyed) {
    upstreamRequest.destroy();
    throw new AppError(499, 'api_error', 'Client disconnected.', {
      internalDetail: 'Client disconnected before upstream response headers.'
    });
  }

  try {
    const status = upstreamResponse.statusCode || 502;
    if (status < 200 || status >= 300) {
      return await writeUpstreamError({
        res,
        response: upstreamResponse,
        requestId,
        upstream
      });
    }

    const upstreamIsSse = isEventStream(upstreamResponse);
    if (stream) {
      if (!upstreamIsSse) {
        await collectResponse(upstreamResponse, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
        throw new AppError(502, 'api_error', 'The local gateway did not return an event stream.', {
          internalDetail: 'Upstream ignored stream=true.'
        });
      }
      return await streamOpenAIResponse({
        res,
        upstreamResponse,
        upstreamRequest,
        requestId,
        protocol,
        upstreamApiKey: upstream.apiKey,
        model: body?.model || '',
        includeUsage:
          protocol === 'openai-chat' &&
          body?.stream_options?.include_usage === true,
        firstEventTimeoutMs: upstream.firstEventTimeoutMs,
        started,
        clientAborted: () => clientAborted
      });
    }

    if (upstreamIsSse) {
      await collectResponse(upstreamResponse, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
      throw new AppError(502, 'api_error', 'The local gateway returned an unexpected event stream.', {
        internalDetail: 'Upstream returned SSE for a non-streaming request.'
      });
    }

    const buffer = await collectBodyOrFail(upstreamResponse, MAX_JSON_RESPONSE, () => clientAborted);
    let decoded;
    try {
      decoded = buffer.length ? decodeResponseBody(buffer, upstreamResponse.headers) : Buffer.alloc(0);
    } catch {
      throw new AppError(502, 'api_error', 'The local gateway returned an unsupported response encoding.', {
        internalDetail: 'Unsupported upstream content encoding.'
      });
    }
    const contentType = String(upstreamResponse.headers['content-type'] || 'application/json');
    if (!decoded.length || !isJsonContentType(contentType)) {
      throw new AppError(502, 'api_error', 'The local gateway returned an unsupported content type.', {
        internalDetail: `Unsupported upstream content-type: ${contentType}`
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(decoded.toString('utf8'));
    } catch {
      throw new AppError(502, 'api_error', 'The local gateway returned an invalid response.', {
        internalDetail: 'Invalid JSON response from upstream.'
      });
    }
    assertNoSplitSecret(parsed, upstream.apiKey);
    const safe = scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : []);
    sanitizeUsageFields(safe);
    const forwardedRateLimits = rateLimitHeaders(upstreamResponse.headers, upstream.apiKey);
    assertNoSplitSecret(
      [forwardedRateLimits, safe],
      upstream.apiKey
    );
    writeJson(res, status, safe, {
      'request-id': requestId,
      'x-request-id': requestId,
      ...forwardedRateLimits
    });
    const usage = usageFromResponse(safe);
    return {
      status,
      stream: false,
      model: body?.model || safe?.model || '',
      responseId: route.kind === 'responses_create' && typeof safe?.id === 'string'
        ? safe.id
        : undefined,
      ...usage
    };
  } finally {
    res.removeListener('close', onClientClose);
  }
}

function streamOpenAIResponse({
  res,
  upstreamResponse,
  requestId,
  protocol,
  upstreamApiKey = '',
  model,
  includeUsage = false,
  firstEventTimeoutMs = 0,
  started,
  clientAborted
}) {
  return new Promise((resolve) => {
    let finished = false;
    let failing = false;
    let drainPending = false;
    let streamError = null;
    let heartbeat = null;
    let firstEventTimer = null;
    let sawSemanticEvent = false;
    let sawTerminal = false;
    let sawDone = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastSequence = -1;
    let seenModel = model;
    let responseId = '';
    const secrets = upstreamApiKey ? [upstreamApiKey] : [];
    const crossFieldGuard = new CrossFieldSecretGuard(secrets);
    const deltaScrubbers = new Map();
    let heldUsage = null;
    let heldUsageEnvelope = null;
    let sawStandaloneUsage = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (!res.writableEnded && !res.destroyed) res.end();
      resolve({
        status: 200,
        stream: true,
        model: seenModel,
        responseId: responseId || undefined,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - started,
        error: streamError || undefined
      });
    };

    const writeChunk = (chunk) => {
      if (res.writableEnded || res.destroyed) return false;
      const ok = res.write(chunk);
      if (!ok && !drainPending) {
        drainPending = true;
        upstreamResponse.pause();
        res.once('drain', () => {
          drainPending = false;
          if (!res.destroyed) upstreamResponse.resume();
        });
      }
      return ok;
    };

    const writeFrame = (eventName, data, { skipGuard = false } = {}) => {
      const safeEvent = eventName
        ? redactKnownSecret(eventName, upstreamApiKey).replace(/[\r\n]/g, '')
        : '';
      let frame = '';
      if (safeEvent && safeEvent !== 'message') {
        if (!skipGuard) {
          try {
            crossFieldGuard.pushText(safeEvent);
          } catch {
            failStream();
            return;
          }
        }
        frame += `event: ${safeEvent}\n`;
      }
      for (const line of String(data).split('\n')) frame += `data: ${line}\n`;
      frame += '\n';
      writeChunk(frame);
    };

    const writeHeldUsage = () => {
      if (!includeUsage || !heldUsage || sawStandaloneUsage || finished) return true;
      const envelope = heldUsageEnvelope || {};
      const chunk = {
        id: envelope.id || 'chatcmpl-veillink',
        object: 'chat.completion.chunk',
        created: Number.isFinite(envelope.created)
          ? envelope.created
          : Math.floor(Date.now() / 1000),
        model: envelope.model || model || '',
        choices: [],
        usage: heldUsage
      };
      if (envelope.system_fingerprint !== undefined) {
        chunk.system_fingerprint = envelope.system_fingerprint;
      }
      if (envelope.service_tier !== undefined) {
        chunk.service_tier = envelope.service_tier;
      }
      try {
        assertNoSplitSecret(chunk, upstreamApiKey);
        crossFieldGuard.pushValue(chunk);
      } catch {
        failStream();
        return false;
      }
      writeFrame('', JSON.stringify(chunk));
      heldUsage = null;
      heldUsageEnvelope = null;
      return true;
    };

    const flushScrubbers = (choiceIndex = null) => {
      let written = 0;
      for (const [key, entry] of deltaScrubbers) {
        if (choiceIndex !== null && entry.choiceIndex !== choiceIndex) continue;
        const pending = redactSecrets(entry.scrubber.flush());
        deltaScrubbers.delete(key);
        if (!pending) continue;
        try {
          crossFieldGuard.pushText(pending);
        } catch {
          failStream();
          return written;
        }
        written += 1;
        if (entry.kind === 'chat_text') {
          const template = entry.template || {};
          const choice = Array.isArray(template.choices) ? template.choices[0] || {} : {};
          writeFrame(
            '',
            JSON.stringify({
              ...template,
              choices: [
                {
                  ...choice,
                  index: entry.choiceIndex,
                  delta: { [entry.field]: pending },
                  finish_reason: null
                }
              ]
            })
          );
        } else if (entry.kind === 'chat_tool_args') {
          const template = entry.template || {};
          const choice = Array.isArray(template.choices) ? template.choices[0] || {} : {};
          writeFrame(
            '',
            JSON.stringify({
              ...template,
              choices: [
                {
                  ...choice,
                  index: entry.choiceIndex,
                  delta: {
                    tool_calls: [
                      {
                        index: entry.toolIndex,
                        function: { arguments: pending }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })
          );
        } else if (entry.kind === 'chat_function_args') {
          const template = entry.template || {};
          const choice = Array.isArray(template.choices) ? template.choices[0] || {} : {};
          writeFrame(
            '',
            JSON.stringify({
              ...template,
              choices: [
                {
                  ...choice,
                  index: entry.choiceIndex,
                  delta: { function_call: { arguments: pending } },
                  finish_reason: null
                }
              ]
            })
          );
        } else if (entry.kind === 'responses_delta') {
          lastSequence += 1;
          writeFrame(
            entry.eventType,
            JSON.stringify({
              ...entry.template,
              delta: pending,
              sequence_number: lastSequence
            })
          );
        }
      }
      return written;
    };

    const failStream = (message = 'The local gateway stream failed.') => {
      if (finished || failing) return;
      failing = true;
      streamError = 'Upstream stream error';
      if (!res.writableEnded && !res.destroyed) {
        if (protocol === 'openai-responses') {
          writeFrame('error', JSON.stringify({
            type: 'error',
            code: 'stream_failed',
            message,
            param: null,
            sequence_number: lastSequence + 1
          }), { skipGuard: true });
        } else {
          writeFrame('', JSON.stringify({
            error: {
              message,
              type: 'api_error',
              param: null,
              code: 'stream_failed'
            }
          }));
        }
      }
      upstreamResponse.destroy();
      finish();
    };

    const scrubDelta = (parsed, eventType) => {
      if (protocol === 'openai-chat') {
        if (!Array.isArray(parsed.choices)) return;
        parsed.choices.forEach((choice, choicePosition) => {
          if (!choice || typeof choice !== 'object') return;
          const choiceIndex = Number.isInteger(choice.index) ? choice.index : choicePosition;
          const delta = choice.delta;
          if (delta && typeof delta === 'object') {
            for (const field of ['content', 'reasoning_content', 'refusal']) {
              if (typeof delta[field] !== 'string') continue;
              const key = `chat:${choiceIndex}:${field}`;
              let entry = deltaScrubbers.get(key);
              if (!entry) {
                entry = {
                  kind: 'chat_text',
                  field,
                  choiceIndex,
                  scrubber: new StreamingSecretScrubber(secrets),
                  template: null
                };
                deltaScrubbers.set(key, entry);
              }
              delta[field] = entry.scrubber.push(delta[field]);
            }
            if (Array.isArray(delta.tool_calls)) {
              delta.tool_calls.forEach((call, callPosition) => {
                if (!call || typeof call !== 'object') return;
                const toolIndex = Number.isInteger(call.index) ? call.index : callPosition;
                const args = call.function?.arguments;
                if (typeof args !== 'string') return;
                const key = `chat:${choiceIndex}:tool:${toolIndex}`;
                let entry = deltaScrubbers.get(key);
                if (!entry) {
                  entry = {
                    kind: 'chat_tool_args',
                    choiceIndex,
                    toolIndex,
                    scrubber: new StreamingSecretScrubber(secrets),
                    template: null
                  };
                  deltaScrubbers.set(key, entry);
                }
                call.function.arguments = entry.scrubber.push(args);
              });
            }
            const legacyArgs = delta.function_call?.arguments;
            if (typeof legacyArgs === 'string') {
              const key = `chat:${choiceIndex}:function`;
              let entry = deltaScrubbers.get(key);
              if (!entry) {
                entry = {
                  kind: 'chat_function_args',
                  choiceIndex,
                  scrubber: new StreamingSecretScrubber(secrets),
                  template: null
                };
                deltaScrubbers.set(key, entry);
              }
              delta.function_call.arguments = entry.scrubber.push(legacyArgs);
            }
          }
        });
        return;
      }

      if (typeof parsed.delta !== 'string' || !String(eventType).endsWith('.delta')) return;
      const key = [
        'responses',
        eventType,
        parsed.item_id || '',
        parsed.output_index ?? '',
        parsed.content_index ?? '',
        parsed.summary_index ?? ''
      ].join(':');
      let entry = deltaScrubbers.get(key);
      if (!entry) {
        entry = {
          kind: 'responses_delta',
          eventType,
          template: {
            type: eventType,
            item_id: parsed.item_id,
            output_index: parsed.output_index,
            content_index: parsed.content_index,
            summary_index: parsed.summary_index
          },
          scrubber: new StreamingSecretScrubber(secrets)
        };
        deltaScrubbers.set(key, entry);
      }
      parsed.delta = entry.scrubber.push(parsed.delta);
    };

    const processDataEvent = (event) => {
      if (!event.data) return;
      if (protocol === 'openai-chat' && event.data.trim() === '[DONE]') {
        sawDone = true;
        sawTerminal = true;
        flushScrubbers();
        if (finished) return;
        if (!writeHeldUsage()) return;
        writeChunk('data: [DONE]\n\n');
        finish();
        upstreamResponse.destroy();
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        failStream();
        return;
      }

      const semanticType =
        (event.event && event.event !== 'message' ? event.event : '') ||
        (parsed && typeof parsed.type === 'string' ? parsed.type : '');
      if (protocol === 'openai-chat') {
        const hasChatChoice =
          parsed &&
          Array.isArray(parsed.choices) &&
          parsed.choices.some((choice) => {
            if (!choice || typeof choice !== 'object') return false;
            const deltaOk =
              choice.delta &&
              typeof choice.delta === 'object' &&
              !Array.isArray(choice.delta) &&
              Object.keys(choice.delta).length > 0;
            const messageOk =
              choice.message &&
              typeof choice.message === 'object' &&
              !Array.isArray(choice.message) &&
              Object.keys(choice.message).length > 0;
            return (
              deltaOk ||
              messageOk ||
              (typeof choice.finish_reason === 'string' &&
                choice.finish_reason.trim() !== '')
            );
          });
        if (hasChatChoice || parsed?.error) sawSemanticEvent = true;
      } else {
        const semanticLower = String(semanticType || '').toLowerCase();
        if (
          semanticLower &&
          semanticLower !== 'ping' &&
          semanticLower !== 'message' &&
          semanticLower !== 'keepalive'
        ) {
          sawSemanticEvent = true;
        }
      }

      if (protocol === 'openai-chat' && parsed?.error) {
        sawTerminal = true;
        streamError = 'Upstream stream error';
        try {
          assertNoSplitSecret(parsed, upstreamApiKey);
        } catch {
          failStream();
          return;
        }
        const safe = scrubSecretsDeep(parsed, secrets);
        try {
          crossFieldGuard.pushValue(parsed);
        } catch {
          failStream();
          return;
        }
        writeFrame('', JSON.stringify(normalizedChatError(safe)));
        finish();
        upstreamResponse.destroy();
        return;
      }

      let eventType = event.event;
      if (protocol === 'openai-responses') {
        eventType = typeof parsed?.type === 'string' ? parsed.type : event.event;
        if (typeof parsed?.response?.model === 'string') {
          seenModel = parsed.response.model;
        }
        if (typeof parsed?.response?.id === 'string') {
          responseId = parsed.response.id;
        }
      } else if (typeof parsed?.model === 'string') {
        seenModel = parsed.model;
      }

      if (protocol === 'openai-responses' && eventType === 'error') {
        sawTerminal = true;
        streamError = 'Upstream stream error';
        try {
          assertNoSplitSecret(parsed, upstreamApiKey);
        } catch {
          failStream();
          return;
        }
        const safeError = scrubSecretsDeep(parsed, secrets);
        try {
          crossFieldGuard.pushValue(parsed);
        } catch {
          failStream();
          return;
        }
        writeFrame('error', JSON.stringify(normalizedResponsesError(safeError)));
        finish();
        upstreamResponse.destroy();
        return;
      }

      const terminal = protocol === 'openai-responses' && RESPONSES_TERMINAL.has(eventType);
      if (terminal) {
        sawTerminal = true;
        if (eventType === 'response.failed') streamError = 'Upstream response failed';
      }

      const usage = usageFromEvent(protocol, parsed);
      if (usage.inputTokens) inputTokens = usage.inputTokens;
      if (usage.outputTokens) outputTokens = usage.outputTokens;

      let heldUsageRaw = null;
      if (protocol === 'openai-chat' && includeUsage && parsed.usage) {
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        if (choices.length === 0) {
          sawStandaloneUsage = true;
          heldUsage = null;
          heldUsageEnvelope = null;
        } else {
          heldUsageRaw = parsed.usage;
          parsed.usage = null;
        }
      }
      if (protocol === 'openai-chat' && parsed.usage) {
        parsed.usage = sanitizeUsageForOutput(parsed.usage);
      }

      scrubDelta(parsed, eventType);
      const finishedChoices = protocol === 'openai-chat' && Array.isArray(parsed.choices)
        ? parsed.choices
            .map((choice, position) => ({ choice, position }))
            .filter(({ choice }) =>
              choice &&
              choice.finish_reason !== null &&
              choice.finish_reason !== undefined
            )
            .map(({ choice, position }) =>
              Number.isInteger(choice.index) ? choice.index : position
            )
        : [];
      try {
        if (heldUsageRaw) {
          assertNoSplitSecret(heldUsageRaw, upstreamApiKey);
          crossFieldGuard.pushValue(heldUsageRaw);
        }
        assertNoSplitSecret(parsed, upstreamApiKey);
      } catch {
        failStream();
        return;
      }
      const safe = scrubSecretsDeep(parsed, secrets);
      sanitizeUsageFields(safe);
      if (heldUsageRaw) {
        heldUsage = scrubSecretsDeep(sanitizeUsageForOutput(heldUsageRaw), secrets);
        heldUsageEnvelope = {
          id: safe.id,
          created: safe.created,
          model: safe.model
        };
        if (safe.system_fingerprint !== undefined) {
          heldUsageEnvelope.system_fingerprint = safe.system_fingerprint;
        }
        if (safe.service_tier !== undefined) {
          heldUsageEnvelope.service_tier = safe.service_tier;
        }
        heldUsageRaw = null;
      }
      for (const entry of deltaScrubbers.values()) {
        if (!entry.template) entry.template = safe;
      }
      const responsesFlushPoint = protocol === 'openai-responses' &&
        !String(eventType).endsWith('.delta') &&
        typeof parsed?.delta !== 'string';
      if (terminal || responsesFlushPoint) {
        flushScrubbers();
      } else {
        for (const choiceIndex of finishedChoices) flushScrubbers(choiceIndex);
      }
      if (finished) return;
      try {
        crossFieldGuard.pushValue(safe);
      } catch {
        failStream();
        return;
      }
      if (protocol === 'openai-responses') {
        if (
          Number.isFinite(safe.sequence_number) &&
          safe.sequence_number <= lastSequence
        ) {
          safe.sequence_number = lastSequence + 1;
        }
        if (Number.isFinite(safe.sequence_number)) {
          lastSequence = Math.max(lastSequence, safe.sequence_number);
        }
      }
      const frameEvent = protocol === 'openai-chat'
        ? ''
        : (eventType === 'message' ? '' : eventType);
      writeFrame(frameEvent, JSON.stringify(safe));
      if (terminal && !finished) {
        finish();
        upstreamResponse.destroy();
      }
    };

    const parser = new SSEParser((event) => {
      if (finished) return;
      processDataEvent(event);
    });
    parser.onError = () => failStream();

    const forwardedRateLimits = rateLimitHeaders(upstreamResponse.headers, upstreamApiKey);
    for (const [name, value] of Object.entries(forwardedRateLimits)) {
      try {
        crossFieldGuard.pushText(name);
        crossFieldGuard.pushText(String(value));
      } catch {
        failStream('Protected credential detected.');
        return;
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('request-id', requestId);
    res.setHeader('x-request-id', requestId);
    res.setHeader('Connection', 'keep-alive');
    for (const [name, value] of Object.entries(forwardedRateLimits)) {
      res.setHeader(name, value);
    }
    res.flushHeaders?.();

    if (firstEventTimeoutMs > 0) {
      firstEventTimer = setTimeout(() => {
        if (finished || sawSemanticEvent) return;
        failStream('The upstream gateway did not send a response in time.');
      }, firstEventTimeoutMs);
      firstEventTimer.unref?.();
    }

    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed && !res.writableNeedDrain) {
        writeChunk(': keepalive\n\n');
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    upstreamResponse.on('data', (chunk) => {
      if (res.destroyed || finished) return;
      try {
        parser.push(chunk);
      } catch {
        failStream();
      }
    });

    upstreamResponse.on('end', () => {
      if (finished) return;
      try {
        parser.finish();
      } catch {
        failStream();
        return;
      }
      if (finished) return;
      if (protocol === 'openai-chat') {
        if (sawDone) {
          finish();
        } else {
          failStream();
        }
      } else if (sawTerminal) {
        finish();
      } else {
        failStream();
      }
    });

    upstreamResponse.on('error', () => {
      if (!finished) failStream();
    });

    upstreamResponse.on('aborted', () => {
      if (!finished && !clientAborted()) {
        failStream();
      } else if (!finished) {
        streamError = 'Client disconnected';
        finish();
      }
    });

    upstreamResponse.on('close', () => {
      if (!finished && !clientAborted()) {
        failStream();
      } else if (!finished) {
        streamError = 'Client disconnected';
        finish();
      }
    });

    res.once('close', () => {
      if (finished) return;
      if (!res.writableEnded) streamError = 'Client disconnected';
      upstreamResponse.destroy();
      finish();
    });
  });
}
