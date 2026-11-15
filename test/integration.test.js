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

const UPSTREAM_KEY = 'up-test-secret';

function resetFake() {
  fake.state.requests.length = 0;
  fake.state.failNext = null;
  fake.state.delayHeadersMs = 0;
  fake.state.delayMs = 0;
  fake.state.abortAfterHeaders = false;
  fake.state.countTokensPayload = null;
  Object.assign(fake.state.anthropic, {
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
  });
  Object.assign(fake.state.responses, {
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
  });
  Object.assign(fake.state.chat, {
    truncate: false,
    error: false,
    splitSecret: false,
    crossFieldSplit: false,
    leakText: ''
  });
  fake.state.storedResponses.clear();
  fake.state.storedChats.clear();
}

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

async function publicFetch(pathname, {
  apiKey,
  headers = {},
  body = null,
  method = 'POST',
  signal = null
} = {}) {
  const finalHeaders = { ...headers };
  if (apiKey) finalHeaders['x-api-key'] = apiKey;
  if (body !== null && !Object.keys(finalHeaders).some((name) => name.toLowerCase() === 'content-type')) {
    finalHeaders['content-type'] = 'application/json';
  }
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

async function configureProtocol(protocol, models = ['fake-model', 'second-model']) {
  const result = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: {
      upstream: {
        baseUrl: fake.baseV1,
        protocol,
        authMode: protocol === 'anthropic' ? 'x-api-key' : 'bearer',
        apiKey: UPSTREAM_KEY,
        models,
        timeoutMs: 30000
      },
      public: { baseUrl: 'https://api.example.test' }
    }
  });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.json.upstream.hasApiKey, true);
  assert.equal(result.text.includes(UPSTREAM_KEY), false);
  resetFake();
  return result;
}

function sseTypes(sse) {
  return [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
}

function sseData(sse) {
  return [...sse.matchAll(/^data: (.+)$/gm)]
    .map((match) => {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'veillink-integration-'));
  fake = createFakeUpstream();
  fake.state.expectedApiKey = UPSTREAM_KEY;
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
  await configureProtocol('anthropic', ['fake-model', 'second-model']);

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
    body: { name: 'integration-device', allowedDevice: 'TEST-DEVICE' }
  });
  deviceKey = d.json.key;
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
  assert.deepEqual(state.json.upstream.models, ['fake-model', 'second-model']);
});

test('configuration validation, encrypted secrets, and key lifecycle', async () => {
  const invalidPublic = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: { upstream: { baseUrl: fake.baseV1, protocol: 'anthropic', models: ['fake-model'] }, public: { baseUrl: 'http://insecure.test' } }
  });
  assert.equal(invalidPublic.response.status, 400);

  const invalidProtocol = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: { upstream: { baseUrl: fake.baseV1, protocol: 'bogus', models: ['fake-model'] } }
  });
  assert.equal(invalidProtocol.response.status, 400);

  const tooMany = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: {
      upstream: {
        baseUrl: fake.baseV1,
        protocol: 'openai-chat',
        models: ['a', 'b', 'c', 'd', 'e', 'f']
      }
    }
  });
  assert.equal(tooMany.response.status, 400);

  const duplicate = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: {
      upstream: {
        baseUrl: fake.baseV1,
        protocol: 'openai-chat',
        models: ['a', 'a']
      }
    }
  });
  assert.equal(duplicate.response.status, 400);

  const emptyModels = await adminFetch('/admin/api/config', {
    method: 'PUT',
    body: { upstream: { baseUrl: fake.baseV1, protocol: 'anthropic', models: [] } }
  });
  assert.equal(emptyModels.response.status, 400);

  const state = await adminFetch('/admin/api/state');
  assert.equal(state.text.includes(keyA), false);
  assert.equal(state.text.includes(keyB), false);
  assert.equal(state.text.includes(deviceKey), false);
  assert.equal(state.text.includes(UPSTREAM_KEY), false);
  assert.equal(state.json.upstream.hasApiKey, true);

  const keysFile = await fs.readFile(runtime.paths.keysFile, 'utf8');
  const configFile = await fs.readFile(runtime.paths.configFile, 'utf8');
  assert.equal(keysFile.includes(keyA), false);
  assert.equal(configFile.includes(UPSTREAM_KEY), false);
  const storedConfig = JSON.parse(configFile);
  assert.equal(storedConfig.version, 2);
  assert.deepEqual(storedConfig.upstream.models, ['fake-model', 'second-model']);

  const reveal = await adminFetch(`/admin/api/keys/${recordA.id}/reveal`, { method: 'POST', body: {} });
  assert.equal(reveal.response.status, 200);
  assert.equal(reveal.json.key, keyA);

  const revokeB = await adminFetch(`/admin/api/keys/${recordB.id}/revoke`, { method: 'POST', body: {} });
  assert.equal(revokeB.response.status, 200);
  assert.ok(revokeB.json.record.revokedAt);
});

