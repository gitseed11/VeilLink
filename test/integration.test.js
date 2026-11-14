import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntime } from '../src/app.js';
import { createFakeUpstream } from './fake-upstream.js';
import { generateApiKey } from '../src/keys.js';
import { hardenDirectory } from '../src/permissions.js';

const execFileAsync = promisify(execFile);

let tempRoot;
let runtime;
let fake;
let adminBase;
let publicBase;
let adminCookie;
let adminCsrf = '';
let keyA;
let recordA;
let keyB;
let recordB;
let deviceKey;
let deviceRecord;

async function adminFetch(pathname, { method = 'GET', body = null, csrf = true, origin = adminBase, cookie = adminCookie } = {}) {
  const headers = {};
  if (csrf) {
    headers['X-VeilLink-CSRF'] =
      pathname === '/admin/api/login' ? '1' : (adminCsrf || '1');
  }
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${adminBase}${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { response, text, json };
}

async function publicFetch(pathname, { apiKey, headers = {}, body = null, method = 'POST', signal = null } = {}) {
  const finalHeaders = { ...headers };
  if (apiKey) finalHeaders['x-api-key'] = apiKey;
  if (body !== null) finalHeaders['content-type'] = 'application/json';
  return fetch(`${publicBase}${pathname}`, {
    method,
    headers: finalHeaders,
    body: body === null ? undefined : JSON.stringify(body),
    signal
  });
}

async function login() {
  const token = (await fs.readFile(runtime.paths.adminTokenFile, 'utf8')).trim();
  const result = await adminFetch('/admin/api/login', {
    method: 'POST',
    body: { token },
    cookie: null
  });
  assert.equal(result.response.status, 200, result.text);
  const setCookies = result.response.headers.getSetCookie
    ? result.response.headers.getSetCookie()
    : [result.response.headers.get('set-cookie')];
  assert.match(setCookies[0], /HttpOnly/);
  assert.match(setCookies[0], /SameSite=Strict/);
  adminCookie = setCookies[0].split(';')[0];
  adminCsrf = result.json.csrfToken;
  assert.match(adminCsrf, /^[A-Za-z0-9_-]{40,}$/);
}

async function configureAnthropic() {
  return configureAnthropicWithKey('up-test-secret');
}

async function configureAnthropicWithKey(apiKey) {
  const result = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: {
      upstream: {
        baseUrl: fake.baseV1,
        protocol: 'anthropic',
        authMode: 'x-api-key',
        apiKey,
        model: 'fake-model',
        timeoutMs: 30000
      },
      public: { baseUrl: 'https://api.example.test' }
    }
  });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.json.upstream.hasApiKey, true);
  assert.equal(result.text.includes(apiKey), false);
}

async function configureOpenAI() {
  const result = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: {
      upstream: {
        baseUrl: fake.baseV1,
        protocol: 'openai',
        authMode: 'auto',
        apiKey: 'up-test-secret',
        model: 'fake-model',
        timeoutMs: 30000
      },
      public: { baseUrl: 'https://api.example.test' }
    }
  });
  assert.equal(result.response.status, 200, result.text);
}

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'veillink-integration-'));
  fake = createFakeUpstream();
  fake.state.expectedApiKey = 'up-test-secret';
  const fakeAddress = await fake.start();

  runtime = await createRuntime({
    dataDir: path.join(tempRoot, 'data'),
    adminPort: 0,
    publicPort: 0,
    hardenPermissions: false
  });
  await runtime.start();
  adminBase = `http://127.0.0.1:${runtime.adminPort}`;
  publicBase = `http://127.0.0.1:${runtime.publicPort}`;
  fake.base = fakeAddress.base;
  fake.baseV1 = fakeAddress.baseV1;

  await login();
  await configureAnthropic();

  const a = await adminFetch('/admin/api/keys', {
    method: 'POST',
    body: { name: 'integration-A', allowedDevice: '' }
  });
  assert.equal(a.response.status, 200, a.text);
  keyA = a.json.key;
  recordA = a.json.record;
  assert.equal(a.text.includes('"hash"'), false);

  const b = await adminFetch('/admin/api/keys', {
    method: 'POST',
    body: { name: 'integration-B', allowedDevice: '' }
  });
  keyB = b.json.key;
  recordB = b.json.record;

  const d = await adminFetch('/admin/api/keys', {
    method: 'POST',
    body: { name: 'integration-device', allowedDevice: 'EXAMPLE-DEVICE-001' }
  });
  deviceKey = d.json.key;
  deviceRecord = d.json.record;
});

