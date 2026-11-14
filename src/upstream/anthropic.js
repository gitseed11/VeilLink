import {
  AppError,
  StreamingSecretScrubber,
  assertNoSplitSecret,
  estimateInputTokens,
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
  isEventStream,
  parseErrorBody,
  publicErrorForUpstream
} from './common.js';
import { SSEParser, sseEvent } from './sse.js';
import { buildUpstreamUrl } from '../util.js';

const MAX_JSON_RESPONSE = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE = 2 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 8 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15000;

function upstreamErrorMessage(error) {
  if (error?.kind === 'timeout') return 'The local gateway timed out.';
  if (error?.kind === 'aborted') return 'The request was aborted.';
  if (error?.kind === 'too_large') return 'The local gateway response was too large.';
  return 'Could not reach the local gateway.';
}

function messageUsage(message) {
  const usage = message?.usage || {};
  return {
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0
  };
}

export function messageToSse(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const header = {
    ...message,
    content: []
  };
  let out = sseEvent('message_start', { type: 'message_start', message: header });
  content.forEach((block, index) => {
    if (block?.type === 'text') {
      out += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { ...block, text: '' }
      });
      out += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: String(block.text || '') }
      });
    } else if (block?.type === 'tool_use') {
      out += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { ...block, input: {} }
      });
      out += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {})
        }
      });
    } else if (block?.type === 'thinking') {
      out += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      });
      out += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: String(block.thinking || '') }
      });
      if (typeof block.signature === 'string' && block.signature) {
        out += sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature }
        });
      }
    } else {
      out += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: block
      });
    }
    out += sseEvent('content_block_stop', { type: 'content_block_stop', index });
  });
  out += sseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message?.stop_reason || 'end_turn',
      stop_sequence: message?.stop_sequence ?? null
    },
    usage: message?.usage || {}
  });
  out += sseEvent('message_stop', { type: 'message_stop' });
  return out;
}

function syntheticModels(upstream) {
  const id = upstream.model || 'veillink-default';
  return {
    data: [
      {
        type: 'model',
        id,
        display_name: id,
        created_at: '2026-01-01T00:00:00Z'
      }
    ],
    has_more: false,
    first_id: id,
    last_id: id
  };
}