test('public surface has no admin or static content and enforces authentication and protocol routes', async () => {
  const root = await fetch(`${publicBase}/`);
  assert.equal(root.status, 404);
  assert.equal(root.headers.get('content-type').startsWith('application/json'), true);
  assert.equal((await root.text()).includes('<!doctype html>'), false);

  const adminPath = await fetch(`${publicBase}/admin/api/state`);
  assert.equal(adminPath.status, 404);

  const missing = await publicFetch('/v1/messages', {
    body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.type, 'authentication_error');

  const invalid = await publicFetch('/v1/messages', {
    apiKey: generateApiKey(),
    body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(invalid.status, 401);

  const revoked = await publicFetch('/v1/messages', {
    apiKey: keyB,
    body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(revoked.status, 401);

  const invalidShape = await publicFetch('/v1/messages', {
    apiKey: 'sk-too-short',
    body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(invalidShape.status, 401);

  const wrongProtocol = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hi' }
  });
  assert.equal(wrongProtocol.status, 404);

  const wrongMethod = await publicFetch('/v1/messages', {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get('allow'), /POST/);
});

test('device-bound keys reject missing or wrong X-VeilLink-Device', async () => {
  const body = { model: 'fake-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
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
    headers: { 'x-veillink-device': 'test-device' },
    body
  });
  assert.equal(correct.status, 200, await correct.text());
});

test('Anthropic passthrough keeps model, headers, usage, models, and streaming', async () => {
  await configureProtocol('anthropic', ['fake-model', 'second-model']);
  const body = {
    model: 'fake-model',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello' }]
  };
  const response = await publicFetch('/v1/messages', {
    apiKey: keyA,
    headers: {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'test-beta',
      'anthropic-workspace-id': 'wrkspc_test',
      'anthropic-user-profile-id': 'profile_test',
      'x-app': 'test-app'
    },
    body
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.type, 'message');
  assert.equal(json.content[0].text, 'fake anthropic text');
  assert.equal(response.headers.get('anthropic-ratelimit-requests-remaining'), '99');
  assert.equal(fake.state.requests.length, 1);
  assert.equal(fake.state.requests[0].body.model, 'fake-model');
  assert.equal(fake.state.requests[0].headers['x-api-key'], UPSTREAM_KEY);
  assert.equal(fake.state.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(fake.state.requests[0].headers['anthropic-beta'], 'test-beta');
  assert.equal(fake.state.requests[0].headers['anthropic-workspace-id'], undefined);
  assert.equal(fake.state.requests[0].headers['anthropic-user-profile-id'], undefined);
  assert.equal(fake.state.requests[0].headers['x-app'], 'test-app');

  const defaultVersion = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body
  });
  assert.equal(defaultVersion.status, 200, await defaultVersion.text());
  assert.equal(fake.state.requests[1].headers['anthropic-version'], '2026-10-21');

  const bearer = await publicFetch('/v1/messages', {
    headers: { authorization: `Bearer ${keyA}` },
    body
  });
  assert.equal(bearer.status, 200);

  const both = await publicFetch('/v1/messages', {
    apiKey: 'sk-not-a-real-key',
    headers: { authorization: `Bearer ${keyA}` },
    body
  });
  assert.equal(both.status, 200);

  const count = await publicFetch('/v1/messages/count_tokens', {
    apiKey: keyA,
    body: { model: 'second-model', messages: [{ role: 'user', content: 'hello' }] }
  });
  assert.equal(count.status, 200);
  assert.equal((await count.json()).input_tokens, 42);
  assert.equal(fake.state.requests.at(-1).body.model, 'second-model');

  fake.state.failNext = {
    status: 404,
    body: { error: { type: 'not_found_error', message: 'count_tokens unavailable' } }
  };
  const countError = await publicFetch('/v1/messages/count_tokens', {
    apiKey: keyA,
    body: { model: 'second-model', messages: [{ role: 'user', content: 'hello' }] }
  });
  assert.equal(countError.status, 404);
  assert.equal((await countError.json()).error.type, 'not_found_error');

  const models = await publicFetch('/v1/models', { apiKey: keyA, method: 'GET', body: null });
  assert.equal(models.status, 200);
  const modelJson = await models.json();
  assert.deepEqual(modelJson.data.map((item) => item.id), ['fake-model', 'second-model']);
  assert.equal(modelJson.first_id, 'fake-model');
  assert.equal(modelJson.last_id, 'second-model');

  const retrieve = await publicFetch('/v1/models/fake-model', {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(retrieve.status, 200);
  assert.equal((await retrieve.json()).id, 'fake-model');

  const missingModel = await publicFetch('/v1/models/not-configured', {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(missingModel.status, 404);

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
  assert.match(streamText, /event: message_delta/);
  assert.match(streamText, /event: message_stop/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const streamLog = runtime.logStore.list(1)[0];
  assert.equal(streamLog.inputTokens, 13);
  assert.equal(streamLog.outputTokens, 2);
});

test('Anthropic rejects unknown or missing models before upstream dispatch', async () => {
  await configureProtocol('anthropic', ['fake-model', 'second-model']);
  const unknown = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'unknown-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.type, 'not_found_error');
  assert.equal(fake.state.requests.length, 0);

  const missing = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(missing.status, 400);
  assert.equal(fake.state.requests.length, 0);
});

test('Anthropic stream errors, truncation, and secret echoes fail closed', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  const body = {
    model: 'fake-model',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }]
  };

  fake.state.anthropic.streamError = true;
  fake.state.anthropic.streamErrorMessage = `upstream exploded with ${UPSTREAM_KEY}`;
  const errorStream = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const errorSse = await errorStream.text();
  assert.match(errorSse, /event: error/);
  assert.equal(errorSse.includes('message_stop'), false);
  assert.equal(errorSse.includes(UPSTREAM_KEY), false);
  assert.equal(errorSse.includes('upstream exploded'), false);

  fake.state.anthropic.streamError = false;
  fake.state.anthropic.truncate = true;
  const truncated = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const truncatedSse = await truncated.text();
  assert.match(truncatedSse, /event: error/);
  assert.equal(truncatedSse.includes('message_stop'), false);
  assert.match(truncatedSse, /partial|fake /);

  fake.state.anthropic.truncate = false;
  fake.state.anthropic.leakText = `leaked ${UPSTREAM_KEY} end`;
  const native = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'fake-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
  });
  const nativeText = await native.text();
  assert.equal(nativeText.includes(UPSTREAM_KEY), false);
  assert.match(nativeText, /\[REDACTED\]/);

  const leakStream = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const leakSse = await leakStream.text();
  assert.equal(leakSse.includes(UPSTREAM_KEY), false);
  assert.match(leakSse, /\[REDACTED\]/);

  fake.state.anthropic.leakText = '';
  fake.state.anthropic.splitSecret = true;
  const splitNonStream = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'fake-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(splitNonStream.status, 502);
  assert.equal((await splitNonStream.text()).includes(UPSTREAM_KEY), false);

  const splitStream = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const splitSse = await splitStream.text();
  assert.equal(splitSse.includes(UPSTREAM_KEY), false);
  assert.match(splitSse, /\[REDACTED\]/);
});

test('Anthropic split secrets across blocks, tools, thinking, and signatures are redacted', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  const body = {
    model: 'fake-model',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }]
  };
  for (const flag of [
    'splitSecretAcrossBlocks',
    'splitSecretInToolArgs',
    'splitSecretInThinking',
    'splitSecretInSignature'
  ]) {
    resetFake();
    fake.state.anthropic[flag] = true;
    const response = await publicFetch('/v1/messages', { apiKey: keyA, body });
    const sse = await response.text();
    assert.equal(sse.includes(UPSTREAM_KEY), false, flag);
    assert.match(sse, /\[REDACTED\]/, flag);
  }

  resetFake();
  fake.state.anthropic.leakEventName = true;
  const eventNameLeak = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const eventNameSse = await eventNameLeak.text();
  assert.equal(eventNameSse.includes(UPSTREAM_KEY), false);
  assert.match(eventNameSse, /event: \[REDACTED\]/);

  resetFake();
  fake.state.anthropic.crossFieldSplit = true;
  const crossField = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const crossFieldSse = await crossField.text();
  assert.equal(crossFieldSse.includes(UPSTREAM_KEY), false);
  assert.match(crossFieldSse, /event: error/);
  assert.equal(crossFieldSse.includes('event: message_stop'), false);

  resetFake();
  fake.state.anthropic.holdbackStream = true;
  const held = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const heldSse = await held.text();
  const names = sseTypes(heldSse);
  const deltaIndex = names.indexOf('message_delta');
  assert.notEqual(deltaIndex, -1);
  assert.deepEqual(names.slice(deltaIndex + 1), ['message_stop']);
  const text = sseData(heldSse)
    .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
    .map((event) => event.delta.text)
    .join('');
  assert.equal(text, 'status');

  resetFake();
  fake.state.anthropic.thinkingStream = true;
  const thinking = await publicFetch('/v1/messages', { apiKey: keyA, body });
  const thinkingSse = await thinking.text();
  assert.match(thinkingSse, /"thinking":"think "/);
  assert.match(thinkingSse, /"thinking":"hard"/);
  assert.match(thinkingSse, /"signature":"sig-abc"/);
  assert.equal(thinkingSse.includes('[REDACTED]'), false);
});

test('OpenAI Responses passthrough supports create, stream, disabled lifecycle, compact, and token counting', async () => {
  await configureProtocol('openai-responses', ['resp-model-a', 'resp-model-b']);
  const body = {
    model: 'resp-model-a',
    input: 'hello',
    max_output_tokens: 32
  };
  const response = await publicFetch('/v1/responses', {
    apiKey: keyA,
    headers: { 'openai-beta': 'responses-test' },
    body
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const json = JSON.parse(responseText);
  assert.equal(json.object, 'response');
  assert.equal(json.output_text, 'fake responses text');
  assert.equal(json.usage.input_tokens, 21);
  assert.equal(fake.state.requests[0].path, '/v1/responses');
  assert.equal(fake.state.requests[0].body.model, 'resp-model-a');
  assert.equal(fake.state.requests[0].headers.authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(fake.state.requests[0].headers['openai-beta'], 'responses-test');
  assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '99');

  const unknown = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'unknown', input: 'hi' }
  });
  assert.equal(unknown.status, 404);
  assert.equal(fake.state.requests.length, 1);

  const missing = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { input: 'hi' }
  });
  assert.equal(missing.status, 400);

  const stream = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  assert.equal(stream.status, 200);
  const sse = await stream.text();
  const names = sseTypes(sse);
  assert.ok(names.includes('response.created'));
  assert.ok(names.includes('response.output_text.delta'));
  assert.ok(names.includes('response.completed'));
  assert.equal(sse.includes('data: [DONE]'), false);
  const terminal = sseData(sse).find((event) => event.type === 'response.completed');
  assert.equal(terminal.response.usage.input_tokens, 21);

  fake.state.responses.terminal = 'incomplete';
  const incomplete = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  const incompleteSse = await incomplete.text();
  assert.match(incompleteSse, /event: response\.incomplete/);

  fake.state.responses.terminal = 'failed';
  const failed = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  const failedSse = await failed.text();
  assert.match(failedSse, /event: response\.failed/);
  assert.equal(failedSse.includes('response.completed'), false);

  fake.state.responses.terminal = 'completed';
  fake.state.responses.truncate = true;
  const truncated = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  const truncatedSse = await truncated.text();
  assert.match(truncatedSse, /event: error/);
  assert.equal(truncatedSse.includes('response.completed'), false);

  fake.state.responses.truncate = false;
  fake.state.responses.error = true;
  const error = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  const errorSse = await error.text();
  assert.match(errorSse, /event: error/);
  assert.equal(errorSse.includes('response.completed'), false);
  assert.equal(errorSse.includes('internal-only'), false);

  fake.state.responses.error = false;
  const created = await publicFetch('/v1/responses', { apiKey: keyA, body });
  const createdJson = await created.json();
  const createdId = createdJson.id;
  assert.ok(createdId);
  assert.equal(created.status, 200);

  const otherKey = await runtime.keyStore.generate({ name: 'responses-other' });
  const crossKeyPrevious = await publicFetch('/v1/responses', {
    apiKey: otherKey.key,
    body: { model: 'resp-model-a', input: 'continue', previous_response_id: createdId }
  });
  assert.equal(crossKeyPrevious.status, 404);
  assert.equal((await crossKeyPrevious.json()).error.code, 'previous_response_not_found');

  const sameKeyPrevious = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'continue', previous_response_id: createdId }
  });
  assert.equal(sameKeyPrevious.status, 200, await sameKeyPrevious.text());
  assert.equal(fake.state.requests.at(-1).body.previous_response_id, createdId);

  const background = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'hi', background: true }
  });
  assert.equal(background.status, 400);

  const conversation = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'hi', conversation: 'conv_test' }
  });
  assert.equal(conversation.status, 400);

  const itemReference = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: {
      model: 'resp-model-a',
      input: [{ type: 'item_reference', id: 'item_from_another_key' }]
    }
  });
  assert.equal(itemReference.status, 400);

  for (const input of [
    [{ id: 'item_from_another_key' }],
    [{ id: 'item_from_another_key', role: null }],
    [{ id: 'item_from_another_key', type: null }],
    [{ id: 'item_from_another_key', content: null }],
    [{ id: 'item_from_another_key', role: '' }],
    [{ id: 'item_from_another_key', type: '' }],
    [{ id: 'item_from_another_key', content: '' }],
    [{ id: 'item_from_another_key', content: [] }],
    [{ id: 'item_from_another_key', role: 0 }],
    [{ id: 'item_from_another_key', type: false }],
    [{ id: 'item_from_another_key', content: {} }],
    [{ id: 'item_from_another_key', role: 'user' }],
    [{ id: 'item_from_another_key', type: 'message' }]
  ]) {
    const idOnlyReference = await publicFetch('/v1/responses', {
      apiKey: keyA,
      body: { model: 'resp-model-a', input }
    });
    assert.equal(idOnlyReference.status, 400);
  }

  const typedInput = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: {
      model: 'resp-model-a',
      input: [
        {
          type: 'message',
          role: 'user',
          content: 'hi',
          metadata: { id: 'nested_metadata_id' }
        }
      ]
    }
  });
  assert.equal(typedInput.status, 200, await typedInput.text());

  // Stored-object lifecycle is intentionally not exposed: upstream objects
  // are not scoped to the VeilLink API key that created them.
  const retrieved = await publicFetch(`/v1/responses/${createdId}`, {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(retrieved.status, 404);

  const inputItems = await publicFetch(`/v1/responses/${createdId}/input_items?limit=5`, {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(inputItems.status, 404);

  const cancel = await publicFetch(`/v1/responses/${createdId}/cancel`, {
    apiKey: keyA,
    body: {}
  });
  assert.equal(cancel.status, 404);

  const compact = await publicFetch('/v1/responses/compact', {
    apiKey: keyA,
    body: { model: 'resp-model-b', input: 'long conversation' }
  });
  assert.equal(compact.status, 200);
  const compactJson = await compact.json();
  assert.equal(compactJson.object, 'response.compaction');
  assert.equal(fake.state.requests.at(-1).path, '/v1/responses/compact');
  assert.equal(fake.state.requests.at(-1).body.model, 'resp-model-b');

  const inputTokens = await publicFetch('/v1/responses/input_tokens', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'hello' }
  });
  assert.equal(inputTokens.status, 200);
  assert.equal((await inputTokens.json()).input_tokens, 33);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.logStore.list(1)[0].inputTokens, 33);

  const inputTokensNoModel = await publicFetch('/v1/responses/input_tokens', {
    apiKey: keyA,
    body: { input: 'hello' }
  });
  assert.equal(inputTokensNoModel.status, 200, await inputTokensNoModel.text());
  assert.equal(fake.state.requests.at(-1).body.model, undefined);

  const inputTokensBadModel = await publicFetch('/v1/responses/input_tokens', {
    apiKey: keyA,
    body: { model: 123, input: 'hello' }
  });
  assert.equal(inputTokensBadModel.status, 400);

  const unknownCompact = await publicFetch('/v1/responses/compact', {
    apiKey: keyA,
    body: { model: 'unknown', input: 'hi' }
  });
  assert.equal(unknownCompact.status, 404);

  const deleted = await publicFetch(`/v1/responses/${createdId}`, {
    apiKey: keyA,
    method: 'DELETE',
    body: null
  });
  assert.equal(deleted.status, 404);

  const models = await publicFetch('/v1/models', { apiKey: keyA, method: 'GET', body: null });
  const modelJson = await models.json();
  assert.equal(modelJson.object, 'list');
  assert.deepEqual(modelJson.data.map((item) => item.id), ['resp-model-a', 'resp-model-b']);

  const wrongEndpoint = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'resp-model-a', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(wrongEndpoint.status, 404);
});

