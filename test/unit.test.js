import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths, PROJECT_ROOT, resolveDataDir } from '../src/paths.js';
import { SecretBox } from '../src/secrets.js';
import { KeyStore, generateApiKey, isValidApiKeyShape } from '../src/keys.js';
import { ConfigStore } from '../src/config.js';
import {
  AppError,
  ByteBudget,
  buildUpstreamUrl,
  createBodyLease,
  estimateInputTokens,
  redactKnownSecret,
  redactSecrets,
  sanitizeForLog,
  scrubSecretsDeep,
  validateBaseUrl
} from '../src/util.js';
import {
  AnthropicStreamTranslator,
  convertAnthropicRequest,
  convertOpenAIResponse
} from '../src/upstream/openai.js';
import { SSEParser } from '../src/upstream/sse.js';
import { messageToSse } from '../src/upstream/anthropic.js';
import { SlidingWindowLimiter } from '../src/rate-limit.js';
import { ensureDirPrivate } from '../src/storage.js';

async function tempPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veillink-test-'));
  const dataDir = path.join(root, 'data');
  await ensureDirPrivate(dataDir);
  return { root, dataDir, paths: createPaths(dataDir) };
}

function parseSse(text) {
  const events = [];
  const parser = new SSEParser((event) => events.push(event));
  parser.push(Buffer.from(text));
  parser.finish();
  return events;
}

test('API key generation uses sk- plus exactly 24 allowed characters', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const key = generateApiKey();
    assert.match(key, /^sk-[A-Za-z0-9@#%&]{24}$/);
    assert.equal(key.length, 27);
    assert.equal(isValidApiKeyShape(key), true);
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
  assert.equal(isValidApiKeyShape('sk-short'), false);
  assert.equal(isValidApiKeyShape('sk-000000000000000000000000!'), false);
});

test('URL normalization and joining avoid duplicated /v1', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:3425/'), 'http://127.0.0.1:3425');
  assert.equal(validateBaseUrl('http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1');
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:3425/v1', '/v1/messages', '?beta=true').toString(),
    'http://127.0.0.1:3425/v1/messages?beta=true'
  );
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:3425/anthropic', '/v1/messages').toString(),
    'http://127.0.0.1:3425/anthropic/v1/messages'
  );
  assert.throws(() => validateBaseUrl('ftp://example.com'));
  assert.throws(() => validateBaseUrl('https://user:pass@example.com'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/messages'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/messages/count_tokens'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/chat/completions'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/models'));
  assert.throws(() => resolveDataDir(PROJECT_ROOT));
  assert.throws(() => resolveDataDir(path.parse(PROJECT_ROOT).root));
  if (process.env.USERPROFILE) {
    assert.throws(() => resolveDataDir(process.env.USERPROFILE));
  }
});

test('redaction removes complete API keys while preserving usage counters', () => {
  const key = generateApiKey();
  const source = {
    apiKey: key,
    authorization: `Bearer ${key}`,
    text: `oops ${key}`,
    inputTokens: 12,
    outputTokens: 3,
    nested: { token: key }
  };
  const safe = sanitizeForLog(source);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(key), false);
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.inputTokens, 12);
  assert.equal(safe.outputTokens, 3);
  assert.equal(redactSecrets(`x ${key}`).includes(key), false);
});

test('estimateInputTokens counts text and media blocks', () => {
  const estimate = estimateInputTokens({
    system: 'system prompt',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]
      }
    ],
    tools: [{ name: 'x', input_schema: { type: 'object' } }]
  });
  assert.ok(estimate > 1600);
});

