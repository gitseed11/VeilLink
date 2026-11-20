import {
  AppError,
  CrossFieldSecretGuard,
  StreamingSecretScrubber,
  assertNoSplitSecret,
  redactKnownSecret,
  redactSecrets,
  scrubSecretsDeep,
  writeJson
} from '../util.js';
import {
  openUpstreamRequest,
  collectResponse
} from './http-client.js';
import {
  anthropicUpstreamHeaders,
  decodeResponseBody,
  guardErrorBody,
  isEventStream,
  isJsonContentType,
  parseErrorBody,
  publicErrorForUpstream,
  rateLimitHeaders
} from './common.js';
import { SSEParser, sseEvent } from './sse.js';
import { buildUpstreamUrl } from '../util.js';

const MAX_JSON_RESPONSE = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE = 2 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_TOOL_ARGUMENT_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_TOTAL_SIGNATURE_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 15000;

function upstreamErrorMessage(error) {
  if (error?.kind === 'timeout') return 'The local gateway timed out.';
  if (error?.kind === 'aborted') return 'The request was aborted.';
  if (error?.kind === 'too_large') return 'The local gateway response was too large.';
  return 'Could not reach the local gateway.';
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

function messageUsage(message) {
  const usage = message?.usage || {};
  const input =
    (Number(usage.input_tokens) || 0) +
    (Number(usage.cache_read_input_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0);
  return {
    inputTokens: input,
    outputTokens: Number(usage.output_tokens) || 0
  };
}

export async function proxyAnthropic({ req, res, path, search, body, upstream, requestId, route }) {
  const isCountTokens = route?.kind === 'count_tokens' || path === '/v1/messages/count_tokens';
  const stream = !isCountTokens && body?.stream === true;

  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  // count_tokens has no stream field in the current API. Forward the body
  // unchanged so an invalid client request is rejected by the upstream
  // instead of being silently rewritten by the gateway.
  const payload = body;
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');

  const url = buildUpstreamUrl(upstream.baseUrl, path, search);
  const headers = anthropicUpstreamHeaders(req, upstream, { stream, hasBody: true });
  headers['content-length'] = String(payloadBuffer.length);

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
      method: 'POST',
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
      const errorBuffer = await collectResponse(upstreamResponse, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
      const parsedError = guardErrorBody(
        parseErrorBody(errorBuffer, upstreamResponse.headers, [upstream.apiKey]),
        upstream.apiKey
      );
      const mapped = publicErrorForUpstream(status, parsedError.text);
      const forwardedRateLimits = rateLimitHeaders(upstreamResponse.headers, upstream.apiKey);
      assertNoSplitSecret(
        [forwardedRateLimits, mapped.message],
        upstream.apiKey
      );
      writeJson(
        res,
        mapped.status,
        {
          type: 'error',
          error: { type: mapped.type, message: mapped.message },
          request_id: requestId
        },
        {
          'request-id': requestId,
          ...forwardedRateLimits
        }
      );
      return {
        status: mapped.status,
        stream: false,
        upstreamStatus: status,
        model: payload?.model || '',
        error: mapped.type,
        detail: parsedError.text
      };
    }

    if (isCountTokens) {
      const contentType = String(upstreamResponse.headers['content-type'] || 'application/json');
      if (!isJsonContentType(contentType)) {
        await collectResponse(upstreamResponse, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
        throw new AppError(502, 'api_error', 'The local gateway returned an unsupported content type.', {
          internalDetail: `Unsupported upstream content-type: ${contentType}`
        });
      }
      const buffer = await collectBodyOrFail(upstreamResponse, MAX_JSON_RESPONSE, () => clientAborted);
      let parsed;
      try {
        parsed = JSON.parse(decodeResponseBody(buffer, upstreamResponse.headers).toString('utf8'));
      } catch {
        throw new AppError(502, 'api_error', 'The local gateway returned an invalid response.', {
          internalDetail: 'Invalid count_tokens response from upstream.'
        });
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.input_tokens !== 'number') {
        throw new AppError(502, 'api_error', 'The local gateway returned an invalid response.', {
          internalDetail: 'Invalid count_tokens response from upstream.'
        });
      }
      assertNoSplitSecret(parsed, upstream.apiKey);
      const safe = scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : []);
      const forwardedRateLimits = rateLimitHeaders(upstreamResponse.headers, upstream.apiKey);
      assertNoSplitSecret(
        [forwardedRateLimits, safe],
        upstream.apiKey
      );
      writeJson(res, 200, safe, {
        'request-id': requestId,
        ...forwardedRateLimits
      });
      return {
        status: 200,
        stream: false,
        model: payload?.model || safe.model || '',
        inputTokens: Number(parsed.input_tokens) || 0
      };
    }

    if (!stream) {
      const contentType = String(upstreamResponse.headers['content-type'] || 'application/json');
      if (!isJsonContentType(contentType)) {
        await collectResponse(upstreamResponse, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
        throw new AppError(502, 'api_error', 'The local gateway returned an unsupported content type.', {
          internalDetail: `Unsupported upstream content-type: ${contentType}`
        });
      }
      const buffer = await collectBodyOrFail(upstreamResponse, MAX_JSON_RESPONSE, () => clientAborted);
      let decoded;
      let parsed;
      try {
        decoded = decodeResponseBody(buffer, upstreamResponse.headers);
        parsed = JSON.parse(decoded.toString('utf8'));
      } catch {
        throw new AppError(502, 'api_error', 'The local gateway returned an invalid response.', {
          internalDetail: 'Invalid JSON response from upstream.'
        });
      }
      assertNoSplitSecret(parsed, upstream.apiKey);
      const usage = messageUsage(parsed);
      const safe = scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : []);
      const forwardedRateLimits = rateLimitHeaders(upstreamResponse.headers, upstream.apiKey);
      assertNoSplitSecret(
        [forwardedRateLimits, safe],
        upstream.apiKey
      );
      const safeBody = Buffer.from(JSON.stringify(safe), 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', safeBody.length);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('request-id', requestId);
      for (const [name, value] of Object.entries(forwardedRateLimits)) {
        res.setHeader(name, value);
      }
      res.end(safeBody);
      return {
        status: 200,
        stream: false,
        model: parsed?.model || payload?.model || '',
        ...usage
      };
    }

    if (!isEventStream(upstreamResponse)) {
      await collectResponse(upstreamResponse, MAX_ERROR_RESPONSE).catch(() => Buffer.alloc(0));
      throw new AppError(502, 'api_error', 'The local gateway did not return an event stream.', {
        internalDetail: 'Upstream ignored stream=true.'
      });
    }

    return await streamAnthropicResponse({
      res,
      upstreamResponse,
      upstreamRequest,
      requestId,
      model: payload?.model || '',
      started,
      clientAborted: () => clientAborted,
      upstreamApiKey: upstream.apiKey,
      firstEventTimeoutMs: upstream.firstEventTimeoutMs
    });
  } finally {
    res.removeListener('close', onClientClose);
  }
}

function streamAnthropicResponse({
  res,
  upstreamResponse,
  requestId,
  model,
  started,
  clientAborted,
  upstreamApiKey = '',
  firstEventTimeoutMs = 0
}) {
  return new Promise((resolve) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let streamError = null;
    let finished = false;
    let failing = false;
    let drainPending = false;
    let sawAnyEvent = false;
    let sawSemanticEvent = false;
    let sawMessageStop = false;
    let heartbeat = null;
    let firstEventTimer = null;
    let maxBlockIndex = -1;
    let totalToolArgumentBytes = 0;
    let totalSignatureBytes = 0;
    const toolArgumentBuffers = new Map();
    const thinkingBuffers = new Map();
    const pendingMessageDeltas = [];
    const splitScrubber = new StreamingSecretScrubber(
      upstreamApiKey ? [upstreamApiKey] : []
    );
    const crossFieldGuard = new CrossFieldSecretGuard(
      upstreamApiKey ? [upstreamApiKey] : []
    );

    const finish = () => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (!res.writableEnded && !res.destroyed) res.end();
      resolve({
        status: 200,
        stream: true,
        model,
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

    const writeEventFrame = (eventName, data) => {
      const safeEvent = eventName
        ? redactKnownSecret(eventName, upstreamApiKey).replace(/[\r\n]/g, '')
        : '';
      let frame = '';
      if (safeEvent && safeEvent !== 'message') {
        if (!guardText(safeEvent)) return;
        frame += `event: ${safeEvent}\n`;
      }
      for (const line of data.split('\n')) frame += `data: ${line}\n`;
      frame += '\n';
      sawAnyEvent = true;
      writeChunk(frame);
    };

    const writeErrorEvent = (reason = '') => {
      // Keep persisted metadata generic: upstream error text can echo prompt
      // content. Only the local first-event timeout gets a specific client
      // message; arbitrary upstream text is never forwarded.
      streamError = 'Upstream stream error';
      const clientMessage = reason === 'Upstream did not send a response in time.'
        ? 'The upstream did not send a response before the first-event timeout.'
        : 'The local gateway stream failed.';
      if (!res.writableEnded && !res.destroyed) {
        writeChunk(
          sseEvent('error', {
            type: 'error',
            error: { type: 'api_error', message: clientMessage }
          })
        );
      }
    };

    const failStream = (message) => {
      if (finished || failing) return;
      failing = true;
      writeErrorEvent(message);
      upstreamResponse.destroy();
      finish();
    };

    const guardText = (text) => {
      try {
        crossFieldGuard.pushText(text);
        return true;
      } catch {
        failStream('Protected credential detected.');
        return false;
      }
    };

    const guardValue = (value) => {
      try {
        crossFieldGuard.pushValue(value);
        return true;
      } catch {
        failStream('Protected credential detected.');
        return false;
      }
    };

    const applyUsage = (usage) => {
      if (!usage || typeof usage !== 'object') return;
      const hasCache =
        typeof usage.cache_read_input_tokens === 'number' ||
        typeof usage.cache_creation_input_tokens === 'number';
      const hasInput = typeof usage.input_tokens === 'number' || hasCache;
      if (hasInput) {
        const total =
          (Number(usage.input_tokens) || 0) +
          (Number(usage.cache_read_input_tokens) || 0) +
          (Number(usage.cache_creation_input_tokens) || 0);
        if (total > 0 && (hasCache || inputTokens === 0)) inputTokens = total;
      }
      if (typeof usage.output_tokens === 'number') {
        outputTokens = Number(usage.output_tokens) || 0;
      }
    };

    const parser = new SSEParser((event) => {
      if (!event.data || event.data === '[DONE]') return;
      let parsed = null;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = null;
      }
      const semanticEvent =
        (event.event && event.event !== 'message' ? event.event : '') ||
        (parsed && typeof parsed.type === 'string' ? parsed.type : '');
      const semanticLower = String(semanticEvent || '').toLowerCase();
      if (
        semanticLower &&
        semanticLower !== 'ping' &&
        semanticLower !== 'message' &&
        semanticLower !== 'keepalive'
      ) {
        sawSemanticEvent = true;
      }
      if (event.event === 'error' || parsed?.type === 'error') {
        failStream(
          parsed?.error?.message ||
            parsed?.error?.type ||
            event.data ||
            'Upstream stream error'
        );
        return;
      }
      const isMessageStop = parsed?.type === 'message_stop' || event.event === 'message_stop';
      if (isMessageStop) {
        sawMessageStop = true;
      } else if (parsed?.type === 'message_start') {
        applyUsage(parsed.message?.usage);
      } else if (parsed?.type === 'message_delta') {
        applyUsage(parsed.usage);
      }

      // Hold message_delta until any text held back by the streaming scrubber
      // has been flushed in a content block. This keeps the Anthropic event
      // order: all content blocks, then message_delta, then message_stop.
      if (parsed?.type === 'message_delta') {
        if (!guardValue(parsed)) return;
        pendingMessageDeltas.push({
          event: event.event,
          data: JSON.stringify(
            scrubSecretsDeep(parsed, upstreamApiKey ? [upstreamApiKey] : [])
          )
        });
        return;
      }

      let eventData = event.data;
      let parsedChanged = false;
      if (parsed?.type === 'content_block_start') {
        if (Number.isInteger(parsed.index)) {
          maxBlockIndex = Math.max(maxBlockIndex, parsed.index);
        }
        if (parsed.content_block?.type === 'text') {
          if (typeof parsed.content_block.text === 'string' && parsed.content_block.text) {
            const safe = splitScrubber.push(parsed.content_block.text);
            if (safe !== parsed.content_block.text) {
              parsed.content_block.text = safe;
              parsedChanged = true;
            }
          }
        } else if (parsed.content_block?.type === 'thinking' && Number.isInteger(parsed.index)) {
          const buffer = {
            scrubber: new StreamingSecretScrubber(upstreamApiKey ? [upstreamApiKey] : []),
            signature: ''
          };
          thinkingBuffers.set(parsed.index, buffer);
          if (typeof parsed.content_block.thinking === 'string' && parsed.content_block.thinking) {
            const safe = buffer.scrubber.push(parsed.content_block.thinking);
            if (safe !== parsed.content_block.thinking) {
              parsed.content_block.thinking = safe;
              parsedChanged = true;
            }
          }
          if (typeof parsed.content_block.signature === 'string' && parsed.content_block.signature) {
            buffer.signature = parsed.content_block.signature;
            parsed.content_block.signature = '';
            parsedChanged = true;
          }
        } else if (parsed.content_block?.type === 'tool_use' && Number.isInteger(parsed.index)) {
          toolArgumentBuffers.set(parsed.index, { text: '', bytes: 0 });
          if (parsed.content_block.input && typeof parsed.content_block.input === 'object') {
            parsed.content_block.input = scrubSecretsDeep(parsed.content_block.input, [
              upstreamApiKey
            ]);
            parsedChanged = true;
          }
        }
      } else if (
        parsed?.type === 'content_block_delta' &&
        parsed.delta?.type === 'text_delta' &&
        typeof parsed.delta.text === 'string'
      ) {
        const safe = splitScrubber.push(parsed.delta.text);
        if (!safe) return;
        if (safe !== parsed.delta.text) {
          parsed.delta.text = safe;
          parsedChanged = true;
        }
      } else if (
        parsed?.type === 'content_block_delta' &&
        parsed.delta?.type === 'thinking_delta' &&
        Number.isInteger(parsed.index) &&
        typeof parsed.delta.thinking === 'string'
      ) {
        let buffer = thinkingBuffers.get(parsed.index);
        if (!buffer) {
          buffer = {
            scrubber: new StreamingSecretScrubber(upstreamApiKey ? [upstreamApiKey] : []),
            signature: ''
          };
          thinkingBuffers.set(parsed.index, buffer);
        }
        const safe = buffer.scrubber.push(parsed.delta.thinking);
        if (!safe) return;
        if (safe !== parsed.delta.thinking) {
          parsed.delta.thinking = safe;
          parsedChanged = true;
        }
      } else if (
        parsed?.type === 'content_block_delta' &&
        parsed.delta?.type === 'signature_delta' &&
        Number.isInteger(parsed.index) &&
        typeof parsed.delta.signature === 'string'
      ) {
        let buffer = thinkingBuffers.get(parsed.index);
        if (!buffer) {
          buffer = {
            scrubber: new StreamingSecretScrubber(upstreamApiKey ? [upstreamApiKey] : []),
            signature: ''
          };
          thinkingBuffers.set(parsed.index, buffer);
        }
        buffer.signature += parsed.delta.signature;
        totalSignatureBytes += Buffer.byteLength(parsed.delta.signature);
        if (
          Buffer.byteLength(buffer.signature) > MAX_SIGNATURE_BYTES ||
          totalSignatureBytes > MAX_TOTAL_SIGNATURE_BYTES
        ) {
          failStream('Signature exceeded the safety limit.');
          return;
        }
        // Emit the assembled, redacted signature at content_block_stop so a
        // key split across signature deltas cannot be reconstructed.
        return;
      } else if (
        parsed?.type === 'content_block_delta' &&
        parsed.delta?.type === 'input_json_delta' &&
        Number.isInteger(parsed.index) &&
        typeof parsed.delta.partial_json === 'string'
      ) {
        let buffer = toolArgumentBuffers.get(parsed.index);
        if (!buffer) {
          buffer = { text: '', bytes: 0 };
          toolArgumentBuffers.set(parsed.index, buffer);
        }
        buffer.text += parsed.delta.partial_json;
        const deltaBytes = Buffer.byteLength(parsed.delta.partial_json);
        buffer.bytes += deltaBytes;
        totalToolArgumentBytes += deltaBytes;
        if (
          buffer.bytes > MAX_TOOL_ARGUMENT_BYTES ||
          totalToolArgumentBytes > MAX_TOTAL_TOOL_ARGUMENT_BYTES
        ) {
          failStream('Tool arguments exceeded the safety limit.');
          return;
        }
        // Emit the assembled, redacted arguments at content_block_stop so a
        // key split across partial_json deltas cannot be reconstructed.
        return;
      } else if (
        parsed?.type === 'content_block_stop' &&
        Number.isInteger(parsed.index) &&
        (toolArgumentBuffers.has(parsed.index) || thinkingBuffers.has(parsed.index))
      ) {
        if (toolArgumentBuffers.has(parsed.index)) {
          const buffer = toolArgumentBuffers.get(parsed.index);
          toolArgumentBuffers.delete(parsed.index);
          const safeArguments = redactKnownSecret(buffer.text, upstreamApiKey);
          if (safeArguments) {
            if (!guardText(safeArguments)) return;
            writeChunk(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: parsed.index,
                delta: { type: 'input_json_delta', partial_json: safeArguments }
              })
            );
          }
        }
        const thinking = thinkingBuffers.get(parsed.index);
        if (thinking) {
          const pending = redactSecrets(thinking.scrubber.flush());
          if (pending) {
            if (!guardText(pending)) return;
            writeChunk(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: parsed.index,
                delta: { type: 'thinking_delta', thinking: pending }
              })
            );
          }
          if (thinking.signature) {
            const safeSignature = redactKnownSecret(thinking.signature, upstreamApiKey);
            if (safeSignature) {
              if (!guardText(safeSignature)) return;
              writeChunk(
                sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: parsed.index,
                  delta: { type: 'signature_delta', signature: safeSignature }
                })
              );
            }
          }
          thinkingBuffers.delete(parsed.index);
        }
      } else if (isMessageStop) {
        for (const [index, buffer] of toolArgumentBuffers) {
          const safeArguments = redactKnownSecret(buffer.text, upstreamApiKey);
          if (safeArguments) {
            if (!guardText(safeArguments)) return;
            writeChunk(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: safeArguments }
              })
            );
          }
        }
        toolArgumentBuffers.clear();
        for (const [index, buffer] of thinkingBuffers) {
          const pending = redactSecrets(buffer.scrubber.flush());
          if (pending) {
            if (!guardText(pending)) return;
            writeChunk(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'thinking_delta', thinking: pending }
              })
            );
          }
          if (buffer.signature) {
            const safeSignature = redactKnownSecret(buffer.signature, upstreamApiKey);
            if (safeSignature) {
              if (!guardText(safeSignature)) return;
              writeChunk(
                sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index,
                  delta: { type: 'signature_delta', signature: safeSignature }
                })
              );
            }
          }
        }
        thinkingBuffers.clear();
        // Do not flush at content_block_stop: a credential may span two
        // sequential text blocks. Flush any remainder in a new text block
        // before message_stop so no partial prefix is lost.
        const pending = redactSecrets(splitScrubber.flush());
        if (pending) {
          if (!guardText(pending)) return;
          const flushIndex = maxBlockIndex + 1;
          writeChunk(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: flushIndex,
              content_block: { type: 'text', text: '' }
            })
          );
          writeChunk(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: flushIndex,
              delta: { type: 'text_delta', text: pending }
            })
          );
          writeChunk(
            sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: flushIndex
            })
          );
        }
        for (const item of pendingMessageDeltas) {
          writeEventFrame(item.event, item.data);
        }
        pendingMessageDeltas.length = 0;
      }
      if (parsed && typeof parsed === 'object') {
        const safeParsed = scrubSecretsDeep(
          parsed,
          upstreamApiKey ? [upstreamApiKey] : []
        );
        if (!guardValue(safeParsed)) return;
        eventData = JSON.stringify(safeParsed);
      } else {
        eventData = redactKnownSecret(eventData, upstreamApiKey);
        if (!guardText(eventData)) return;
      }

      // Re-emit the event so an upstream credential can never appear verbatim
      // in the public stream, including when an error or key is split.
      const data = redactKnownSecret(eventData, upstreamApiKey);
      writeEventFrame(event.event, data);
      if (isMessageStop && !finished) {
        // message_stop is the protocol's terminal event. Do not wait for the
        // upstream TCP connection to close; some upstreams keep it alive.
        // Mark the stream finished before destroying the socket so its
        // aborted/close handlers cannot append a spurious error event.
        finish();
        upstreamResponse.destroy();
      }
    });
    parser.onError = (error) => {
      failStream(error.message);
    };

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
    res.setHeader('Connection', 'keep-alive');
    for (const [name, value] of Object.entries(forwardedRateLimits)) {
      res.setHeader(name, value);
    }
    res.flushHeaders?.();

    if (firstEventTimeoutMs > 0) {
      firstEventTimer = setTimeout(() => {
        if (finished || sawSemanticEvent) return;
        failStream('Upstream did not send a response in time.');
      }, firstEventTimeoutMs);
      firstEventTimer.unref?.();
    }

    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed && !res.writableNeedDrain) {
        res.write(sseEvent('ping', { type: 'ping' }));
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    upstreamResponse.on('data', (chunk) => {
      if (res.destroyed || finished) return;
      try {
        parser.push(chunk);
      } catch (error) {
        failStream(error.message);
      }
    });

    upstreamResponse.on('end', () => {
      if (finished) return;
      try {
        parser.finish();
      } catch (error) {
        failStream(error.message);
        return;
      }
      if (!finished && !sawAnyEvent) {
        writeErrorEvent('Upstream stream ended without any SSE events.');
      } else if (!finished && !sawMessageStop) {
        writeErrorEvent('Upstream stream ended before message_stop.');
      }
      finish();
    });

    upstreamResponse.on('error', (error) => {
      if (!finished) failStream(error.message);
    });

    upstreamResponse.on('aborted', () => {
      if (!finished && !clientAborted()) {
        failStream('Upstream stream was interrupted before completion.');
      } else if (!finished) {
        streamError = 'Client disconnected';
        finish();
      }
    });

    upstreamResponse.on('close', () => {
      if (!finished && !clientAborted()) {
        failStream('Upstream connection closed before completion.');
      } else if (!finished) {
        streamError = 'Client disconnected';
        finish();
      }
    });

    res.once('close', () => {
      if (finished) return;
      if (!res.writableEnded) {
        streamError = 'Client disconnected';
      }
      upstreamResponse.destroy();
      finish();
    });
  });
}