test('OpenAI Responses stream redaction and split-secret handling', async () => {
  await configureProtocol('openai-responses', ['resp-model-a']);
  const body = { model: 'resp-model-a', input: 'hi', stream: true };
  fake.state.responses.leakText = `leaked ${UPSTREAM_KEY} end`;
  const leaked = await publicFetch('/v1/responses', { apiKey: keyA, body });
  const leakedSse = await leaked.text();
  assert.equal(leakedSse.includes(UPSTREAM_KEY), false);
  assert.match(leakedSse, /\[REDACTED\]/);

  fake.state.responses.leakText = '';
  fake.state.responses.splitSecret = true;
  const split = await publicFetch('/v1/responses', { apiKey: keyA, body });
  const splitSse = await split.text();
  assert.equal(splitSse.includes(UPSTREAM_KEY), false);
  assert.match(splitSse, /\[REDACTED\]/);

  fake.state.responses.splitSecret = false;
  fake.state.responses.splitParts = true;
  const splitNonStream = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'hi' }
  });
  assert.equal(splitNonStream.status, 502);
  assert.equal((await splitNonStream.text()).includes(UPSTREAM_KEY), false);

  fake.state.responses.splitParts = false;
  fake.state.responses.eventNameLeak = true;
  const eventNameLeak = await publicFetch('/v1/responses', { apiKey: keyA, body });
  const eventNameSse = await eventNameLeak.text();
  assert.equal(eventNameSse.includes(UPSTREAM_KEY), false);
  assert.match(eventNameSse, /event: \[REDACTED\]/);
  fake.state.responses.eventNameLeak = false;

  fake.state.responses.crossFieldSplit = true;
  const crossField = await publicFetch('/v1/responses', { apiKey: keyA, body });
  const crossFieldSse = await crossField.text();
  assert.equal(crossFieldSse.includes(UPSTREAM_KEY), false);
  assert.match(crossFieldSse, /event: error/);
  assert.equal(crossFieldSse.includes('response.completed'), false);
});