test('SecretBox encrypts, decrypts, and derives stable indexes', async () => {
  const { root, paths } = await tempPaths();
  try {
    const box = await SecretBox.load(paths);
    const encrypted = box.encryptString('secret-value', 'test');
    assert.equal(JSON.stringify(encrypted).includes('secret-value'), false);
    assert.equal(box.decryptString(encrypted, 'test'), 'secret-value');
    assert.throws(() => box.decryptString(encrypted, 'other-context'));
    const left = box.apiKeyIndex('sk-test');
    const right = box.apiKeyIndex('sk-test');
    assert.equal(left, right);
    assert.notEqual(left, box.apiKeyIndex('sk-other'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KeyStore persists encrypted keys and enforces device/revocation rules', async () => {
  const { root, paths } = await tempPaths();
  let store;
  try {
    store = await KeyStore.load(paths, await SecretBox.load(paths));
    const generated = await store.generate({ name: 'phone', allowedDevice: 'EXAMPLE-DEVICE-001' });
    assert.equal(isValidApiKeyShape(generated.key), true);
    assert.equal(store.authenticate(generated.key).ok, true);
    assert.equal(store.deviceAllowed(generated.record, 'example-device-001'), true);
    assert.equal(store.deviceAllowed(generated.record, 'other-machine'), false);
    assert.equal(await store.reveal(generated.record.id), generated.key);
    const disk = await fs.readFile(paths.keysFile, 'utf8');
    assert.equal(disk.includes(generated.key), false);

    const reloaded = await KeyStore.load(paths, await SecretBox.load(paths));
    assert.equal(reloaded.authenticate(generated.key).ok, true);
    await reloaded.revoke(generated.record.id);
    assert.equal(reloaded.authenticate(generated.key).ok, false);
    assert.equal(reloaded.authenticate(generated.key).reason, 'revoked');
    await reloaded.close();
  } finally {
    await store?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ConfigStore encrypts upstream keys and exposes only safe state', async () => {
  const { root, paths } = await tempPaths();
  try {
    const box = await SecretBox.load(paths);
    const store = await ConfigStore.load(paths, box);
    const upstreamSecret = 'upstream-secret-value';
    const snapshot = await store.update({
      upstream: {
        baseUrl: 'http://127.0.0.1:9999/v1',
        protocol: 'anthropic',
        authMode: 'x-api-key',
        model: 'fake-model',
        apiKey: upstreamSecret
      },
      public: { baseUrl: 'https://api.example.com' }
    });
    assert.equal(snapshot.baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(snapshot.hasApiKey, true);
    assert.equal(store.runtimeUpstream().apiKey, upstreamSecret);
    assert.equal(JSON.stringify(snapshot).includes(upstreamSecret), false);
    const disk = await fs.readFile(paths.configFile, 'utf8');
    assert.equal(disk.includes(upstreamSecret), false);
    const reloaded = await ConfigStore.load(paths, await SecretBox.load(paths));
    assert.equal(reloaded.runtimeUpstream().apiKey, upstreamSecret);
    await assert.rejects(() => store.update({ public: { baseUrl: 'http://insecure.example' } }), AppError);
    await store.update({ clearApiKey: true, upstream: {} });
    assert.equal(store.runtimeUpstream().apiKey, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SSE parser handles split chunks, CRLF, comments, and multiline data', () => {
  const events = [];
  const parser = new SSEParser((event) => events.push(event));
  parser.push(Buffer.from(': keepalive\r\nevent: message_start\r\ndata: {"type":"message_start",\r\n'));
  parser.push(Buffer.from('data: "x":1}\r\n\r\nevent: ping\r\ndata: {"type":"ping"}\r\n\r\n'));
  parser.finish();
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'message_start');
  assert.equal(JSON.parse(events[0].data).type, 'message_start');
  assert.equal(events[1].event, 'ping');
});

test('Anthropic SSE preserved help message conversion is valid', () => {
  const text = messageToSse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 3, output_tokens: 2 }
  });
  const events = parseSse(text);
  assert.ok(events.some((event) => event.event === 'content_block_start'));
  assert.equal(events.at(-1).event, 'message_stop');
  assert.ok(text.includes('"partial_json"'));
});

test('Anthropic request converts system, multimodal content, tools, and tool results', () => {
  const body = {
    model: 'claude-test',
    max_tokens: 400,
    stream: true,
    system: [{ type: 'text', text: 'system rules', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'BBBB' } }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'thinking', thinking: 'hidden' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'file body' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } }
            ]
          }
        ]
      }
    ],
    tools: [
      {
        name: 'read_file',
        description: 'read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } }
      }
    ],
    tool_choice: { type: 'auto' },
    stop_sequences: ['END']
  };

  const converted = convertAnthropicRequest(body, { model: 'upstream-model' });
  assert.equal(converted.model, 'upstream-model');
  assert.equal(converted.messages[0].role, 'system');
  assert.equal(converted.messages[0].content, 'system rules');
  assert.equal(converted.messages[1].role, 'user');
  assert.ok(Array.isArray(converted.messages[1].content));
  assert.ok(converted.messages[1].content.some((part) => part.type === 'image_url'));
  assert.ok(converted.messages[1].content.some((part) => part.type === 'video_url'));
  assert.equal(converted.messages[2].role, 'assistant');
  assert.equal(converted.messages[2].tool_calls[0].id, 'toolu_1');
  assert.equal(converted.messages[2].tool_calls[0].function.arguments, '{"path":"a.txt"}');
  const toolMessage = converted.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'toolu_1');
  assert.equal(toolMessage.content, 'file body');
  const trailingUser = converted.messages.at(-1);
  assert.equal(trailingUser.role, 'user');
  assert.ok(trailingUser.content.some((part) => part.type === 'image_url'));
  assert.equal(converted.tools[0].function.name, 'read_file');
  assert.equal(converted.tool_choice, 'auto');
  assert.deepEqual(converted.stop, ['END']);
  assert.equal(converted.messages.some((message) => JSON.stringify(message).includes('hidden')), false);
});

