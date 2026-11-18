import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths, PROJECT_ROOT, resolveDataDir } from '../src/paths.js';
import { SecretBox } from '../src/secrets.js';
import { KeyStore, generateApiKey, isValidApiKeyShape } from '../src/keys.js';
import {
  CONFIG_VERSION,
  ConfigStore,
  MAX_UPSTREAM_MODELS
} from '../src/config.js';
import {
  AppError,
  ByteBudget,
  CrossFieldSecretGuard,
  assertNoSplitSecret,
  buildUpstreamUrl,
  createBodyLease,
  redactKnownSecret,
  redactSecrets,
  sanitizeForLog,
  scrubSecretsDeep,
  validateBaseUrl
} from '../src/util.js';
import {
  assertModelAllowed,
  requestModel,
  syntheticModel,
  syntheticModelList
} from '../src/upstream/models.js';
import { SSEParser } from '../src/upstream/sse.js';
import { guardErrorBody } from '../src/upstream/common.js';
import { SlidingWindowLimiter } from '../src/rate-limit.js';
import { ensureDirPrivate } from '../src/storage.js';

async function tempPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veillink-test-'));
  const dataDir = path.join(root, 'data');
  await ensureDirPrivate(dataDir);
  return { root, dataDir, paths: createPaths(dataDir) };
}

