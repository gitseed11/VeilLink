import http from 'node:http';

const CREATED = 1767225600; // 2026-01-01T00:00:00Z

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    ...headers
  });
  res.end(body);
}

function sse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  res.flushHeaders?.();
  for (const event of events) {
    const data = event.raw ? String(event.data) : JSON.stringify(event.data);
    if (event.event) res.write(`event: ${event.event}\ndata: ${data}\n\n`);
    else res.write(`data: ${data}\n\n`);
  }
  res.end();
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function anthropicMessage(body, text, { split = false, key = '', thinking = false } = {}) {
  const content = [];
  if (thinking) {
    content.push({ type: 'thinking', thinking: 'fake thinking', signature: 'sig-fake' });
  }
  if (split && key.length > 1) {
    const middle = Math.ceil(key.length / 2);
    content.push({ type: 'text', text: key.slice(0, middle) });
    content.push({ type: 'text', text: key.slice(middle) });
  } else {
    content.push({ type: 'text', text });
  }
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0
    }
  };
}

function anthropicStream(body, state, key) {
  const events = [
    {
      event: state.anthropic.leakEventName ? key : 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 11,
            output_tokens: 0,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 0
          }
        }
      }
    }
  ];
  if (state.anthropic.streamError) {
    events.push({
      event: 'error',
      data: {
        type: 'error',
        error: {
          type: 'api_error',
          message: state.anthropic.streamErrorMessage || `upstream exploded with ${key}`
        }
      }
    });
    return events;
  }
  if (state.anthropic.thinkingStream) {
    events.push(
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }
      },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hard' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  } else if (state.anthropic.splitSecret && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(0, middle) } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  } else if (state.anthropic.splitSecretAcrossBlocks && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(0, middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: key.slice(middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } }
    );
  } else if (state.anthropic.splitSecretInToolArgs && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_fake', name: 'read_file', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: key.slice(0, middle) } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: key.slice(middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  } else if (state.anthropic.splitSecretInThinking && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: key.slice(0, middle) } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: key.slice(middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  } else if (state.anthropic.splitSecretInSignature && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: key.slice(0, middle) } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: key.slice(middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  } else if (state.anthropic.crossFieldSplit && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(0, middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_cross', name: 'read_file', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: key.slice(middle) } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } }
    );
  } else if (state.anthropic.holdbackStream) {
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'status' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  } else {
    events.push(
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: state.anthropic.leakText || 'fake ' }
        }
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: state.anthropic.leakText ? '' : 'stream' }
        }
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }
    );
  }
  if (state.anthropic.truncate) return events;
  const cut = state.anthropic.splitMessageDeltaShort
    ? 1
    : Math.ceil(key.length / 2);
  events.push(
    {
      event: 'message_delta',
      data: state.anthropic.splitMessageDelta && key
        ? {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: key.slice(0, cut) },
            diagnostic: key.slice(cut),
            usage: { input_tokens: 11, output_tokens: 2 }
          }
        : {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { input_tokens: 11, output_tokens: 2 }
          }
    },
    { event: 'message_stop', data: { type: 'message_stop' } }
  );
  return events;
}

function openaiResponse(model, text, {
  status = 'completed',
  includeText = true,
  split = false,
  splitParts = false,
  key = ''
} = {}) {
  const output = [];
  if (includeText) {
    let content;
    if (splitParts && key.length > 1) {
      const middle = Math.ceil(key.length / 2);
      content = [
        { type: 'output_text', text: key.slice(0, middle), annotations: [] },
        { type: 'output_text', text: key.slice(middle), annotations: [] }
      ];
    } else {
      content = [
        {
          type: 'output_text',
          text: split && key.length > 1 ? key : text,
          annotations: []
        }
      ];
    }
    output.push({
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content
    });
  }
  return {
    id: 'resp_fake',
    object: 'response',
    created_at: CREATED,
    status,
    error: status === 'failed' ? { code: 'server_error', message: 'fake response failed' } : null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    model,
    output,
    output_text: includeText ? text : '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 21,
      output_tokens: 4,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    }
  };
}

