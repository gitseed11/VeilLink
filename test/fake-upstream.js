import http from 'node:http';

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
    res.write(`event: ${event.event || 'message'}\ndata: ${data}\n\n`);
  }
  res.end();
}

function openAiChunk(delta, finishReason = null, extra = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1760000000,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  };
}

export function createFakeUpstream() {
  const state = {
    requests: [],
    expectedApiKey: '',
    failNext: null,
    streamText: 'fake stream text',
    nonstreamText: 'fake nonstream text',
    leakText: '',
    delayMs: 0,
    delayHeadersMs: 0,
    anthropicStreamError: false,
    anthropicStreamErrorMessage: '',
    splitSecret: false,
    splitSecretAcrossBlocks: false,
    splitSecretInToolArgs: false,
    splitSecretInThinking: false,
    splitSecretInSignature: false,
    thinkingStream: false,
    echoUpstreamKey: false,
    holdbackStream: false,
    truncateAnthropicStream: false,
    openaiStreamErrorMessage: '',
    truncateOpenAIStream: false,
    unindexedToolCalls: false,
    nonstreamRefusal: false,
    nonstreamArrayToolArgs: false
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (state.failNext) {
        const failure = state.failNext;
        state.failNext = null;
        sendJson(res, failure.status || 500, failure.body || { error: { message: 'fake upstream failure' } });
        return;
      }

      const expected = state.expectedApiKey;
      if (expected) {
        const supplied = req.headers['x-api-key'] || (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]);
        if (supplied !== expected) {
          sendJson(res, 401, { error: { type: 'authentication_error', message: 'fake auth failed' } });
          return;
        }
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const echo = state.echoUpstreamKey ? `-${state.expectedApiKey}` : '';
        sendJson(res, 200, {
          data: [
            { id: `fake-model${echo}`, display_name: 'Fake Model', created_at: '2026-01-01T00:00:00Z' },
            { id: 'second-model', display_name: 'Second Model', created_at: '2026-01-01T00:00:00Z' }
          ],
          has_more: false,
          first_id: `fake-model${echo}`,
          last_id: 'second-model'
        });
        return;
      }

      if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, headers: req.headers, body });
        sendJson(res, 200, { input_tokens: 42 });
        return;
      }

      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        if (state.delayHeadersMs) await new Promise((resolve) => setTimeout(resolve, state.delayHeadersMs));
        if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
        if (body.stream && state.anthropicStreamError) {
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            {
              event: 'error',
              data: {
                type: 'error',
                error: {
                  type: 'api_error',
                  message:
                    state.anthropicStreamErrorMessage ||
                    `upstream exploded with ${state.expectedApiKey}`
                }
              }
            }
          ]);
          return;
        }
        if (body.stream && state.splitSecret) {
          const key = state.expectedApiKey;
          const mid = Math.ceil(key.length / 2);
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(0, mid) } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(mid) } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        if (body.stream && state.splitSecretAcrossBlocks) {
          const key = state.expectedApiKey;
          const mid = Math.ceil(key.length / 2);
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: key.slice(0, mid) } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: key.slice(mid) } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        if (body.stream && state.splitSecretInToolArgs) {
          const key = state.expectedApiKey;
          const mid = Math.ceil(key.length / 2);
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'tool_fake', name: 'read_file', input: {} }
              }
            },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: key.slice(0, mid) } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: key.slice(mid) } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        if (body.stream && state.holdbackStream) {
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'status' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        if (body.stream && state.thinkingStream) {
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' }
              }
            },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think ' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hard' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        if (
          body.stream &&
          (state.splitSecretInThinking || state.splitSecretInSignature)
        ) {
          const key = state.expectedApiKey;
          const mid = Math.ceil(key.length / 2);
          const deltaType = state.splitSecretInThinking
            ? 'thinking_delta'
            : 'signature_delta';
          const deltaField = state.splitSecretInThinking ? 'thinking' : 'signature';
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' }
              }
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: deltaType, [deltaField]: key.slice(0, mid) }
              }
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: deltaType, [deltaField]: key.slice(mid) }
              }
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        if (body.stream && state.truncateAnthropicStream) {
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial ' } } }
          ]);
          return;
        }
        if (body.stream) {
          sse(res, [
            {
              event: 'message_start',
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
                  usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
                }
              }
            },
            { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.leakText || 'fake ' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.leakText ? '' : 'stream' } } },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
              }
            },
            { event: 'message_stop', data: { type: 'message_stop' } }
          ]);
          return;
        }
        sendJson(res, 200, {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: state.splitSecret
            ? [
                { type: 'text', text: state.expectedApiKey.slice(0, Math.ceil(state.expectedApiKey.length / 2)) },
                { type: 'text', text: state.expectedApiKey.slice(Math.ceil(state.expectedApiKey.length / 2)) }
              ]
            : [{
                type: 'text',
                text:
                  state.leakText ||
                  (state.echoUpstreamKey
                    ? `fake anthropic text ${state.expectedApiKey}`
                    : 'fake anthropic text')
              }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 }
        });
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        state.requests.push({ path: url.pathname, search: url.search, headers: req.headers, body });
        if (state.delayHeadersMs) await new Promise((resolve) => setTimeout(resolve, state.delayHeadersMs));
        if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
        const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === 'user');
        const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
        const useTool = /USE_TOOL/.test(userText);

        if (body.stream) {
          if (state.splitSecret) {
            const key = state.expectedApiKey;
            const mid = Math.ceil(key.length / 2);
            sse(res, [
              { data: openAiChunk({ role: 'assistant', content: '' }) },
              { data: openAiChunk({ content: key.slice(0, mid) }) },
              { data: openAiChunk({ content: key.slice(mid) }) },
              { data: openAiChunk({}, 'stop') },
              {
                data: {
                  id: 'chatcmpl-test',
                  object: 'chat.completion.chunk',
                  created: 1760000000,
                  model: 'fake-model',
                  choices: [],
                  usage: {
                    prompt_tokens: 21,
                    completion_tokens: 4,
                    prompt_tokens_details: { cached_tokens: 3 }
                  }
                }
              },
              { data: '[DONE]', raw: true }
            ]);
            return;
          }
          if (state.openaiStreamErrorMessage) {
            sse(res, [
              {
                data: {
                  error: { message: state.openaiStreamErrorMessage }
                }
              }
            ]);
            return;
          }
          const events = [
            { data: openAiChunk({ role: 'assistant', content: '' }) },
            { data: openAiChunk({ content: state.leakText || 'fake ' }) },
            { data: openAiChunk({ content: state.leakText ? '' : 'openai' }) }
          ];
          if (state.truncateOpenAIStream) {
            events.push({
              data: openAiChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_truncated',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":' }
                  }
                ]
              })
            });
            sse(res, events);
            return;
          }
          if (state.unindexedToolCalls) {
            events.push({
              data: openAiChunk({
                tool_calls: [
                  { id: 'call_a', type: 'function', function: { name: 'alpha', arguments: '{"a":1}' } },
                  { id: 'call_b', type: 'function', function: { name: 'beta', arguments: '{"b":2}' } }
                ]
              })
            });
          } else if (useTool) {
            events.push({
              data: openAiChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_fake_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":' }
                  }
                ]
              })
            });
            events.push({
              data: openAiChunk({
                tool_calls: [{ index: 0, function: { arguments: '"C:/tmp/a.txt"}' } }]
              })
            });
          }
          events.push({
            data: openAiChunk(
              {},
              state.unindexedToolCalls || useTool ? 'tool_calls' : 'stop'
            )
          });
          events.push({
            data: {
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 1760000000,
              model: 'fake-model',
              choices: [],
              usage: {
                prompt_tokens: 21,
                completion_tokens: 4,
                prompt_tokens_details: { cached_tokens: 3 }
              }
            }
          });
          events.push({ data: '[DONE]', raw: true });
          sse(res, events);
          return;
        }

        const message = {
          role: 'assistant',
          content: useTool || state.nonstreamArrayToolArgs
            ? null
            : (state.leakText || state.nonstreamText)
        };
        if (state.nonstreamRefusal) {
          message.content = null;
          message.refusal = 'I cannot comply with that request.';
        }
        if (useTool || state.nonstreamArrayToolArgs) {
          message.tool_calls = [
            {
              id: 'call_fake_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: state.nonstreamArrayToolArgs ? '[]' : '{"path":"C:/tmp/a.txt"}'
              }
            }
          ];
        }
        sendJson(res, 200, {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1760000000,
          model: 'fake-model',
          choices: [
            {
              index: 0,
              message,
              finish_reason: state.nonstreamRefusal
                ? 'stop'
                : useTool || state.nonstreamArrayToolArgs
                  ? 'tool_calls'
                  : 'stop'
            }
          ],
          usage: {
            prompt_tokens: 21,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 3 }
          }
        });
        return;
      }

      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (error) {
      sendJson(res, 500, { error: { message: error.message } });
    }
  });

  return {
    state,
    server,
    html: '',
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
