import {
  AppError,
  redactKnownSecret,
  redactSecrets
} from '../util.js';
import { openUpstreamRequest, collectResponse } from './http-client.js';
import {
  anthropicUpstreamHeaders,
  openaiUpstreamHeaders,
  decodeResponseBody,
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

export async function testUpstream(upstream) {
  if (!upstream?.configured || !upstream.baseUrl) {
    throw new AppError(400, 'invalid_request_error', '请先填写并保存网关地址。');
  }
  if (!upstream.model) {
    throw new AppError(400, 'invalid_request_error', '请先填写上游模型，再执行连通性测试。');
  }

  const started = Date.now();
  let path;
  let payload;
  let headers;
  if (upstream.protocol === 'openai') {
    path = '/v1/chat/completions';
    payload = Buffer.from(
      JSON.stringify({
        model: upstream.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 1,
        stream: false
      }),
      'utf8'
    );
    headers = {
      ...openaiUpstreamHeaders(upstream, { stream: false }),
      'content-length': String(payload.length)
    };
  } else {
    path = '/v1/messages';
    payload = Buffer.from(
      JSON.stringify({
        model: upstream.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        stream: false
      }),
      'utf8'
    );
    headers = {
      ...anthropicUpstreamHeaders({ headers: {} }, upstream, { stream: false }),
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
      const parsedError = parseErrorBody(buffer, response.headers, [upstream.apiKey]);
      request.destroy();
      return {
        ok: false,
        status,
        latencyMs: Date.now() - started,
        error: parsedError.text || `HTTP ${status}`,
        message: `网关返回 HTTP ${status}。`
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(decodeResponseBody(buffer, response.headers).toString('utf8'));
    } catch {
      parsed = null;
    }
    request.destroy();
    const preview = redactKnownSecret(textPreview(parsed), upstream.apiKey);
    const model = redactKnownSecret(
      String(parsed?.model || upstream.model || ''),
      upstream.apiKey
    );
    return {
      ok: true,
      status,
      latencyMs: Date.now() - started,
      model,
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