test('OpenAI response conversion preserves text, tools, stop reason, and usage', () => {
  const converted = convertOpenAIResponse(
    {
      id: 'chatcmpl-1',
      model: 'upstream-model',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'calling tool',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
              }
            ]
          }
        }
      ],
      usage: {
        prompt_tokens: 21,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    },
    { requestModel: 'claude-test', inputTokens: 20 }
  );
  assert.equal(converted.model, 'claude-test');
  assert.equal(converted.stop_reason, 'tool_use');
  assert.equal(converted.content[0].text, 'calling tool');
  assert.equal(converted.content[1].type, 'tool_use');
  assert.deepEqual(converted.content[1].input, { path: 'a.txt' });
  assert.equal(converted.usage.input_tokens, 21);
  assert.equal(converted.usage.output_tokens, 4);
  assert.equal(converted.usage.cache_read_input_tokens, 3);
});

test('OpenAI stream translator emits ordered text and buffered tool events', () => {
  const writes = [];
  const translator = new AnthropicStreamTranslator({
    write: (chunk) => writes.push(chunk),
    model: 'claude-test',
    inputTokens: 9
  });
  translator.start();
  translator.push({ choices: [{ delta: { content: 'hello ' } }] });
  translator.push({ choices: [{ delta: { content: 'world' } }] });
  translator.push({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }
          ]
        }
      }
    ]
  });
  translator.push({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }]
  });
  translator.push({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } }
  });
  translator.finish();

  const events = parseSse(writes.join(''));
  const names = events.map((event) => event.event);
  assert.equal(names[0], 'message_start');
  assert.ok(names.includes('content_block_start'));
  assert.ok(names.includes('content_block_delta'));
  assert.equal(names.at(-1), 'message_stop');
  const parsed = events.map((event) => JSON.parse(event.data));
  const text = parsed
    .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
    .map((event) => event.delta.text)
    .join('');
  assert.equal(text, 'hello world');
  const toolStart = parsed.find((event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');
  assert.equal(toolStart.content_block.id, 'call_1');
  assert.equal(toolStart.content_block.name, 'read_file');
  const toolDelta = parsed.find((event) => event.delta?.type === 'input_json_delta');
  assert.equal(toolDelta.delta.partial_json, '{"path":"a.txt"}');
  const messageDelta = parsed.find((event) => event.type === 'message_delta');
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  assert.equal(messageDelta.usage.output_tokens, 5);
  assert.equal(messageDelta.usage.cache_read_input_tokens, 2);
  assert.ok(writes.join('').includes('message_stop'));
});