after(async () => {
  await runtime?.stop();
  await fake?.stop();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('admin listener enforces host, origin, CSRF, and session auth', async () => {
  const unauth = await adminFetch('/admin/api/state', { cookie: null });
  assert.equal(unauth.response.status, 401);

  const missingCsrf = await adminFetch('/admin/api/state', { csrf: false });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.json.error.code, 'csrf_failed');

  const staticPage = await fetch(`${adminBase}/`);
  assert.equal(staticPage.status, 200);
  assert.match(staticPage.headers.get('content-security-policy'), /default-src 'none'/);

  const favicon = await fetch(`${adminBase}/favicon.png`);
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /^image\/png/);
  const faviconBytes = Buffer.from(await favicon.arrayBuffer());
  assert.equal(faviconBytes.subarray(1, 4).toString('ascii'), 'PNG');

  const noCsrf = await adminFetch('/admin/api/login', {
    method: 'POST',
    body: { token: 'irrelevant' },
    csrf: false,
    cookie: null
  });
  assert.equal(noCsrf.response.status, 403);

  const badOrigin = await adminFetch('/admin/api/login', {
    method: 'POST',
    body: { token: 'irrelevant' },
    origin: 'http://evil.example',
    cookie: null
  });
  assert.equal(badOrigin.response.status, 403);

  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: runtime.adminPort,
        path: '/',
        method: 'GET',
        headers: { Host: 'attacker.example' }
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      }
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(badHost, 403);

  const state = await adminFetch('/admin/api/state');
  assert.equal(state.response.status, 200);
  assert.equal(state.json.server.adminPort, runtime.adminPort);
  assert.equal(state.json.server.publicPort, runtime.publicPort);
  assert.equal(state.json.security.machineHint, os.hostname());
});

test('configuration validation, encrypted secrets, and key lifecycle', async () => {
  const invalidPublic = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: { upstream: { baseUrl: fake.baseV1, protocol: 'anthropic', model: 'fake-model' }, public: { baseUrl: 'http://insecure.test' } }
  });
  assert.equal(invalidPublic.response.status, 400);

  const invalidProtocol = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: { upstream: { baseUrl: fake.baseV1, protocol: 'bogus', model: 'fake-model' } }
  });
  assert.equal(invalidProtocol.response.status, 400);

  const state = await adminFetch('/admin/api/state');
  const serialized = state.text;
  assert.equal(serialized.includes(keyA), false);
  assert.equal(serialized.includes(keyB), false);
  assert.equal(serialized.includes(deviceKey), false);
  assert.equal(serialized.includes('up-test-secret'), false);
  assert.equal(state.json.upstream.hasApiKey, true);

  const keysFile = await fs.readFile(runtime.paths.keysFile, 'utf8');
  const configFile = await fs.readFile(runtime.paths.configFile, 'utf8');
  assert.equal(keysFile.includes(keyA), false);
  assert.equal(configFile.includes('up-test-secret'), false);

  const reveal = await adminFetch(`/admin/api/keys/${recordA.id}/reveal`, { method: 'POST', body: {} });
  assert.equal(reveal.response.status, 200);
  assert.equal(reveal.json.key, keyA);

  const revokeB = await adminFetch(`/admin/api/keys/${recordB.id}/revoke`, { method: 'POST', body: {} });
  assert.equal(revokeB.response.status, 200);
  assert.ok(revokeB.json.record.revokedAt);
});