export async function proxyAnthropic({ req, res, path, search, body, upstream, requestId }) {
  const isModels = path === '/v1/models';
  const isCountTokens = path === '/v1/messages/count_tokens';
  const stream = !isModels && !isCountTokens && body?.stream === true;

  if (isModels && upstream.model) {
    writeJson(res, 200, syntheticModels(upstream), { 'request-id': requestId });
    return { status: 200, stream: false, model: upstream.model };
  }
  if (isModels) {
    // Continue to the upstream so callers can discover its model list.
  }

  let payload = null;
  let payloadBuffer = null;
  if (!isModels) {
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'invalid_request_error', 'Request body must be valid JSON.');
    }
    payload = upstream.model ? { ...body, model: upstream.model } : body;
    if (isCountTokens && payload.stream) payload.stream = false;
    payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  }

  const url = buildUpstreamUrl(upstream.baseUrl, path, search);
  const headers = anthropicUpstreamHeaders(req, upstream, { stream });
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
      method: isModels ? 'GET' : 'POST',
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
      if (isCountTokens && (status === 404 || status === 405)) {
        const estimated = estimateInputTokens(payload);
        writeJson(res, 200, { input_tokens: estimated }, { 'request-id': requestId });
        return { status: 200, stream: false, model: payload?.model || '', inputTokens: estimated };
      }
      const parsedError = parseErrorBody(errorBuffer, upstreamResponse.headers, [upstream.apiKey]);
      const mapped = publicErrorForUpstream(status, parsedError.text);
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
          ...(upstreamResponse.headers['retry-after'] ? { 'retry-after': upstreamResponse.headers['retry-after'] } : {})
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

    if (isModels) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
      let decoded;
      let parsed;
      try {
        decoded = decodeResponseBody(buffer, upstreamResponse.headers);
        parsed = JSON.parse(decoded.toString('utf8'));
      } catch {
        writeJson(res, 200, syntheticModels(upstream), { 'request-id': requestId });
        return { status: 200, stream: false, model: upstream.model || '', fallback: true };
      }
      assertNoSplitSecret(parsed, upstream.apiKey);
      const safeBody = Buffer.from(
        JSON.stringify(
          scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : [])
        ),
        'utf8'
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', safeBody.length);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('request-id', requestId);
      res.end(safeBody);
      return { status: 200, stream: false, model: upstream.model || '' };
    }

    if (isCountTokens) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
      const decoded = decodeResponseBody(buffer, upstreamResponse.headers);
      let parsed;
      try {
        parsed = JSON.parse(decoded.toString('utf8'));
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed.input_tokens !== 'number') {
        const estimated = estimateInputTokens(payload);
        writeJson(res, 200, { input_tokens: estimated }, { 'request-id': requestId });
        return { status: 200, stream: false, model: payload?.model || '', inputTokens: estimated, fallback: true };
      }
      writeJson(
        res,
        200,
        {
          input_tokens: Number(parsed.input_tokens) || 0
        },
        { 'request-id': requestId }
      );
      return {
        status: 200,
        stream: false,
        model: payload?.model || parsed.model || '',
        inputTokens: Number(parsed.input_tokens) || 0
      };
    }

    if (!stream) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
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
      const safeBody = Buffer.from(
        JSON.stringify(
          scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : [])
        ),
        'utf8'
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', safeBody.length);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('request-id', requestId);
      res.end(safeBody);
      return {
        status: 200,
        stream: false,
        model: parsed?.model || payload?.model || '',
        ...usage
      };
    }

    if (!isEventStream(upstreamResponse)) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
      const decoded = decodeResponseBody(buffer, upstreamResponse.headers);
      let parsed;
      try {
        parsed = JSON.parse(decoded.toString('utf8'));
      } catch {
        throw new AppError(502, 'api_error', 'The local gateway returned an invalid streaming response.');
      }
      assertNoSplitSecret(parsed, upstream.apiKey);
      const sse = redactKnownSecret(
        messageToSse(
          scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : [])
        ),
        upstream.apiKey
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('request-id', requestId);
      res.end(sse);
      const usage = messageUsage(parsed);
      return {
        status: 200,
        stream: true,
        model: parsed?.model || payload?.model || '',
        ...usage
      };
    }

    return await streamAnthropicResponse({
      res,
      upstreamResponse,
      upstreamRequest,
      requestId,
      model: payload?.model || '',
      started,
      clientAborted: () => clientAborted,
      upstreamApiKey: upstream.apiKey
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
  upstreamApiKey = ''
}) {
  return new Promise((resolve) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let streamError = null;
    let finished = false;
    let sawAnyEvent = false;
    let sawMessageStop = false;
    let heartbeat = null;
    let maxBlockIndex = -1;
    const toolArgumentBuffers = new Map();
    const thinkingBuffers = new Map();
    const pendingMessageDeltas = [];
    const splitScrubber = new StreamingSecretScrubber(
      upstreamApiKey ? [upstreamApiKey] : []
    );

    const finish = () => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
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
      if (!ok) {
        upstreamResponse.pause();
        res.once('drain', () => {
          if (!res.destroyed) upstreamResponse.resume();
        });
      }
      return ok;
    };

    const writeEventFrame = (eventName, data) => {
      let frame = '';
      if (eventName && eventName !== 'message') frame += `event: ${eventName}\n`;
      for (const line of data.split('\n')) frame += `data: ${line}\n`;
      frame += '\n';
      sawAnyEvent = true;
      writeChunk(frame);
    };

    const writeErrorEvent = () => {
      // Keep persisted metadata generic: upstream error text can echo prompt
      // content. The client already receives a generic Anthropic error event.
      streamError = 'Upstream stream error';
      if (!res.writableEnded && !res.destroyed) {
        writeChunk(
          sseEvent('error', {
            type: 'error',
            error: { type: 'api_error', message: 'The local gateway stream failed.' }
          })
        );
      }
    };

    const failStream = (message) => {
      if (finished) return;
      writeErrorEvent(message);
      upstreamResponse.destroy();
      finish();
    };

    const parser = new SSEParser((event) => {
      if (!event.data || event.data === '[DONE]') return;
      let parsed = null;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = null;
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
      if (parsed?.type === 'message_stop' || event.event === 'message_stop') {
        sawMessageStop = true;
      } else if (parsed?.type === 'message_start') {
        inputTokens = Number(parsed.message?.usage?.input_tokens) || inputTokens;
        outputTokens = Number(parsed.message?.usage?.output_tokens) || outputTokens;
      } else if (parsed?.type === 'message_delta') {
        inputTokens = Number(parsed.usage?.input_tokens) || inputTokens;
        outputTokens = Number(parsed.usage?.output_tokens) || outputTokens;
      }

      // Hold message_delta until any text held back by the streaming scrubber
      // has been flushed in a content block. This keeps the Anthropic event
      // order: all content blocks, then message_delta, then message_stop.
      if (parsed?.type === 'message_delta') {
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
        if (Buffer.byteLength(buffer.signature) > MAX_SIGNATURE_BYTES) {
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
        buffer.bytes += Buffer.byteLength(parsed.delta.partial_json);
        if (buffer.bytes > MAX_TOOL_ARGUMENT_BYTES) {
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
          const pending = thinking.scrubber.flush();
          if (pending) {
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
      } else if (parsed?.type === 'message_stop') {
        for (const [index, buffer] of toolArgumentBuffers) {
          const safeArguments = redactKnownSecret(buffer.text, upstreamApiKey);
          if (safeArguments) {
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
          const pending = buffer.scrubber.flush();
          if (pending) {
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
        const pending = splitScrubber.flush();
        if (pending) {
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
        eventData = JSON.stringify(
          scrubSecretsDeep(parsed, upstreamApiKey ? [upstreamApiKey] : [])
        );
      } else {
        eventData = redactKnownSecret(eventData, upstreamApiKey);
      }

      // Re-emit the event so an upstream credential can never appear verbatim
      // in the public stream, including when an error or key is split.
      const data = redactKnownSecret(eventData, upstreamApiKey);
      writeEventFrame(event.event, data);
    });
    parser.onError = (error) => {
      failStream(error.message);
    };

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('request-id', requestId);
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

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