test('OpenAI request conversion rejects unknown blocks and PDFs map to file parts', () => {
  const base = {
    model: 'x',
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
            title: 'doc.pdf'
          }
        ]
      }
    ]
  };
  const converted = convertAnthropicRequest(base, { model: 'm' });
  assert.equal(converted.messages[0].content[0].type, 'file');
  assert.ok(converted.messages[0].content[0].file.file_data.startsWith('data:application/pdf;base64,'));
  assert.throws(
    () =>
      convertAnthropicRequest(
        { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'mystery' }] }] },
        { model: 'm' }
      ),
    AppError
  );
});

test('SlidingWindowLimiter rejects requests over its budget', () => {
  let now = 1000000;
  const limiter = new SlidingWindowLimiter({ now: () => now });
  try {
    assert.equal(limiter.take('a', 2, 60000).allowed, true);
    assert.equal(limiter.take('a', 2, 60000).allowed, true);
    const denied = limiter.take('a', 2, 60000);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSeconds >= 1);
    now += 61000;
    assert.equal(limiter.take('a', 2, 60000).allowed, true);
  } finally {
    limiter.close();
  }
});


test('ByteBudget caps concurrent body memory and leases release it', () => {
  const budget = new ByteBudget(10);
  const first = createBodyLease(budget);
  const second = createBodyLease(budget);
  assert.equal(first.reserve(6), true);
  assert.equal(second.reserve(5), false);
  assert.equal(second.reserve(4), true);
  assert.equal(budget.usedBytes, 10);
  first.release();
  assert.equal(budget.usedBytes, 4);
  second.release();
  assert.equal(budget.usedBytes, 0);
});

test('redaction covers modern provider key formats and known secrets', () => {
  const text = 'a sk-ant-api03-abcdefghijklmnopqrstuvwxyz and sk-proj-1234567890abcdefghij and Bearer abcdefghijklmnopqrstuvwxyz';
  const redacted = redactSecrets(text);
  assert.equal(redacted.includes('sk-ant-api03'), false);
  assert.equal(redacted.includes('sk-proj-1234'), false);
  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(redactKnownSecret('token=opaque-upstream-secret ok', 'opaque-upstream-secret').includes('opaque-upstream-secret'), false);
});

test('scrubSecretsDeep redacts secrets in object keys and values', () => {
  const secret = 'up-stream-secret-value';
  const scrubbed = scrubSecretsDeep(
    {
      [`prefix-${secret}`]: secret,
      nested: { [secret]: 'value', safe: 'ok' },
      list: [secret, { [`x-${secret}`]: 1 }]
    },
    [secret]
  );
  assert.deepEqual(Object.keys(scrubbed), ['prefix-[REDACTED]', 'nested', 'list']);
  assert.equal(scrubbed['prefix-[REDACTED]'], '[REDACTED]');
  assert.deepEqual(Object.keys(scrubbed.nested), ['[REDACTED]', 'safe']);
  assert.equal(scrubbed.list[0], '[REDACTED]');
  assert.deepEqual(Object.keys(scrubbed.list[1]), ['x-[REDACTED]']);
});

test('provider tools and provider content blocks do not hard-fail translation', () => {
  const converted = convertAnthropicRequest(
    {
      model: 'claude-test',
      max_tokens: 10,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      tool_choice: { type: 'tool', name: 'web_search' },
      messages: [
        { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }] },
        {
          role: 'user',
          content: [
            { type: 'search_result', title: 'Result', url: 'https://example.test', content: [{ type: 'text', text: 'answer' }] },
            { type: 'text', text: 'summarize' }
          ]
        }
      ]
    },
    { model: 'upstream' }
  );
  assert.equal(converted.tools, undefined);
  assert.equal(converted.tool_choice, undefined);
  assert.ok(converted.messages[0].content.includes('web_search'));
  assert.ok(converted.messages[1].content.includes('search_result'));
  assert.ok(converted.messages[1].content.includes('summarize'));
});