test('public surface has no admin or static content and enforces authentication', async () => {
  const root = await fetch(`${publicBase}/`);
  assert.equal(root.status, 404);
  assert.equal(root.headers.get('content-type').startsWith('application/json'), true);
  assert.equal((await root.text()).includes('<!doctype html>'), false);

  const adminPath = await fetch(`${publicBase}/admin/api/state`);
  assert.equal(adminPath.status, 404);

  const missing = await publicFetch('/v1/messages', {
    body: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.type, 'authentication_error');

  const invalid = await publicFetch('/v1/messages', {
    apiKey: generateApiKey(),
    body: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(invalid.status, 401);

  const revoked = await publicFetch('/v1/messages', {
    apiKey: keyB,
    body: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(revoked.status, 401);

  const invalidShape = await publicFetch('/v1/messages', {
    apiKey: 'sk-too-short',
    body: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(invalidShape.status, 401);
});

test('device-bound keys reject missing or wrong X-VeilLink-Device', async () => {
  const body = { model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
  const missing = await publicFetch('/v1/messages', { apiKey: deviceKey, body });
  assert.equal(missing.status, 403);

  const wrong = await publicFetch('/v1/messages', {
    apiKey: deviceKey,
    headers: { 'x-veillink-device': 'DESKTOP-WRONG' },
    body
  });
  assert.equal(wrong.status, 403);

  const correct = await publicFetch('/v1/messages', {
    apiKey: deviceKey,
    headers: { 'x-veillink-device': 'example-device-001' },
    body
  });
  assert.equal(correct.status, 200, await correct.text());
});

test('Anthropic passthrough supports headers, model rewriting, streaming, and usage logs', async () => {
  fake.state.requests.length = 0;
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello' }]
  };
  const response = await publicFetch('/v1/messages', {
    apiKey: keyA,
    headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta' },
    body
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.type, 'message');
  assert.equal(json.content[0].text, 'fake anthropic text');
  assert.equal(fake.state.requests.length, 1);
  assert.equal(fake.state.requests[0].body.model, 'fake-model');
  assert.equal(fake.state.requests[0].headers['x-api-key'], 'up-test-secret');
  assert.equal(fake.state.requests[0].headers['anthropic-beta'], 'test-beta');
  assert.equal(fake.state.requests[0].headers['anthropic-version'], '2023-06-01');

  const bearer = await publicFetch('/v1/messages', {
    headers: { authorization: `Bearer ${keyA}` },
    body
  });
  assert.equal(bearer.status, 200);

  const both = await publicFetch('/v1/messages', {
    apiKey: 'sk-000000000000000000000000',
    headers: { authorization: `Bearer ${keyA}` },
    body
  });
  assert.equal(both.status, 200);

  const stream = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const streamText = await stream.text();
  assert.match(streamText, /event: message_start/);
  assert.match(streamText, /"text":"fake "/);
  assert.match(streamText, /"text":"stream"/);
  assert.match(streamText, /event: message_stop/);

  const count = await publicFetch('/v1/messages/count_tokens', {
    apiKey: keyA,
    body
  });
  assert.equal(count.status, 200);
  assert.equal((await count.json()).input_tokens, 42);

  const models = await publicFetch('/v1/models', { apiKey: keyA, method: 'GET', body: null });
  assert.equal(models.status, 200);
  const modelJson = await models.json();
  assert.equal(modelJson.data[0].id, 'fake-model');
});

test('upstream errors are normalized and do not leak secrets', async () => {
  fake.state.failNext = {
    status: 400,
    body: {
      error: {
        type: 'invalid_request_error',
        message: 'bad upstream request; auth=up-test-secret'
      }
    }
  };
  const response = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(response.status, 400);
  const json = await response.json();
  assert.equal(json.type, 'error');
  assert.equal(json.error.type, 'invalid_request_error');
  assert.equal(JSON.stringify(json).includes('up-test-secret'), false);
  assert.equal(JSON.stringify(json).includes(keyA), false);

  const adminStateAfterError = await adminFetch('/admin/api/state');
  assert.equal(adminStateAfterError.text.includes('up-test-secret'), false);

  const promptMarker = 'PROMPT_MARKER_9f3c_should_not_be_logged';
  fake.state.failNext = {
    status: 500,
    body: { error: { message: `boom ${promptMarker}` } }
  };
  const upstreamFailure = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: {
      model: 'x',
      max_tokens: 1,
      messages: [{ role: 'user', content: promptMarker }]
    }
  });
  assert.equal(upstreamFailure.status, 502);
  const failureJson = await upstreamFailure.json();
  assert.equal(JSON.stringify(failureJson).includes('boom'), false);
  assert.equal(JSON.stringify(failureJson).includes(promptMarker), false);

  const stateAfterPromptError = await adminFetch('/admin/api/state');
  assert.equal(stateAfterPromptError.text.includes(promptMarker), false);
  const accessLog = await fs.readFile(runtime.paths.accessLogFile, 'utf8');
  assert.equal(accessLog.includes(promptMarker), false);
});

test('OpenAI upstream translation handles nonstream, tools, streaming, and count_tokens', async () => {
  await configureOpenAI();
  fake.state.requests.length = 0;
  const clientModel = 'claude-test-model';
  const body = {
    model: clientModel,
    max_tokens: 64,
    system: [{ type: 'text', text: 'be terse' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]
      }
    ],
    tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    tool_choice: { type: 'auto' }
  };
  const response = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const json = JSON.parse(responseText);
  assert.equal(json.content[0].text, 'fake nonstream text');
  assert.equal(json.model, clientModel);
  assert.equal(json.usage.input_tokens, 21);
  assert.equal(json.usage.output_tokens, 4);
  assert.equal(json.usage.cache_read_input_tokens, 3);
  assert.equal(fake.state.requests[0].body.model, 'fake-model');
  assert.equal(fake.state.requests[0].body.messages[0].role, 'system');
  assert.ok(fake.state.requests[0].body.messages[1].content.some((part) => part.type === 'image_url'));
  assert.equal(fake.state.requests[0].body.tools[0].function.name, 'read_file');
  assert.equal(fake.state.requests[0].headers.authorization, 'Bearer up-test-secret');

  const streamBody = {
    model: clientModel,
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'USE_TOOL now' }],
    tools: [{ name: 'read_file', input_schema: { type: 'object' } }]
  };
  const stream = await publicFetch('/v1/messages', { apiKey: keyA, body: streamBody });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('cache-control'), /no-store/);
  const sse = await stream.text();
  assert.match(sse, /event: message_start/);
  assert.match(sse, /"type":"text_delta","text":"fake "/);
  assert.match(sse, /"type":"tool_use"/);
  assert.match(sse, /"partial_json":"\{\\"path\\":\\"C:\/tmp\/a\.txt\\"\}"/);
  assert.match(sse, /"stop_reason":"tool_use"/);
  assert.match(sse, /event: message_stop/);
  assert.match(sse, /"usage":\{"input_tokens":21,"output_tokens":4/);
  assert.equal(sse.includes('up-test-secret'), false);

  const count = await publicFetch('/v1/messages/count_tokens', { apiKey: keyA, body });
  assert.equal(count.status, 200);
  assert.ok((await count.json()).input_tokens > 0);
});


test('native Anthropic stream error events are sanitized and do not leak upstream credentials', async () => {
  await configureAnthropic();
  fake.state.requests.length = 0;
  fake.state.anthropicStreamError = true;
  try {
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const sse = await response.text();
    assert.equal(response.status, 200);
    assert.match(sse, /event: error/);
    assert.equal(sse.includes('message_stop'), false);
    assert.equal(sse.includes('up-test-secret'), false);
    assert.equal(sse.includes('upstream exploded'), false);
    const state = await adminFetch('/admin/api/state');
    assert.equal(state.text.includes('up-test-secret'), false);
  } finally {
    fake.state.anthropicStreamError = false;
  }
});

test('native Anthropic streams without message_stop fail closed', async () => {
  await configureAnthropic();
  fake.state.requests.length = 0;
  fake.state.truncateAnthropicStream = true;
  try {
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const sse = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(sse, /event: error/);
    assert.equal(sse.includes('message_stop'), false);
    assert.match(sse, /partial/);
  } finally {
    fake.state.truncateAnthropicStream = false;
  }
});

test('upstream key echoes are scrubbed in all response modes', async () => {
  const secret = 'up-test-secret';
  fake.state.leakText = `leaked ${secret} end`;
  const body = {
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }]
  };
  try {
    await configureAnthropic();
    const native = await publicFetch('/v1/messages', { apiKey: keyA, body });
    const nativeText = await native.text();
    assert.equal(nativeText.includes(secret), false);
    assert.match(nativeText, /\[REDACTED\]/);

    const nativeStream = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const nativeSse = await nativeStream.text();
    assert.equal(nativeSse.includes(secret), false);
    assert.match(nativeSse, /\[REDACTED\]/);

    await configureOpenAI();
    const openai = await publicFetch('/v1/messages', { apiKey: keyA, body });
    const openaiText = await openai.text();
    assert.equal(openaiText.includes(secret), false);
    assert.match(openaiText, /\[REDACTED\]/);

    const openaiStream = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const openaiSse = await openaiStream.text();
    assert.equal(openaiSse.includes(secret), false);
    assert.match(openaiSse, /\[REDACTED\]/);
  } finally {
    fake.state.leakText = '';
  }
});

test('split upstream key echoes are not reconstructable', async () => {
  const secret = 'up-test-secret';
  fake.state.splitSecret = true;
  const body = {
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }]
  };
  try {
    await configureAnthropic();
    const native = await publicFetch('/v1/messages', { apiKey: keyA, body });
    assert.equal(native.status, 502);
    assert.equal((await native.text()).includes(secret), false);

    const nativeStream = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const nativeSse = await nativeStream.text();
    assert.equal(nativeSse.includes(secret), false);
    assert.match(nativeSse, /\[REDACTED\]/);

    fake.state.splitSecret = false;
    fake.state.splitSecretAcrossBlocks = true;
    const nativeBlocks = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const nativeBlocksSse = await nativeBlocks.text();
    assert.equal(nativeBlocksSse.includes(secret), false);
    assert.match(nativeBlocksSse, /\[REDACTED\]/);
    fake.state.splitSecretAcrossBlocks = false;
    fake.state.splitSecretInToolArgs = true;
    const nativeToolArgs = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const nativeToolArgsSse = await nativeToolArgs.text();
    assert.equal(nativeToolArgsSse.includes(secret), false);
    assert.match(nativeToolArgsSse, /\[REDACTED\]/);
    fake.state.splitSecretInToolArgs = false;
    fake.state.splitSecretInThinking = true;
    const nativeThinking = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const nativeThinkingSse = await nativeThinking.text();
    assert.equal(nativeThinkingSse.includes(secret), false);
    assert.match(nativeThinkingSse, /\[REDACTED\]/);

    fake.state.splitSecretInThinking = false;
    fake.state.splitSecretInSignature = true;
    const nativeSignature = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const nativeSignatureSse = await nativeSignature.text();
    assert.equal(nativeSignatureSse.includes(secret), false);
    assert.match(nativeSignatureSse, /\[REDACTED\]/);

    fake.state.splitSecretInSignature = false;
    fake.state.splitSecret = true;

    await configureOpenAI();
    const openaiStream = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { ...body, stream: true }
    });
    const openaiSse = await openaiStream.text();
    assert.equal(openaiSse.includes(secret), false);
    assert.match(openaiSse, /\[REDACTED\]/);
  } finally {
    fake.state.splitSecret = false;
    fake.state.splitSecretAcrossBlocks = false;
    fake.state.splitSecretInToolArgs = false;
    fake.state.splitSecretInThinking = false;
    fake.state.splitSecretInSignature = false;
  }
});