test('OpenAI Chat passthrough supports create, stream, disabled stored lifecycle, and models', async () => {
  await configureProtocol('openai-chat', ['chat-model-a', 'chat-model-b']);
  const body = {
    model: 'chat-model-a',
    messages: [{ role: 'user', content: 'hello' }],
    max_completion_tokens: 32
  };
  const response = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    headers: { 'openai-beta': 'chat-test' },
    body
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const json = JSON.parse(responseText);
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.choices[0].message.content, 'fake chat text');
  assert.equal(fake.state.requests[0].path, '/v1/chat/completions');
  assert.equal(fake.state.requests[0].body.model, 'chat-model-a');
  assert.equal(fake.state.requests[0].headers.authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(fake.state.requests[0].headers['openai-beta'], 'chat-test');
  assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '99');

  const unknown = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    body: { model: 'unknown', messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(unknown.status, 404);
  assert.equal(fake.state.requests.length, 1);

  const stream = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    body: { ...body, stream: true, stream_options: { include_usage: true } }
  });
  assert.equal(stream.status, 200);
  const sse = await stream.text();
  assert.equal(/^event: /m.test(sse), false);
  assert.match(sse, /"object":"chat.completion.chunk"/);
  assert.match(sse, /"content":"fake chat text"/);
  assert.match(sse, /data: \[DONE\]/);
  const usageChunk = sseData(sse).find((chunk) => chunk.usage && chunk.choices?.length === 0);
  assert.equal(usageChunk.usage.prompt_tokens, 21);

  fake.state.chat.truncate = true;
  const truncated = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  const truncatedSse = await truncated.text();
  assert.match(truncatedSse, /"error"/);
  assert.equal(truncatedSse.includes('data: [DONE]'), false);

  fake.state.chat.truncate = false;
  fake.state.chat.error = true;
  const error = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    body: { ...body, stream: true }
  });
  const errorSse = await error.text();
  assert.match(errorSse, /"error"/);
  assert.equal(errorSse.includes('data: [DONE]'), false);
  assert.equal(errorSse.includes('internal-only'), false);

  fake.state.chat.error = false;
  const created = await publicFetch('/v1/chat/completions', { apiKey: keyA, body });
  const createdJson = await created.json();
  const completionId = createdJson.id;
  assert.equal(created.status, 200);
  assert.ok(completionId);

  // Stored-object lifecycle is intentionally not exposed (cross-key access).
  const retrieved = await publicFetch(`/v1/chat/completions/${completionId}`, {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(retrieved.status, 404);

  const messages = await publicFetch(`/v1/chat/completions/${completionId}/messages?limit=5`, {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(messages.status, 404);

  const updated = await publicFetch(`/v1/chat/completions/${completionId}`, {
    apiKey: keyA,
    body: { metadata: { source: 'test' } }
  });
  assert.equal(updated.status, 404);

  const list = await publicFetch('/v1/chat/completions?limit=5&order=desc', {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(list.status, 405);
  assert.match(list.headers.get('allow'), /POST/);

  const deleted = await publicFetch(`/v1/chat/completions/${completionId}`, {
    apiKey: keyA,
    method: 'DELETE',
    body: null
  });
  assert.equal(deleted.status, 404);

  const models = await publicFetch('/v1/models', { apiKey: keyA, method: 'GET', body: null });
  const modelJson = await models.json();
  assert.equal(modelJson.object, 'list');
  assert.deepEqual(modelJson.data.map((item) => item.id), ['chat-model-a', 'chat-model-b']);

  const wrongEndpoint = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'chat-model-a', input: 'hi' }
  });
  assert.equal(wrongEndpoint.status, 404);
});

test('OpenAI Chat stream redaction and truncation do not fabricate success', async () => {
  await configureProtocol('openai-chat', ['chat-model-a']);
  const body = {
    model: 'chat-model-a',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  };
  fake.state.chat.leakText = `leaked ${UPSTREAM_KEY} end`;
  const leaked = await publicFetch('/v1/chat/completions', { apiKey: keyA, body });
  const leakedSse = await leaked.text();
  assert.equal(leakedSse.includes(UPSTREAM_KEY), false);
  assert.match(leakedSse, /\[REDACTED\]/);

  fake.state.chat.leakText = '';
  fake.state.chat.splitSecret = true;
  const split = await publicFetch('/v1/chat/completions', { apiKey: keyA, body });
  const splitSse = await split.text();
  assert.equal(splitSse.includes(UPSTREAM_KEY), false);
  assert.match(splitSse, /\[REDACTED\]/);

  fake.state.chat.splitSecret = false;
  fake.state.chat.crossFieldSplit = true;
  const crossField = await publicFetch('/v1/chat/completions', { apiKey: keyA, body });
  const crossFieldSse = await crossField.text();
  assert.equal(crossFieldSse.includes(UPSTREAM_KEY), false);
  assert.match(crossFieldSse, /"error"/);
  assert.equal(crossFieldSse.includes('data: [DONE]'), false);
});

test('model retrieval supports IDs containing slashes', async () => {
  await configureProtocol('openai-chat', ['example/model-a']);
  const encoded = await publicFetch('/v1/models/example%2Fmodel-a', {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(encoded.status, 200);
  assert.equal((await encoded.json()).id, 'example/model-a');

  const unencoded = await publicFetch('/v1/models/example/model-a', {
    apiKey: keyA,
    method: 'GET',
    body: null
  });
  assert.equal(unencoded.status, 200);
  assert.equal((await unencoded.json()).id, 'example/model-a');
});

test('switching protocol changes the public endpoint surface and model list shape', async () => {
  await configureProtocol('openai-responses', ['resp-model-a']);
  let state = await adminFetch('/admin/api/state');
  assert.equal(state.json.upstream.protocol, 'openai-responses');
  assert.deepEqual(state.json.upstream.models, ['resp-model-a']);
  let models = await (await publicFetch('/v1/models', { apiKey: keyA, method: 'GET', body: null })).json();
  assert.equal(models.object, 'list');

  const anthropicPath = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'resp-model-a', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(anthropicPath.status, 404);

  await configureProtocol('anthropic', ['fake-model']);
  state = await adminFetch('/admin/api/state');
  assert.equal(state.json.upstream.protocol, 'anthropic');
  models = await (await publicFetch('/v1/models', { apiKey: keyA, method: 'GET', body: null })).json();
  assert.ok(Array.isArray(models.data));
  assert.equal(models.first_id, 'fake-model');

  const responsesPath = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hi' }
  });
  assert.equal(responsesPath.status, 404);

  await configureProtocol('openai-chat', ['chat-model-a']);
  const chatPath = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    body: { model: 'chat-model-a', messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(chatPath.status, 200);
});

test('upstream errors are normalized per protocol and never leak credentials', async () => {
  await configureProtocol('openai-responses', ['resp-model-a']);
  fake.state.failNext = {
    status: 400,
    body: { error: { message: `bad upstream request; auth=${UPSTREAM_KEY}`, type: 'invalid_request_error', param: null, code: 'bad_request' } }
  };
  const responsesError = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'hi' }
  });
  assert.equal(responsesError.status, 400);
  const responsesJson = await responsesError.json();
  assert.equal(responsesJson.error.type, 'invalid_request_error');
  assert.equal(JSON.stringify(responsesJson).includes(UPSTREAM_KEY), false);

  fake.state.failNext = {
    status: 400,
    body: { error: { message: 'up-test-', param: 'secret', type: 'invalid_request_error', code: 'bad_request' } }
  };
  const splitError = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'resp-model-a', input: 'hi' }
  });
  const splitErrorText = await splitError.text();
  assert.equal(splitError.status, 400);
  assert.equal(splitErrorText.includes(UPSTREAM_KEY), false);
  assert.equal(splitErrorText.includes('up-test-'), false);
  assert.equal(splitErrorText.includes('"secret"'), false);

  await configureProtocol('openai-chat', ['chat-model-a']);
  fake.state.failNext = {
    status: 429,
    headers: { 'retry-after': '7' },
    body: { error: { message: 'slow down', type: 'rate_limit_error', param: null, code: 'slow_down' } }
  };
  const chatError = await publicFetch('/v1/chat/completions', {
    apiKey: keyA,
    body: { model: 'chat-model-a', messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(chatError.status, 429);
  assert.equal(chatError.headers.get('retry-after'), '7');
  assert.equal((await chatError.json()).error.code, 'slow_down');

  await configureProtocol('anthropic', ['fake-model']);
  fake.state.failNext = {
    status: 400,
    body: { error: { type: 'invalid_request_error', message: `bad ${UPSTREAM_KEY}` } }
  };
  const anthropicError = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(anthropicError.status, 400);
  const anthropicJson = await anthropicError.json();
  assert.equal(anthropicJson.type, 'error');
  assert.equal(JSON.stringify(anthropicJson).includes(UPSTREAM_KEY), false);

  fake.state.failNext = {
    status: 401,
    body: { error: { message: 'upstream auth failed', type: 'authentication_error' } }
  };
  const upstreamAuth = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(upstreamAuth.status, 502);
  assert.equal((await upstreamAuth.json()).error.type, 'api_error');

  const promptMarker = 'PROMPT_MARKER_9f3c_should_not_be_logged';
  fake.state.failNext = {
    status: 500,
    body: { error: { message: `boom ${promptMarker}` } }
  };
  const upstreamFailure = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: {
      model: 'fake-model',
      max_tokens: 1,
      messages: [{ role: 'user', content: promptMarker }]
    }
  });
  assert.equal(upstreamFailure.status, 502);
  const failureJson = await upstreamFailure.json();
  assert.equal(JSON.stringify(failureJson).includes('boom'), false);
  assert.equal(JSON.stringify(failureJson).includes(promptMarker), false);

  const state = await adminFetch('/admin/api/state');
  assert.equal(state.text.includes(promptMarker), false);
  const accessLog = await fs.readFile(runtime.paths.accessLogFile, 'utf8');
  assert.equal(accessLog.includes(promptMarker), false);
});