test('API key generation uses sk- plus exactly 56 allowed characters', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const key = generateApiKey();
    assert.match(key, /^sk-[A-Za-z0-9@#%&]{56}$/);
    assert.equal(key.length, 59);
    assert.equal(isValidApiKeyShape(key), true);
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
  assert.equal(isValidApiKeyShape('sk-short'), false);
  assert.equal(isValidApiKeyShape(`sk-${'A'.repeat(24)}`), false);
  assert.equal(isValidApiKeyShape(`sk-${'A'.repeat(56)}!`), false);
});

test('URL normalization and joining avoid duplicated /v1', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(validateBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:8080/v1', '/v1/messages', '?beta=true').toString(),
    'http://127.0.0.1:8080/v1/messages?beta=true'
  );
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:8080/anthropic', '/v1/messages').toString(),
    'http://127.0.0.1:8080/anthropic/v1/messages'
  );
  assert.equal(
    buildUpstreamUrl('http://127.0.0.1:8080/v1', '/v1/responses/compact').toString(),
    'http://127.0.0.1:8080/v1/responses/compact'
  );
  assert.throws(() => validateBaseUrl('ftp://example.com'));
  assert.throws(() => validateBaseUrl('http://example.com'));
  assert.doesNotThrow(() => validateBaseUrl('http://127.0.0.1:11434'));
  assert.throws(() => validateBaseUrl('https://user:pass@example.com'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/messages'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/messages/count_tokens'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/responses'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/responses/compact'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/chat/completions'));
  assert.throws(() => validateBaseUrl('https://example.com/v1/chat/completions/abc'));
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
  const symbolKey = `sk-${'A'.repeat(55)}&`;
  assert.equal(redactSecrets(`x ${symbolKey} tail`), 'x sk-[REDACTED] tail');
  for (const prefix of ['-', '@', '#', '%', '&', '_']) {
    assert.equal(redactSecrets(`${prefix}sk-${'A'.repeat(56)}`), `${prefix}sk-[REDACTED]`);
  }
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
    const generated = await store.generate({ name: 'phone', allowedDevice: 'TEST-DEVICE' });
    assert.equal(isValidApiKeyShape(generated.key), true);
    assert.equal(store.authenticate(generated.key).ok, true);
    assert.equal(store.deviceAllowed(generated.record, 'test-device'), true);
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

test('KeyStore upgrades version 1 records to an empty version 2 store', async () => {
  const { root, paths } = await tempPaths();
  let store;
  try {
    const legacy = {
      version: 1,
      keys: [
        {
          id: 'key_legacy00000000',
          index: 'legacy-index',
          secretEnc: { v: 1, iv: 'legacy', tag: 'legacy', data: 'legacy' },
          createdAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null
        }
      ]
    };
    await fs.writeFile(paths.keysFile, JSON.stringify(legacy), 'utf8');
    store = await KeyStore.load(paths, await SecretBox.load(paths));
    assert.equal(store.size, 0);
    assert.deepEqual(store.list(), []);
    const disk = JSON.parse(await fs.readFile(paths.keysFile, 'utf8'));
    assert.equal(disk.version, 2);
    assert.deepEqual(disk.keys, []);

    const generated = await store.generate({ name: 'after-upgrade' });
    assert.equal(store.authenticate(generated.key).ok, true);
    await store.close();
    store = null;
    const reloaded = await KeyStore.load(paths, await SecretBox.load(paths));
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.authenticate(generated.key).ok, true);
    await reloaded.close();
  } finally {
    await store?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KeyStore deletes only revoked records and removes key material', async () => {
  const { root, paths } = await tempPaths();
  let store;
  try {
    store = await KeyStore.load(paths, await SecretBox.load(paths));
    const keep = await store.generate({ name: 'keep-active' });
    const generated = await store.generate({ name: 'delete-me' });

    await assert.rejects(
      () => store.remove(generated.record.id),
      (error) => error instanceof AppError && error.status === 409
    );
    assert.equal(store.authenticate(generated.key).ok, true);
    assert.equal(store.activeCount(), 2);

    await store.revoke(generated.record.id);
    const removed = await store.remove(generated.record.id);
    assert.equal(removed.id, generated.record.id);
    assert.equal(removed.name, 'delete-me');
    assert.equal(store.safe(generated.record.id), null);
    assert.equal(store.list().some((record) => record.id === generated.record.id), false);
    assert.equal(store.activeCount(), 1);
    assert.equal(store.authenticate(generated.key).ok, false);
    assert.equal(store.authenticate(keep.key).ok, true);
    await assert.rejects(
      () => store.reveal(generated.record.id),
      (error) => error instanceof AppError && error.status === 404
    );
    await assert.rejects(
      () => store.remove(generated.record.id),
      (error) => error instanceof AppError && error.status === 404
    );

    const disk = await fs.readFile(paths.keysFile, 'utf8');
    assert.equal(disk.includes(generated.key), false);
    assert.equal(disk.includes(generated.record.id), false);
    const persisted = JSON.parse(disk);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.keys.length, 1);
    await store.close();
    store = null;

    const reloaded = await KeyStore.load(paths, await SecretBox.load(paths));
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.authenticate(generated.key).ok, false);
    assert.equal(reloaded.authenticate(keep.key).ok, true);
    await reloaded.close();
  } finally {
    await store?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KeyStore deleting an unreadable revoked record clears its warning count', async () => {
  const { root, paths } = await tempPaths();
  let store;
  try {
    const broken = {
      version: 2,
      keys: [
        {
          id: 'key_broken00000000',
          index: 'broken-index',
          secretEnc: { v: 1, iv: 'bad', tag: 'bad', data: 'bad' },
          createdAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null
        }
      ]
    };
    await fs.writeFile(paths.keysFile, JSON.stringify(broken), 'utf8');
    store = await KeyStore.load(paths, await SecretBox.load(paths));
    assert.equal(store.unreadableCount, 1);
    assert.equal(store.activeCount(), 1);
    await store.revoke('key_broken00000000');
    await store.remove('key_broken00000000');
    assert.equal(store.unreadableCount, 0);
    assert.equal(store.size, 0);
  } finally {
    await store?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('KeyStore delete rolls back the record when persistence fails', async () => {
  const { root, paths } = await tempPaths();
  let store;
  try {
    store = await KeyStore.load(paths, await SecretBox.load(paths));
    const generated = await store.generate({ name: 'rollback-delete' });
    await store.revoke(generated.record.id);
    const originalPersist = store.persist.bind(store);
    store.persist = async () => {
      throw new Error('disk full');
    };
    await assert.rejects(() => store.remove(generated.record.id), /disk full/);
    store.persist = originalPersist;
    assert.equal(store.safe(generated.record.id).id, generated.record.id);
    assert.equal(store.authenticate(generated.key).reason, 'revoked');
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
    assert.equal(store.config.version, CONFIG_VERSION);
    assert.deepEqual(store.config.upstream.models, []);
    const upstreamSecret = 'upstream-secret-value';
    const snapshot = await store.update({
      upstream: {
        baseUrl: 'http://127.0.0.1:9999/v1',
        protocol: 'openai-responses',
        authMode: 'bearer',
        models: ['model-a', 'model-b'],
        apiKey: upstreamSecret
      },
      public: { baseUrl: 'https://api.example.com' }
    });
    assert.equal(snapshot.baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(snapshot.protocol, 'openai-responses');
    assert.deepEqual(snapshot.models, ['model-a', 'model-b']);
    assert.equal(snapshot.hasApiKey, true);
    assert.equal(store.runtimeUpstream().apiKey, upstreamSecret);
    assert.equal(store.runtimeUpstream().authMode, 'bearer');
    assert.equal(JSON.stringify(snapshot).includes(upstreamSecret), false);
    const disk = await fs.readFile(paths.configFile, 'utf8');
    assert.equal(disk.includes(upstreamSecret), false);
    const reloaded = await ConfigStore.load(paths, await SecretBox.load(paths));
    assert.equal(reloaded.runtimeUpstream().apiKey, upstreamSecret);
    assert.deepEqual(reloaded.runtimeUpstream().models, ['model-a', 'model-b']);
    await reloaded.update({ upstream: { apiKey: '' } });
    assert.equal(reloaded.runtimeUpstream().apiKey, upstreamSecret);
    await reloaded.update({ upstream: { apiKey: 'replacement-secret' }, clearApiKey: true });
    assert.equal(reloaded.runtimeUpstream().apiKey, 'replacement-secret');
    await assert.rejects(() => store.update({ public: { baseUrl: 'http://insecure.example' } }), AppError);
    await store.update({ clearApiKey: true, upstream: {} });
    assert.equal(store.runtimeUpstream().apiKey, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ConfigStore validates model count, duplicates, and empty lists', async () => {
  const { root, paths } = await tempPaths();
  try {
    const store = await ConfigStore.load(paths, await SecretBox.load(paths));
    const base = { baseUrl: 'http://127.0.0.1:9999', protocol: 'openai-chat' };
    await assert.rejects(
      () =>
        store.update({
          upstream: {
            ...base,
            models: ['a', 'b', 'c', 'd', 'e', 'f']
          }
        }),
      (error) => error instanceof AppError && /At most/.test(error.message)
    );
    await assert.rejects(
      () => store.update({ upstream: { ...base, models: ['a', 'a'] } }),
      (error) => error instanceof AppError && /Duplicate/.test(error.message)
    );
    await assert.rejects(
      () => store.update({ upstream: { ...base, models: [] } }),
      (error) => error instanceof AppError && /At least one/.test(error.message)
    );
    const ok = await store.update({
      upstream: { ...base, models: ['a', 'b', 'c', 'd', 'e'] }
    });
    assert.equal(ok.models.length, MAX_UPSTREAM_MODELS);
    const legacy = await store.update({
      upstream: { baseUrl: base.baseUrl, protocol: 'anthropic', model: 'legacy-model' }
    });
    assert.deepEqual(legacy.models, ['legacy-model']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ConfigStore migrates version 1 openai/model config to version 2 models', async () => {
  const { root, paths } = await tempPaths();
  try {
    const legacy = {
      version: 1,
      upstream: {
        baseUrl: 'http://127.0.0.1:9999',
        protocol: 'openai',
        authMode: 'auto',
        apiKeyEnc: null,
        model: 'legacy-model',
        timeoutMs: 300000
      },
      public: { baseUrl: '' },
      limits: {}
    };
    await fs.writeFile(paths.configFile, JSON.stringify(legacy), 'utf8');
    const store = await ConfigStore.load(paths, await SecretBox.load(paths));
    assert.equal(store.config.version, CONFIG_VERSION);
    assert.equal(store.config.upstream.protocol, 'openai-chat');
    assert.deepEqual(store.config.upstream.models, ['legacy-model']);
    assert.equal('model' in store.config.upstream, false);
    const rewritten = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    assert.equal(rewritten.version, CONFIG_VERSION);
    assert.equal(rewritten.upstream.protocol, 'openai-chat');
    assert.deepEqual(rewritten.upstream.models, ['legacy-model']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ConfigStore persists runtime normalization of an existing v2 config', async () => {
  const { root, paths } = await tempPaths();
  try {
    const raw = {
      version: 2,
      upstream: {
        baseUrl: 'http://192.0.2.10:9999',
        protocol: 'openai-responses',
        authMode: 'auto',
        apiKeyEnc: null,
        models: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        timeoutMs: 300000
      },
      public: { baseUrl: '' },
      limits: {}
    };
    await fs.writeFile(paths.configFile, JSON.stringify(raw), 'utf8');
    const store = await ConfigStore.load(paths, await SecretBox.load(paths));
    assert.equal(store.config.upstream.baseUrl, '');
    assert.deepEqual(store.config.upstream.models, ['a', 'b', 'c', 'd', 'e']);
    const rewritten = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
    assert.equal(rewritten.upstream.baseUrl, '');
    assert.deepEqual(rewritten.upstream.models, ['a', 'b', 'c', 'd', 'e']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('guardErrorBody rejects split credentials in parsed and plain-text errors', () => {
  const secret = 'upstream-secret-value';
  const parsed = guardErrorBody(
    { parsed: { error: { message: 'upstream-', param: 'secret-value' } }, text: 'upstream- secret-value' },
    secret
  );
  assert.equal(parsed.parsed, null);
  assert.match(parsed.text, /unsafe upstream error response/);

  const plain = guardErrorBody(
    { parsed: null, text: `prefix ${secret.slice(0, 9)} gap ${secret.slice(9)}` },
    secret
  );
  assert.equal(plain.parsed, null);
  assert.match(plain.text, /unsafe upstream error response/);
});

test('synthetic model lists match Anthropic and OpenAI shapes', () => {
  assert.deepEqual(syntheticModelList('anthropic', []), {
    data: [],
    has_more: false,
    first_id: null,
    last_id: null
  });
  const anthropic = syntheticModelList('anthropic', ['model-a', 'model-b']);
  assert.equal(anthropic.data.length, 2);
  assert.equal(anthropic.data[0].type, 'model');
  assert.equal(anthropic.data[0].id, 'model-a');
  assert.equal(anthropic.first_id, 'model-a');
  assert.equal(anthropic.last_id, 'model-b');
  assert.equal(anthropic.has_more, false);

  const openai = syntheticModelList('openai-chat', ['model-a', 'model-b']);
  assert.deepEqual(Object.keys(openai), ['object', 'data']);
  assert.equal(openai.object, 'list');
  assert.equal(openai.data[0].object, 'model');
  assert.equal(openai.data[0].id, 'model-a');
  assert.equal(openai.data[0].owned_by, 'veillink');
  assert.equal(openai.data[0].created, 1767225600);

  assert.equal(syntheticModel('anthropic', 'model-a', ['model-a']).id, 'model-a');
  assert.equal(syntheticModel('openai-responses', 'missing', ['model-a']), null);
});

test('model allow-list rejects missing and unknown models', () => {
  assert.equal(requestModel({ model: 'model-a' }), 'model-a');
  assert.throws(
    () => assertModelAllowed('', ['model-a']),
    (error) => error instanceof AppError && error.status === 400
  );
  assert.throws(
    () => assertModelAllowed('missing', ['model-a']),
    (error) => error instanceof AppError && error.status === 404
  );
  assert.throws(
    () => assertModelAllowed(' model-a ', ['model-a']),
    (error) => error instanceof AppError && error.status === 404
  );
  assert.throws(
    () => assertModelAllowed('missing', ['model-a'], 'openai-chat'),
    (error) =>
      error instanceof AppError &&
      error.status === 404 &&
      error.type === 'invalid_request_error' &&
      error.code === 'model_not_found' &&
      error.param === 'model'
  );
  assert.doesNotThrow(() => assertModelAllowed('model-a', ['model-a']));
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

test('SSE parser discards an unterminated final event at EOF', () => {
  const events = [];
  const parser = new SSEParser((event) => events.push(event));
  parser.push(Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n'));
  parser.finish();
  assert.equal(events.length, 0);
  parser.push(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n'));
  parser.finish();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ping');
});

test('split-secret detection traverses Responses and Chat fields', () => {
  const secret = 'upstream-secret-value';
  assert.throws(
    () =>
      assertNoSplitSecret(
        {
          output: [
            {
              content: [
                { type: 'output_text', text: 'upstream-' },
                { type: 'output_text', text: 'secret-value' }
              ]
            }
          ]
        },
        secret
      ),
    AppError
  );
  assert.throws(
    () =>
      assertNoSplitSecret(
        {
          choices: [
            {
              message: {
                content: 'upstream-',
                refusal: 'secret-value'
              }
            }
          ]
        },
        secret
      ),
    AppError
  );
  assert.throws(
    () => assertNoSplitSecret({ a: secret.slice(0, 1), b: secret.slice(1) }, secret),
    AppError
  );
  assert.throws(
    () => assertNoSplitSecret({ a: secret.slice(0, 2), b: secret.slice(2) }, secret),
    AppError
  );
  assert.doesNotThrow(() =>
    assertNoSplitSecret({ output_text: secret }, secret)
  );
  assert.throws(
    () =>
      assertNoSplitSecret(
        { message: 'secret-value', param: 'upstream-' },
        secret
      ),
    AppError
  );
  assert.throws(
    () =>
      assertNoSplitSecret(
        {
          arguments: '{"a":"upstream-"}',
          message: '{"b":"secret-value"}'
        },
        secret
      ),
    AppError
  );

  const guard = new CrossFieldSecretGuard([secret]);
  assert.doesNotThrow(() => guard.pushText('upstream-'));
  assert.throws(() => guard.pushText('secret-value'), AppError);
  const reverseGuard = new CrossFieldSecretGuard([secret]);
  assert.doesNotThrow(() => reverseGuard.pushText('secret-value'));
  assert.throws(() => reverseGuard.pushText('upstream-'), AppError);

  const separatedGuard = new CrossFieldSecretGuard([secret]);
  assert.doesNotThrow(() => separatedGuard.pushText('upstream-hello'));
  assert.throws(() => separatedGuard.pushText('secret-value'), AppError);

  const jsonGuard = new CrossFieldSecretGuard([secret]);
  assert.doesNotThrow(() => jsonGuard.pushText('{"a":"upstream-"}'));
  assert.throws(() => jsonGuard.pushText('{"b":"secret-value"}'), AppError);

  const largeGuard = new CrossFieldSecretGuard([secret]);
  assert.throws(
    () => largeGuard.pushText(`upstream-${'Z'.repeat(20000)}secret-value`),
    AppError
  );

  const threePartGuard = new CrossFieldSecretGuard([secret]);
  assert.doesNotThrow(() => threePartGuard.pushText('{"a":"upstream"}'));
  assert.doesNotThrow(() => threePartGuard.pushText('{"b":"-secret"}'));
  assert.throws(() => threePartGuard.pushText('{"c":"-value"}'), AppError);

  const shortFragmentGuard = new CrossFieldSecretGuard(['up-test-secret']);
  assert.doesNotThrow(() => shortFragmentGuard.pushText('up-'));
  assert.doesNotThrow(() => shortFragmentGuard.pushText('hello'));
  assert.doesNotThrow(() => shortFragmentGuard.pushText('test'));
  assert.doesNotThrow(() => shortFragmentGuard.pushText('filler'));
  assert.throws(() => shortFragmentGuard.pushText('-secret'), AppError);

  assert.throws(
    () =>
      assertNoSplitSecret(
        {
          a: 'up-',
          b: 'hello',
          c: 'test',
          d: 'filler',
          e: '-secret'
        },
        'up-test-secret'
      ),
    AppError
  );

  assert.throws(
    () =>
      assertNoSplitSecret(
        { 'upstream-': true, 'secret-value': true },
        secret
      ),
    AppError
  );

  const projectKey = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx';
  const ordinary = scrubSecretsDeep(
    { model: 'proj', text: 'proj', other: 'test' },
    [projectKey]
  );
  assert.equal(ordinary.model, 'proj');
  assert.equal(ordinary.text, 'proj');
  assert.equal(ordinary.other, 'test');
  const ordinaryGuard = new CrossFieldSecretGuard([projectKey]);
  assert.doesNotThrow(() => ordinaryGuard.pushText('proj'));
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