test('special-character upstream keys are redacted from non-stream and models responses', async () => {
  const special = 'up"key\\tail';
  const escaped = JSON.stringify(special).slice(1, -1);
  fake.state.expectedApiKey = special;
  fake.state.echoUpstreamKey = true;
  try {
    await configureAnthropicWithKey(special);
    const body = {
      model: 'claude-test',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }]
    };
    const native = await publicFetch('/v1/messages', { apiKey: keyA, body });
    assert.equal(native.status, 200);
    const nativeText = await native.text();
    assert.equal(nativeText.includes(special), false);
    assert.equal(nativeText.includes(escaped), false);
    assert.match(nativeText, /\[REDACTED\]/);

    const testResult = await adminFetch('/admin/api/upstream/test', {
      method: 'POST',
      body: {}
    });
    assert.equal(testResult.response.status, 200, testResult.text);
    assert.equal(testResult.json.ok, true);
    assert.equal(testResult.text.includes(special), false);
    assert.equal(testResult.text.includes(escaped), false);
    assert.match(testResult.json.preview, /\[REDACTED\]/);

    // With an empty upstream model, /v1/models is proxied to the upstream
    // instead of returning the synthetic model list.
    const modelsConfig = await adminFetch('/admin/api/config', {
      method: 'PUT',
      body: {
        upstream: {
          baseUrl: fake.baseV1,
          protocol: 'anthropic',
          authMode: 'x-api-key',
          apiKey: special,
          model: '',
          timeoutMs: 30000
        },
        public: { baseUrl: 'https://api.example.test' }
      }
    });
    assert.equal(modelsConfig.response.status, 200, modelsConfig.text);
    const models = await publicFetch('/v1/models', { apiKey: keyA, method: 'GET' });
    assert.equal(models.status, 200);
    const modelsText = await models.text();
    assert.equal(modelsText.includes(special), false);
    assert.equal(modelsText.includes(escaped), false);
    assert.match(modelsText, /\[REDACTED\]/);
  } finally {
    fake.state.expectedApiKey = 'up-test-secret';
    fake.state.echoUpstreamKey = false;
    await configureAnthropic();
  }
});

