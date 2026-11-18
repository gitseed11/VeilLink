import {
  AppError,
  assertNoSplitSecret,
  isOpenAIProtocol,
  redactKnownSecret,
  redactSecrets,
  scrubSecretsDeep
} from '../util.js';
import { openUpstreamRequest, collectResponse } from './http-client.js';
import {
  anthropicUpstreamHeaders,
  openaiUpstreamHeaders,
  decodeResponseBody,
  guardErrorBody,
  parseErrorBody
} from './common.js';
import { buildUpstreamUrl } from '../util.js';

function textPreview(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (Array.isArray(parsed.content)) {
    return parsed.content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .slice(0, 200);
  }
  if (typeof parsed.output_text === 'string') return parsed.output_text.slice(0, 200);
  if (Array.isArray(parsed.output)) {
    const text = [];
    for (const item of parsed.output) {
      if (typeof item?.text === 'string') text.push(item.text);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') text.push(part.text);
        }
      }
      if (Array.isArray(item?.summary)) {
        for (const part of item.summary) {
          if (typeof part?.text === 'string') text.push(part.text);
        }
      }
    }
    if (text.length) return text.join(' ').slice(0, 200);
  }
  const message = parsed.choices?.[0]?.message;
  if (message) {
    if (typeof message.content === 'string') return message.content.slice(0, 200);
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .join(' ')
        .slice(0, 200);
    }
  }
  return '';
}

function isJsonContentType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

function expectedProtocolShape(protocol, parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (protocol === 'anthropic') return parsed.type === 'message';
  if (protocol === 'openai-responses') return parsed.object === 'response';
  return Array.isArray(parsed.choices);
}

export async function testUpstream(upstream) {
  if (!upstream?.configured || !upstream.baseUrl) {
    throw new AppError(400, 'invalid_request_error', '请先填写并保存网关地址。');
  }
  const model = upstream.models?.[0] || upstream.model || '';
  if (!model) {
    throw new AppError(400, 'invalid_request_error', '请先填写至少一个上游模型，再执行连通性测试。');
  }

  const started = Date.now();
  let path;
  let payload;
  let headers;
  if (upstream.protocol === 'openai-responses') {
    path = '/v1/responses';
    payload = Buffer.from(
      JSON.stringify({
        model,
        input: 'Reply with the single word: ok',
        max_output_tokens: 64,
        stream: false,
        store: false
      }),
      'utf8'
    );
    headers = {
      ...openaiUpstreamHeaders({ headers: {} }, upstream, { stream: false, hasBody: true }),
      'content-length': String(payload.length)
    };
  } else if (isOpenAIProtocol(upstream.protocol)) {
    path = '/v1/chat/completions';
    payload = Buffer.from(
      JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_completion_tokens: 64,
        stream: false
      }),
      'utf8'
    );
    headers = {
      ...openaiUpstreamHeaders({ headers: {} }, upstream, { stream: false, hasBody: true }),
      'content-length': String(payload.length)
    };
  } else {
    path = '/v1/messages';
    payload = Buffer.from(
      JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        stream: false
      }),
      'utf8'
    );
    headers = {
      ...anthropicUpstreamHeaders({ headers: {} }, upstream, { stream: false, hasBody: true }),
      'content-length': String(payload.length)
    };
  }

  let request;
  let response;
  try {
    ({ request, response } = await openUpstreamRequest({
      url: buildUpstreamUrl(upstream.baseUrl, path, ''),
      method: 'POST',
      headers,
      body: payload,
      timeoutMs: Math.min(upstream.timeoutMs, 45000)
    }));
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: redactSecrets(error.message),
      message: '无法连接本地网关。'
    };
  }

  try {
    const buffer = await collectResponse(response, 2 * 1024 * 1024);
    const status = response.statusCode || 0;
    if (status < 200 || status >= 300) {
      const parsedError = guardErrorBody(
        parseErrorBody(buffer, response.headers, [upstream.apiKey]),
        upstream.apiKey
      );
      request.destroy();
      return {
        ok: false,
        status,
        latencyMs: Date.now() - started,
        error: parsedError.text || `HTTP ${status}`,
        message: `网关返回 HTTP ${status}。`
      };
    }
    const contentType = response.headers['content-type'];
    if (!isJsonContentType(contentType)) {
      request.destroy();
      return {
        ok: false,
        status,
        latencyMs: Date.now() - started,
        error: 'The upstream test received a non-JSON response.',
        message: '网关返回了非 JSON 响应。'
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(decodeResponseBody(buffer, response.headers).toString('utf8'));
    } catch {
      parsed = null;
    }
    if (!expectedProtocolShape(upstream.protocol, parsed)) {
      request.destroy();
      return {
        ok: false,
        status,
        latencyMs: Date.now() - started,
        error: 'The upstream test received an unexpected protocol response.',
        message: '网关返回了非预期协议响应。'
      };
    }
    try {
      assertNoSplitSecret(parsed, upstream.apiKey);
    } catch {
      request.destroy();
      return {
        ok: false,
        status,
        latencyMs: Date.now() - started,
        error: 'The upstream test response contained a protected credential.',
        message: '网关返回了不安全的响应。'
      };
    }
    request.destroy();
    const safe = scrubSecretsDeep(parsed, upstream.apiKey ? [upstream.apiKey] : []);
    const preview = redactKnownSecret(textPreview(safe), upstream.apiKey);
    const usedModel = redactKnownSecret(
      String(safe?.model || model),
      upstream.apiKey
    );
    return {
      ok: true,
      status,
      latencyMs: Date.now() - started,
      model: usedModel,
      preview,
      message: '网关调用成功。'
    };
  } catch (error) {
    request.destroy();
    return {
      ok: false,
      status: response.statusCode || 0,
      latencyMs: Date.now() - started,
      error: redactSecrets(error.message),
      message: '网关返回了无法读取的响应。'
    };
  }
}