function responsesEvents(response, state, key) {
  const events = [];
  let sequence = 0;
  const push = (type, payload) => {
    events.push({ event: type, data: { type, sequence_number: sequence, ...payload } });
    sequence += 1;
  };
  push('response.created', { response: { ...response, output: [], status: 'in_progress' } });
  if (state.responses.eventNameLeak && key) {
    events[0].event = key;
    events[0].data.type = key;
  }
  push('response.in_progress', { response: { ...response, output: [], status: 'in_progress' } });
  push('response.output_item.added', {
    output_index: 0,
    item: { id: 'msg_fake', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
  });
  push('response.content_part.added', {
    item_id: 'msg_fake',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  });
  const text = state.responses.leakText || 'fake responses text';
  if (state.responses.crossFieldSplit && key) {
    const middle = Math.ceil(key.length / 2);
    push('response.output_text.delta', { item_id: 'msg_fake', output_index: 0, content_index: 0, delta: key.slice(0, middle), logprobs: [] });
    push('response.output_text.done', { item_id: 'msg_fake', output_index: 0, content_index: 0, text: key.slice(middle) });
    return events;
  }
  if (state.responses.splitSecret && key) {
    const middle = Math.ceil(key.length / 2);
    push('response.output_text.delta', { item_id: 'msg_fake', output_index: 0, content_index: 0, delta: key.slice(0, middle), logprobs: [] });
    push('response.output_text.delta', { item_id: 'msg_fake', output_index: 0, content_index: 0, delta: key.slice(middle), logprobs: [] });
  } else {
    push('response.output_text.delta', { item_id: 'msg_fake', output_index: 0, content_index: 0, delta: text, logprobs: [] });
  }
  if (state.responses.truncate) return events;
  if (state.responses.error) {
    push('error', { code: 'server_error', message: 'fake responses stream error', param: null, upstream_internal: 'internal-only' });
    return events;
  }
  push('response.output_text.done', { item_id: 'msg_fake', output_index: 0, content_index: 0, text });
  push('response.content_part.done', {
    item_id: 'msg_fake',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text, annotations: [] }
  });
  push('response.output_item.done', {
    output_index: 0,
    item: { id: 'msg_fake', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  });
  const terminal = state.responses.terminal || 'completed';
  const terminalResponse = {
    ...response,
    status: terminal === 'completed' ? 'completed' : terminal,
    output: response.output
  };
  if (terminal === 'failed') terminalResponse.error = { code: 'server_error', message: 'fake response failed' };
  if (terminal === 'incomplete') terminalResponse.incomplete_details = { reason: 'max_output_tokens' };
  push(`response.${terminal}`, { response: terminalResponse });
  return events;
}

function chatCompletion(model, text, { split = false, key = '' } = {}) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: CREATED,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: split && key.length > 1 ? key : text, refusal: null },
        finish_reason: 'stop',
        logprobs: null
      }
    ],
    usage: {
      prompt_tokens: 21,
      completion_tokens: 4,
      total_tokens: 25,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 0 }
    }
  };
}

function chatChunk(model, delta, finishReason = null, extra = {}) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...extra
  };
}

function chatEvents(model, state, key) {
  const events = [
    { data: chatChunk(model, { role: 'assistant', content: '' }) }
  ];
  const text = state.chat.leakText || 'fake chat text';
  if (state.chat.crossFieldSplit && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { data: chatChunk(model, { content: key.slice(0, middle) }) },
      {
        data: chatChunk(model, {
          tool_calls: [
            {
              index: 0,
              id: 'call_cross',
              type: 'function',
              function: { name: 'read_file', arguments: key.slice(middle) }
            }
          ]
        })
      },
      { data: chatChunk(model, {}, 'tool_calls') },
      {
        data: {
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          created: CREATED,
          model,
          choices: [],
          usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 }
        }
      },
      { data: '[DONE]', raw: true }
    );
    return events;
  }
  if (state.chat.splitSecret && key) {
    const middle = Math.ceil(key.length / 2);
    events.push(
      { data: chatChunk(model, { content: key.slice(0, middle) }) },
      { data: chatChunk(model, { content: key.slice(middle) }) }
    );
  } else {
    events.push({ data: chatChunk(model, { content: text }) });
  }
  if (state.chat.truncate) return events;
  if (state.chat.error) {
    events.push({ data: { error: { message: 'fake chat stream error', type: 'api_error', param: null, code: null, upstream_internal: 'internal-only' } } });
    return events;
  }
  events.push({ data: chatChunk(model, {}, 'stop') });
  events.push({
    data: {
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: CREATED,
      model,
      choices: [],
      usage: {
        prompt_tokens: 21,
        completion_tokens: 4,
        total_tokens: 25,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    }
  });
  events.push({ data: '[DONE]', raw: true });
  return events;
}