test('held-back stream text is emitted before message_delta', async () => {
  fake.state.expectedApiKey = 'sk-holdback';
  fake.state.holdbackStream = true;
  try {
    await configureAnthropicWithKey('sk-holdback');
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    const eventNames = [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    const deltaIndex = eventNames.indexOf('message_delta');
    assert.notEqual(deltaIndex, -1);
    assert.deepEqual(eventNames.slice(deltaIndex + 1), ['message_stop']);
    const parsed = [...sse.matchAll(/^data: (.+)$/gm)]
      .map((match) => {
        try {
          return JSON.parse(match[1]);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const text = parsed
      .filter(
        (event) =>
          event.type === 'content_block_delta' && event.delta?.type === 'text_delta'
      )
      .map((event) => event.delta.text)
      .join('');
    assert.equal(text, 'status');
  } finally {
    fake.state.expectedApiKey = 'up-test-secret';
    fake.state.holdbackStream = false;
    await configureAnthropic();
  }
});

test('normal thinking streams preserve thinking and signature deltas', async () => {
  fake.state.thinkingStream = true;
  try {
    await configureAnthropic();
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const sse = await response.text();
    assert.match(sse, /"thinking":"think "/);
    assert.match(sse, /"thinking":"hard"/);
    assert.match(sse, /"signature":"sig-abc"/);
    assert.match(sse, /"type":"content_block_stop"/);
    assert.equal(sse.includes('[REDACTED]'), false);
  } finally {
    fake.state.thinkingStream = false;
  }
});

test('stream error text is not persisted in logs or stats', async () => {
  const marker = 'PROMPT_STREAM_MARKER_9c41';
  const body = {
    model: 'claude-test',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: marker }]
  };
  await configureAnthropic();
  fake.state.anthropicStreamError = true;
  fake.state.anthropicStreamErrorMessage = `prompt ${marker}`;
  try {
    const response = await publicFetch('/v1/messages', { apiKey: keyA, body });
    const sse = await response.text();
    assert.equal(sse.includes(marker), false);
    const state = await adminFetch('/admin/api/state');
    assert.equal(state.text.includes(marker), false);
    const log = await fs.readFile(runtime.paths.accessLogFile, 'utf8');
    assert.equal(log.includes(marker), false);
  } finally {
    fake.state.anthropicStreamError = false;
    fake.state.anthropicStreamErrorMessage = '';
  }

  await configureOpenAI();
  fake.state.openaiStreamErrorMessage = `prompt ${marker}`;
  try {
    const response = await publicFetch('/v1/messages', { apiKey: keyA, body });
    const sse = await response.text();
    assert.equal(sse.includes(marker), false);
    const state = await adminFetch('/admin/api/state');
    assert.equal(state.text.includes(marker), false);
    const log = await fs.readFile(runtime.paths.accessLogFile, 'utf8');
    assert.equal(log.includes(marker), false);
  } finally {
    fake.state.openaiStreamErrorMessage = '';
  }
});

test('truncated OpenAI streams become errors, not successful tool calls', async () => {
  await configureOpenAI();
  fake.state.requests.length = 0;
  fake.state.truncateOpenAIStream = true;
  try {
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'USE_TOOL please' }]
      }
    });
    const sse = await response.text();
    assert.equal(response.status, 200);
    assert.match(sse, /event: error/);
    assert.equal(sse.includes('event: message_stop'), false);
    assert.equal(sse.includes('"type":"tool_use"'), false);
    assert.equal(sse.includes('"name":"read_file"'), false);
    const state = await adminFetch('/admin/api/state');
    assert.equal(state.text.includes('up-test-secret'), false);
  } finally {
    fake.state.truncateOpenAIStream = false;
  }
});