test('tool_result.is_error and non-stream refusal are preserved', () => {
  const request = convertAnthropicRequest(
    {
      model: 'x',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT' }] }
      ]
    },
    { model: 'm' }
  );
  const toolMessage = request.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.startsWith('[tool_error]'));

  const refusal = convertOpenAIResponse({
    choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot do that.' }, finish_reason: 'stop' }]
  });
  assert.equal(refusal.content[0].text, 'I cannot do that.');
});

test('invalid tool JSON, array inputs, and remote document URLs are rejected', () => {
  assert.throws(
    () =>
      convertOpenAIResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c', function: { name: 'x', arguments: '[]' } }]
            },
            finish_reason: 'tool_calls'
          }
        ]
      }),
    AppError
  );
  assert.throws(
    () =>
      convertAnthropicRequest(
        {
          model: 'x',
          max_tokens: 10,
          messages: [{ role: 'user', content: [{}] }]
        },
        { model: 'm' }
      ),
    (error) => error instanceof AppError && error.status === 400
  );
  assert.throws(
    () =>
      convertAnthropicRequest(
        {
          model: 'x',
          max_tokens: 10,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'url', url: 'https://example.test/a.pdf' } }
              ]
            }
          ]
        },
        { model: 'm' }
      ),
    AppError
  );
});

test('length-truncated streamed tool calls are omitted rather than executed', () => {
  const writes = [];
  const translator = new AnthropicStreamTranslator({ write: (chunk) => writes.push(chunk), model: 'm' });
  translator.push({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{"path":"a"}' } }]
        }
      }
    ]
  });
  translator.push({ choices: [{ delta: {}, finish_reason: 'length' }] });
  translator.finish();
  const events = parseSse(writes.join(''));
  const parsed = events.map((event) => JSON.parse(event.data));
  assert.equal(parsed.some((event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use'), false);
  const messageDelta = parsed.find((event) => event.type === 'message_delta');
  assert.equal(messageDelta.delta.stop_reason, 'max_tokens');
  assert.equal(events.at(-1).event, 'message_stop');
});

test('indexless and string-index parallel tool calls remain distinct', () => {
  for (const variant of ['none', 'string']) {
    const writes = [];
    const translator = new AnthropicStreamTranslator({ write: (chunk) => writes.push(chunk), model: 'm' });
    const calls = [
      { id: 'call_a', function: { name: 'alpha', arguments: '{"a":1}' } },
      { id: 'call_b', function: { name: 'beta', arguments: '{"b":2}' } }
    ];
    if (variant === 'string') {
      calls[0].index = '0';
      calls[1].index = '1';
    }
    translator.push({ choices: [{ delta: { tool_calls: calls } }] });
    translator.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    translator.finish();
    const parsed = parseSse(writes.join('')).map((event) => JSON.parse(event.data));
    const starts = parsed.filter((event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');
    assert.equal(starts.length, 2, variant);
    assert.deepEqual(starts.map((event) => event.content_block.id).sort(), ['call_a', 'call_b']);
    const deltas = parsed.filter((event) => event.delta?.type === 'input_json_delta');
    assert.deepEqual(deltas.map((event) => JSON.parse(event.delta.partial_json)), [{ a: 1 }, { b: 2 }]);
  }
});

test('thinking fallback emits thinking_delta and signature_delta', () => {
  const text = messageToSse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 }
  });
  assert.ok(text.includes('"type":"thinking_delta"'));
  assert.ok(text.includes('"type":"signature_delta"'));
  assert.ok(text.includes('"reasoning"'));
});