export function createFakeUpstream() {
  const state = {
    requests: [],
    expectedApiKey: '',
    failNext: null,
    delayMs: 0,
    delayHeadersMs: 0,
    abortAfterHeaders: false,
    models: ['fake-model', 'second-model'],
    countTokensPayload: null,
    anthropic: {
      streamError: false,
      streamErrorMessage: '',
      truncate: false,
      splitSecret: false,
      splitSecretAcrossBlocks: false,
      splitSecretInToolArgs: false,
      splitSecretInThinking: false,
      splitSecretInSignature: false,
      crossFieldSplit: false,
      splitMessageDelta: false,
      splitMessageDeltaShort: false,
      leakEventName: false,
      thinkingStream: false,
      holdbackStream: false,
      leakText: ''
    },
    responses: {
      terminal: 'completed',
      truncate: false,
      error: false,
      splitSecret: false,
      splitParts: false,
      crossFieldSplit: false,
      eventNameLeak: false,
      forceSse: false,
      emptyHtml: false,
      modelEchoKey: false,
      leakText: ''
    },
    chat: {
      truncate: false,
      error: false,
      splitSecret: false,
      crossFieldSplit: false,
      leakText: ''
    },
    storedResponses: new Map(),
    storedChats: new Map(),
    nextResponse: 0,
    nextChat: 0
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const key = state.expectedApiKey;
    try {
      if (state.failNext) {
        const failure = state.failNext;
        state.failNext = null;
        sendJson(
          res,
          failure.status || 500,
          failure.body || { error: { message: 'fake upstream failure' } },
          failure.headers || {}
        );
        return;
      }

      if (state.delayHeadersMs) await delay(state.delayHeadersMs);
      if (state.abortAfterHeaders) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"incomplete":');
        res.destroy();
        return;
      }

      if (key) {
        const supplied = req.headers['x-api-key'] || (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]);
        if (supplied !== key) {
          sendJson(res, 401, { error: { type: 'authentication_error', message: 'fake auth failed' } });
          return;
        }
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        sendJson(res, 200, {
          object: 'list',
          data: state.models.map((id) => ({ id, object: 'model', created: CREATED, owned_by: 'fake' }))
        });
        return;
      }

      if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        sendJson(
          res,
          200,
          state.countTokensPayload || { input_tokens: 42 },
          { 'anthropic-ratelimit-requests-remaining': '99' }
        );
        return;
      }

      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        if (state.delayMs) await delay(state.delayMs);
        if (body.stream) {
          const events = anthropicStream(body, state, key);
          sse(res, events);
          return;
        }
        const split = state.anthropic.splitSecret && key;
        const text = split ? key : (state.anthropic.leakText || 'fake anthropic text');
        sendJson(
          res,
          200,
          anthropicMessage(body, text, { split, key, thinking: state.anthropic.thinkingStream }),
          { 'anthropic-ratelimit-requests-remaining': '99' }
        );
        return;
      }

      if (url.pathname === '/v1/responses/input_tokens' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        sendJson(res, 200, { object: 'response.input_tokens', input_tokens: 33 });
        return;
      }

      if (url.pathname === '/v1/responses/compact' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        sendJson(res, 200, {
          id: 'resp_compaction_fake',
          object: 'response.compaction',
          created_at: CREATED,
          output: [{ type: 'compaction', encrypted_content: 'opaque-compaction' }],
          usage: {
            input_tokens: 21,
            output_tokens: 4,
            total_tokens: 25,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 }
          }
        });
        return;
      }

      if (url.pathname === '/v1/responses' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        if (state.delayMs) await delay(state.delayMs);
        if (state.responses.emptyHtml) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end();
          return;
        }
        state.nextResponse += 1;
        const id = `resp_fake_${state.nextResponse}`;
        const response = openaiResponse(body.model, state.responses.leakText || 'fake responses text', {
          status: 'completed',
          split: state.responses.splitSecret,
          splitParts: state.responses.splitParts,
          key
        });
        response.id = id;
        if (state.responses.modelEchoKey && key) response.model = key;
        state.storedResponses.set(id, response);
        if (body.stream || state.responses.forceSse) {
          const events = responsesEvents(response, state, key);
          sse(res, events);
          return;
        }
        sendJson(res, 200, response, { 'x-ratelimit-remaining-requests': '99' });
        return;
      }

      const responseMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
      if (responseMatch) {
        const id = decodeURIComponent(responseMatch[1]);
        const stored = state.storedResponses.get(id);
        if (req.method === 'GET') {
          state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
          if (!stored) {
            sendJson(res, 404, { error: { message: 'response not found', type: 'invalid_request_error', param: null, code: 'not_found' } });
            return;
          }
          if (url.searchParams.get('stream') === 'true') {
            sse(res, responsesEvents(stored, state, key));
            return;
          }
          sendJson(res, 200, stored);
          return;
        }
        if (req.method === 'DELETE') {
          state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
          state.storedResponses.delete(id);
          sendJson(res, 200, { id, object: 'response', deleted: true });
          return;
        }
      }

      const cancelMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const id = decodeURIComponent(cancelMatch[1]);
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
        const stored = state.storedResponses.get(id);
        if (!stored) {
          sendJson(res, 404, { error: { message: 'response not found', type: 'invalid_request_error', param: null, code: 'not_found' } });
          return;
        }
        sendJson(res, 200, { ...stored, status: 'cancelled' });
        return;
      }

      const inputItemsMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)\/input_items$/);
      if (inputItemsMatch && req.method === 'GET') {
        const id = decodeURIComponent(inputItemsMatch[1]);
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
        sendJson(res, 200, {
          object: 'list',
          data: [{ id: 'input_1', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          has_more: false,
          first_id: 'input_1',
          last_id: 'input_1'
        });
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'GET') {
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
        const data = [...state.storedChats.values()];
        sendJson(res, 200, {
          object: 'list',
          data,
          first_id: data[0]?.id || null,
          last_id: data.at(-1)?.id || null,
          has_more: false
        });
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        if (state.delayMs) await delay(state.delayMs);
        if (body.stream) {
          const events = chatEvents(body.model, state, key);
          sse(res, events);
          return;
        }
        state.nextChat += 1;
        const id = `chatcmpl-fake-${state.nextChat}`;
        const completion = chatCompletion(body.model, state.chat.leakText || 'fake chat text', {
          split: state.chat.splitSecret,
          key
        });
        completion.id = id;
        state.storedChats.set(id, completion);
        sendJson(res, 200, completion, { 'x-ratelimit-remaining-requests': '99' });
        return;
      }

      const chatMatch = url.pathname.match(/^\/v1\/chat\/completions\/([^/]+)(\/messages)?$/);
      if (chatMatch) {
        const id = decodeURIComponent(chatMatch[1]);
        const messages = Boolean(chatMatch[2]);
        const stored = state.storedChats.get(id);
        if (messages && req.method === 'GET') {
          state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
          sendJson(res, 200, {
            object: 'list',
            data: [{ id: 'msg_1', role: 'user', content: 'hello', content_parts: null, name: null }],
            has_more: false,
            first_id: 'msg_1',
            last_id: 'msg_1'
          });
          return;
        }
        if (!stored) {
          sendJson(res, 404, { error: { message: 'chat completion not found', type: 'invalid_request_error', param: null, code: 'not_found' } });
          return;
        }
        if (req.method === 'GET') {
          state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
          sendJson(res, 200, stored);
          return;
        }
        if (req.method === 'POST') {
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
          const updated = { ...stored, metadata: body.metadata || null };
          state.storedChats.set(id, updated);
          sendJson(res, 200, updated);
          return;
        }
        if (req.method === 'DELETE') {
          state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body: null });
          state.storedChats.delete(id);
          sendJson(res, 200, { id, object: 'chat.completion.deleted', deleted: true });
          return;
        }
      }

      sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error', param: null, code: 'not_found' } });
    } catch (error) {
      sendJson(res, 500, { error: { message: error.message } });
    }
  });

  return {
    state,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const port = server.address().port;
      return { port, base: `http://127.0.0.1:${port}`, baseV1: `http://127.0.0.1:${port}/v1` };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