test('indexless parallel OpenAI tool calls are all preserved', async () => {
  await configureOpenAI();
  fake.state.unindexedToolCalls = true;
  try {
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const sse = await response.text();
    assert.match(sse, /"id":"call_a"/);
    assert.match(sse, /"id":"call_b"/);
    assert.match(sse, /"name":"alpha"/);
    assert.match(sse, /"name":"beta"/);
    assert.match(sse, /"stop_reason":"tool_use"/);
  } finally {
    fake.state.unindexedToolCalls = false;
  }
});

test('non-stream refusals are returned as text', async () => {
  await configureOpenAI();
  fake.state.nonstreamRefusal = true;
  try {
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      }
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.match(json.content[0].text, /cannot comply/);
  } finally {
    fake.state.nonstreamRefusal = false;
  }
});

test('client abort before upstream headers releases the concurrency slot', async () => {
  await configureOpenAI();
  fake.state.requests.length = 0;
  fake.state.delayHeadersMs = 800;
  const controller = new AbortController();
  try {
    const request = publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'claude-test',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'slow headers' }]
      },
      signal: controller.signal
    });
    const started = Date.now();
    while (fake.state.requests.length === 0 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fake.state.requests.length, 1);
    controller.abort();
    await request.catch(() => {});
    const releaseDeadline = Date.now() + 1000;
    while (runtime.stats.active !== 0 && Date.now() < releaseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.stats.active, 0);
    const state = await adminFetch('/admin/api/state');
    const latest = state.json.logs.find((entry) => entry.kind === 'request');
    assert.equal(latest.status, 499);
  } finally {
    fake.state.delayHeadersMs = 0;
  }
});