test('admin upstream test uses the first model for each protocol', async () => {
  for (const [protocol, models, expectedPath] of [
    ['anthropic', ['fake-model'], '/v1/messages'],
    ['openai-responses', ['resp-model-a'], '/v1/responses'],
    ['openai-chat', ['chat-model-a'], '/v1/chat/completions']
  ]) {
    await configureProtocol(protocol, models);
    const result = await adminFetch('/admin/api/upstream/test', {
      method: 'POST',
      body: {}
    });
    assert.equal(result.response.status, 200, result.text);
    assert.equal(result.json.ok, true, result.text);
    assert.equal(result.json.model, models[0]);
    assert.equal(fake.state.requests.at(-1).path, expectedPath);
    assert.equal(fake.state.requests.at(-1).body.model, models[0]);
  }
});

test('client abort before upstream headers releases the concurrency slot', async () => {
  await configureProtocol('openai-chat', ['chat-model-a']);
  fake.state.delayMs = 800;
  const controller = new AbortController();
  try {
    const request = publicFetch('/v1/chat/completions', {
      apiKey: keyA,
      body: {
        model: 'chat-model-a',
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
    fake.state.delayMs = 0;
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
  await configureProtocol('anthropic', ['fake-model']);
  const previous = runtime.configStore.config.limits.bodyBytes;
  runtime.configStore.config.limits.bodyBytes = 1024;
  try {
    const huge = 'x'.repeat(2000);
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: { model: 'fake-model', max_tokens: 1, messages: [{ role: 'user', content: huge }] }
    });
    assert.equal(response.status, 413);
    const json = await response.json();
    assert.equal(json.error.type, 'request_too_large');
  } finally {
    runtime.configStore.config.limits.bodyBytes = previous;
  }
});

test('public rate limits return 429', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  const previous = runtime.configStore.config.limits.requestsPerMinutePerKey;
  runtime.configStore.config.limits.requestsPerMinutePerKey = 1;
  const generated = await runtime.keyStore.generate({ name: 'rate-limit-test' });
  const body = {
    model: 'fake-model',
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
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
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

test('stored upstream object references are rejected before dispatch', async () => {
  await configureProtocol('openai-responses', ['fake-model']);
  const base = { model: 'fake-model', input: 'hello' };
  const cases = [
    { ...base, prompt: { id: 'pmpt_other' } },
    { ...base, input: [{ type: 'input_file', file_id: 'file_other' }] },
    {
      ...base,
      input: [
        {
          type: 'code_interpreter_call',
          id: 'ci_other',
          code: 'print(1)',
          container_id: 'cntr_other',
          outputs: [],
          status: 'completed'
        }
      ]
    },
    { ...base, tools: [{ type: 'file_search', vector_store_ids: ['vs_other'] }] },
    { ...base, tools: [{ type: 'code_interpreter', container: 'cntr_other' }] }
  ];
  for (const body of cases) {
    const response = await publicFetch('/v1/responses', { apiKey: keyA, body });
    assert.equal(response.status, 400, await response.text());
  }
  assert.equal(fake.state.requests.length, 0);

  await configureProtocol('anthropic', ['fake-model']);
  const fileBodies = [
    {
      model: 'fake-model',
      max_tokens: 8,
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'file', file_id: 'file_other' } }]
        }
      ]
    },
    {
      model: 'fake-model',
      max_tokens: 8,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'content',
                content: [
                  { type: 'image', source: { type: 'file', file_id: 'file_other' } }
                ]
              }
            }
          ]
        }
      ]
    }
  ];
  for (const fileBody of fileBodies) {
    const fileResponse = await publicFetch('/v1/messages', { apiKey: keyA, body: fileBody });
    assert.equal(fileResponse.status, 400, await fileResponse.text());
  }
  assert.equal(fake.state.requests.length, 0);
});

test('Anthropic count_tokens passes through context_management', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  fake.state.countTokensPayload = {
    input_tokens: 2095,
    context_management: { original_input_tokens: 2190 }
  };
  const response = await publicFetch('/v1/messages/count_tokens', {
    apiKey: keyA,
    body: { model: 'fake-model', messages: [{ role: 'user', content: 'count' }] }
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(JSON.parse(text), fake.state.countTokensPayload);
});

test('OpenAI upstream errors expose only normalized error fields', async () => {
  await configureProtocol('openai-responses', ['fake-model']);
  fake.state.failNext = {
    status: 400,
    body: {
      error: {
        message: 'bad request',
        type: 'invalid_request_error',
        param: 'input',
        code: 'bad_input',
        upstream_internal: 'internal-only',
        nested: { note: 'internal-note' }
      }
    }
  };
  const response = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  const text = await response.text();
  assert.equal(response.status, 400, text);
  const json = JSON.parse(text);
  assert.deepEqual(Object.keys(json.error).sort(), ['code', 'message', 'param', 'type']);
  assert.equal(json.error.upstream_internal, undefined);
  assert.equal(json.error.nested, undefined);
  assert.equal(JSON.stringify(json).includes('internal-only'), false);
  assert.equal(JSON.stringify(json).includes('internal-note'), false);
});

test('split upstream keys in error bodies are not returned', async () => {
  await configureProtocol('openai-responses', ['fake-model']);
  const midpoint = Math.ceil(UPSTREAM_KEY.length / 2);
  fake.state.failNext = {
    status: 400,
    body: {
      error: {
        message: `${UPSTREAM_KEY.slice(0, midpoint)} rejected ${UPSTREAM_KEY.slice(midpoint)}`,
        type: 'invalid_request_error'
      }
    }
  };
  const response = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  const text = await response.text();
  assert.equal(response.status, 400, text);
  assert.equal(text.includes(UPSTREAM_KEY.slice(0, midpoint)), false);
  assert.equal(text.includes(UPSTREAM_KEY.slice(midpoint)), false);
  assert.match(text, /unsafe upstream error response/);

  fake.state.failNext = {
    status: 400,
    body: {
      error: {
        message: UPSTREAM_KEY.slice(0, 2),
        param: UPSTREAM_KEY.slice(2),
        type: 'invalid_request_error'
      }
    }
  };
  const shortResponse = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  const shortText = await shortResponse.text();
  assert.equal(shortResponse.status, 400, shortText);
  assert.equal(shortText.includes(UPSTREAM_KEY.slice(2)), false);
  assert.match(shortText, /unsafe upstream error response/);
});

test('Content-Type must be application/json without a prefix match', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  const body = { model: 'fake-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
  const wrong = await publicFetch('/v1/messages', {
    apiKey: keyA,
    headers: { 'content-type': 'application/jsonp' },
    body
  });
  assert.equal(wrong.status, 415, await wrong.text());
  const correct = await publicFetch('/v1/messages', {
    apiKey: keyA,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body
  });
  assert.equal(correct.status, 200, await correct.text());
});

test('OpenAI non-stream requests reject upstream SSE and empty non-JSON bodies', async () => {
  await configureProtocol('openai-responses', ['fake-model']);
  fake.state.responses.forceSse = true;
  const sseResponse = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  assert.equal(sseResponse.status, 502, await sseResponse.text());

  resetFake();
  fake.state.responses.emptyHtml = true;
  const emptyResponse = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  assert.equal(emptyResponse.status, 502, await emptyResponse.text());
});

test('unsupported upstream content encodings map to 502', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  fake.state.failNext = {
    status: 200,
    body: { input_tokens: 1 },
    headers: { 'content-encoding': 'zstd' }
  };
  const count = await publicFetch('/v1/messages/count_tokens', {
    apiKey: keyA,
    body: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(count.status, 502, await count.text());

  await configureProtocol('openai-responses', ['fake-model']);
  fake.state.failNext = {
    status: 200,
    body: { id: 'resp_encoding' },
    headers: { 'content-encoding': 'zstd' }
  };
  const response = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  assert.equal(response.status, 502, await response.text());
});

test('upstream model echoes cannot leak the configured key into logs', async () => {
  await configureProtocol('openai-responses', ['fake-model']);
  fake.state.responses.modelEchoKey = true;
  const response = await publicFetch('/v1/responses', {
    apiKey: keyA,
    body: { model: 'fake-model', input: 'hello' }
  });
  const bodyText = await response.text();
  assert.equal(response.status, 200, bodyText);
  assert.equal(bodyText.includes(UPSTREAM_KEY), false);
  const entries = JSON.stringify(runtime.logStore.entries);
  assert.equal(entries.includes(UPSTREAM_KEY), false);
  assert.equal(entries.includes('"model":"fake-model"'), true);
});

test('Anthropic message_delta cannot leak split upstream keys', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  fake.state.anthropic.splitMessageDelta = true;
  for (const short of [false, true]) {
    fake.state.anthropic.splitMessageDeltaShort = short;
    const response = await publicFetch('/v1/messages', {
      apiKey: keyA,
      body: {
        model: 'fake-model',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }]
      }
    });
    const sse = await response.text();
    assert.equal(response.status, 200, sse);
    const cut = short ? 1 : Math.ceil(UPSTREAM_KEY.length / 2);
    assert.equal(sse.includes(UPSTREAM_KEY), false);
    assert.equal(sse.includes(UPSTREAM_KEY.slice(cut)), false);
    if (!short) assert.equal(sse.includes(UPSTREAM_KEY.slice(0, cut)), false);
    assert.match(sse, /event: error/);
    assert.equal(sse.includes('message_stop'), false);
  }
});

test('upstream body read failures map to 502 and update health state', async () => {
  await configureProtocol('anthropic', ['fake-model']);
  fake.state.abortAfterHeaders = true;
  const response = await publicFetch('/v1/messages', {
    apiKey: keyA,
    body: { model: 'fake-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
  });
  assert.equal(response.status, 502, await response.text());
  const state = await adminFetch('/admin/api/state');
  assert.equal(state.response.status, 200);
  assert.equal(state.json.stats.lastUpstream.ok, false);
  assert.equal(state.json.stats.lastUpstream.status, 502);
});

test('protocol switch rejects an in-flight request instead of mixing paths', async () => {
  await configureProtocol('openai-responses', ['fake-model']);
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    }
  });
  const pending = fetch(`${publicBase}/v1/responses`, {
    method: 'POST',
    headers: { 'x-api-key': keyA, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half'
  });
  controller.enqueue(new TextEncoder().encode('{"model":"fake-model","input":"'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await configureProtocol('anthropic', ['fake-model']);
  controller.enqueue(new TextEncoder().encode('hello"}'));
  controller.close();
  const response = await pending;
  assert.equal(response.status, 409, await response.text());
});