test('request logs contain metadata only, redact keys, and can be cleared', async () => {
  const state = await adminFetch('/admin/api/state');
  assert.equal(state.response.status, 200);
  assert.equal(state.text.includes(keyA), false);
  assert.equal(state.text.includes(deviceKey), false);
  const requests = state.json.logs.filter((entry) => entry.kind === 'request');
  assert.ok(requests.length >= 3);
  assert.ok(requests.some((entry) => entry.status === 200 && entry.inputTokens !== null));
  assert.ok(requests.every((entry) => !JSON.stringify(entry).includes(keyA)));
  const logFile = await fs.readFile(runtime.paths.accessLogFile, 'utf8');
  assert.equal(logFile.includes(keyA), false);
  assert.equal(logFile.includes(deviceKey), false);

  const clear = await adminFetch('/admin/api/logs/clear', { method: 'POST', body: {} });
  assert.equal(clear.response.status, 200);
  const afterClear = await adminFetch('/admin/api/state');
  assert.equal(afterClear.json.logs.filter((entry) => entry.kind === 'request').length, 0);
  assert.ok(afterClear.json.logs.some((entry) => entry.action && entry.action.includes('清空')));
});

test('oversized bodies are rejected before upstream dispatch', async () => {
  const previous = runtime.configStore.config.limits.bodyBytes;
  runtime.configStore.config.limits.bodyBytes = 1024;
  try {
    const huge = 'x'.repeat(2000);
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: huge }] }
    });
    assert.equal(response.status, 413);
    const json = await response.json();
    assert.equal(json.error.type, 'request_too_large');
  } finally {
    runtime.configStore.config.limits.bodyBytes = previous;
  }
});

test('public rate limits return 429', async () => {
  await configureAnthropic();
  const previous = runtime.configStore.config.limits.requestsPerMinutePerKey;
  runtime.configStore.config.limits.requestsPerMinutePerKey = 1;
  const generated = await runtime.keyStore.generate({ name: 'rate-limit-test' });
  const body = {
    model: 'claude-test',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'rate limit' }]
  };
  try {
    const first = await publicFetch('/v1/messages', { apiKey: generated.key, body });
    assert.equal(first.status, 200, await first.text());
    const second = await publicFetch('/v1/messages', { apiKey: generated.key, body });
    assert.equal(second.status, 429);
    const json = await second.json();
    assert.equal(json.error.type, 'rate_limit_error');
  } finally {
    runtime.configStore.config.limits.requestsPerMinutePerKey = previous;
  }
});

test('admin credential reset invalidates existing sessions', async () => {
  const oldCookie = adminCookie;
  const oldCsrf = adminCsrf;
  const newToken = await runtime.adminAuth.reset();

  const stale = await adminFetch('/admin/api/state', { cookie: oldCookie, csrf: true });
  assert.equal(stale.response.status, 401);

  const loginAgain = await adminFetch('/admin/api/login', {
    method: 'POST',
    body: { token: newToken },
    cookie: null,
    csrf: true
  });
  assert.equal(loginAgain.response.status, 200, loginAgain.text);
  assert.match(loginAgain.json.csrfToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(loginAgain.json.csrfToken, oldCsrf);

  const setCookies = loginAgain.response.headers.getSetCookie
    ? loginAgain.response.headers.getSetCookie()
    : [loginAgain.response.headers.get('set-cookie')];
  adminCookie = setCookies[0].split(';')[0];
  adminCsrf = loginAgain.json.csrfToken;

  const fresh = await adminFetch('/admin/api/state');
  assert.equal(fresh.response.status, 200);
});

test('Windows ACL hardening removes pre-existing broad explicit ACEs', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'veillink-acl-'));
  try {
    await fs.writeFile(path.join(dir, 'child.txt'), 'acl test');
    const systemRoot = process.env.SystemRoot || 'C:\Windows';
    const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
    await execFileAsync(icacls, [dir, '/grant', '*S-1-1-0:(OI)(CI)F', '/Q']);

    const result = await hardenDirectory(dir);
    assert.equal(result.ok, true, result.error);

    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const escaped = dir.replaceAll("'", "''");
    const { stdout } = await execFileAsync(powershell, [
      '-NoProfile',
      '-Command',
      `$acl = Get-Acl -LiteralPath '${escaped}'; $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value; Write-Output ('OWNER=' + $owner); $acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }`
    ]);
    assert.equal(stdout.includes('S-1-1-0'), false, stdout);
    assert.match(stdout, /OWNER=S-1-5-/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
