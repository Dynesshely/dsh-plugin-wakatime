import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createClient, parseRetryAfter, MAX_BATCH_SIZE } from '../lib/client.js';

const API_KEY = 'test-api-key';
const EXPECTED_AUTH = `Basic ${Buffer.from(API_KEY, 'utf8').toString('base64')}`;

/**
 * 启动本地假 WakaTime 服务器（127.0.0.1:0 随机端口），记录请求并把响应交给 handler。
 *
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, index: number) => void} handler
 * @returns {Promise<{ url: string, requests: Array<{ url: string, method: string, headers: Record<string, string>, body: unknown }>, close: () => Promise<void> }>}
 */
async function startServer(handler) {
  /** @type {Array<any>} */
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      handler(req, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 生成 n 条心跳。
 * @param {number} n
 * @returns {Array<{ entity: string, type: string, category: string, time: number }>}
 */
function heartbeats(n) {
  return Array.from({ length: n }, (_, index) => ({
    entity: `/repo/file-${index}.js`,
    type: 'file',
    category: 'ai coding',
    time: 1730000000 + index,
  }));
}

/**
 * 创建指向假服务器的客户端。
 * @param {string} baseUrl
 * @param {Record<string, unknown>} [overrides]
 */
function makeClient(baseUrl, overrides = {}) {
  return createClient({
    apiKey: API_KEY,
    apiUrl: `${baseUrl}/api/v1`,
    userAgent: 'dsh-plugin-wakatime/0.1.0 (test) node/v23',
    timeoutMs: 2000,
    ...overrides,
  });
}

test('parseRetryAfter：秒数、HTTP-date、非法值', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(' 1.5 '), 1500);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('abc'), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter(null), undefined);

  const now = Date.parse('2026-01-01T00:00:00Z');
  const later = new Date(now + 5000).toUTCString();
  assert.equal(parseRetryAfter(later, now), 5000);
  // HTTP-date 已过期 → 0
  assert.equal(parseRetryAfter(new Date(now - 5000).toUTCString(), now), 0);
});

test('单条心跳：POST 单发端点、Basic 认证、UA、Content-Type、X-Machine-Name，body 为对象', async (t) => {
  const server = await startServer((req, res) => res.writeHead(201, { 'Content-Type': 'application/json' }).end('{}'));
  t.after(() => server.close());

  const client = makeClient(server.url, { hostname: 'my-machine' });
  const result = await client.send(heartbeats(1));

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(result.sent, 1);
  assert.equal(server.requests.length, 1);

  const request = server.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/users/current/heartbeats');
  assert.equal(request.headers.authorization, EXPECTED_AUTH);
  assert.equal(request.headers['user-agent'], 'dsh-plugin-wakatime/0.1.0 (test) node/v23');
  assert.match(request.headers['content-type'], /^application\/json/);
  assert.equal(request.headers['x-machine-name'], 'my-machine');
  assert.equal(Array.isArray(request.body), false);
  assert.equal(request.body.entity, '/repo/file-0.js');
});

test('多条心跳：走 .bulk，body 为数组；202 也算成功', async (t) => {
  const server = await startServer((req, res) => res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.send(heartbeats(3));

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.sent, 3);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, '/api/v1/users/current/heartbeats.bulk');
  assert.equal(Array.isArray(server.requests[0].body), true);
  assert.equal(server.requests[0].body.length, 3);
});

test(`批量切分：60 条 → 3 个请求，分别为 ${MAX_BATCH_SIZE}/${MAX_BATCH_SIZE}/10`, async (t) => {
  const server = await startServer((req, res) => res.writeHead(201).end('{}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.send(heartbeats(60));

  assert.equal(result.ok, true);
  assert.equal(result.sent, 60);
  assert.deepEqual(
    server.requests.map((request) => request.body.length),
    [25, 25, 10],
  );
  for (const request of server.requests) {
    assert.equal(request.url, '/api/v1/users/current/heartbeats.bulk');
  }
});

test('单批超过 25 条时 sendBatch 也会切批，不丢数据', async (t) => {
  const server = await startServer((req, res) => res.writeHead(201).end('{}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.sendBatch(heartbeats(30));

  assert.equal(result.ok, true);
  assert.equal(result.sent, 30);
  assert.deepEqual(server.requests.map((request) => request.body.length), [25, 5]);
});

test('空数组：直接成功，不发请求', async (t) => {
  const server = await startServer((req, res) => res.writeHead(201).end('{}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.send([]);

  assert.equal(result.ok, true);
  assert.equal(result.sent, 0);
  assert.equal(server.requests.length, 0);
});

test('400：永久失败（不重试），sent 为 0', async (t) => {
  const server = await startServer((req, res) => res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"bad heartbeat"}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.send(heartbeats(2));

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.permanent, true);
  assert.equal(result.retryable, false);
  assert.equal(result.sent, 0);
  assert.match(result.error, /bad heartbeat/);
});

test('401：永久失败并置 disabledReason，后续请求直接短路不再发 HTTP', async (t) => {
  const server = await startServer((req, res) => res.writeHead(401).end('{"error":"unauthorized"}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  assert.equal(client.disabledReason, undefined);

  const first = await client.send(heartbeats(1));
  assert.equal(first.ok, false);
  assert.equal(first.permanent, true);
  assert.equal(first.sent, 0);
  assert.equal(client.disabledReason, 'unauthorized');
  assert.equal(server.requests.length, 1);

  const second = await client.send(heartbeats(1));
  assert.equal(second.ok, false);
  assert.equal(second.disabledReason, 'unauthorized');
  assert.equal(server.requests.length, 1, '认证失效后不应再发请求');
});

test('429 + Retry-After 秒：可重试且 retryAfterMs 取头值', async (t) => {
  const server = await startServer((req, res) => res.writeHead(429, { 'Retry-After': '3' }).end('{"error":"rate limited"}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.send(heartbeats(2));

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.retryable, true);
  assert.equal(result.permanent, false);
  assert.equal(result.retryAfterMs, 3000);
});

test('429 + Retry-After HTTP-date：换算为毫秒等待时间', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(429, { 'Retry-After': new Date(Date.now() + 5000).toUTCString() }).end('{}');
  });
  t.after(() => server.close());

  const client = makeClient(server.url);
  const result = await client.send(heartbeats(1));

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.ok(result.retryAfterMs > 0 && result.retryAfterMs <= 5000, `retryAfterMs=${result.retryAfterMs}`);
});

test('500：可重试，无 Retry-After 时给出正的指数退避', async (t) => {
  const server = await startServer((req, res) => res.writeHead(500).end('{"error":"boom"}'));
  t.after(() => server.close());

  const client = makeClient(server.url);
  const first = await client.send(heartbeats(1));
  const second = await client.send(heartbeats(1));

  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.equal(first.permanent, false);
  assert.ok(first.retryAfterMs > 0);
  assert.ok(second.retryAfterMs >= first.retryAfterMs, '连续失败应指数退避');
  assert.match(first.error, /boom/);
});

test('网络错误：转为可重试返回值，不抛异常', async () => {
  // 端口 1 基本不可能有服务在监听
  const client = createClient({ apiKey: API_KEY, apiUrl: 'http://127.0.0.1:1/api/v1', timeoutMs: 1000 });
  const result = await client.send(heartbeats(1));

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.retryable, true);
  assert.ok(result.retryAfterMs > 0);
  assert.equal(typeof result.error, 'string');
});

test('fetchImpl 同步抛错：也被转成返回值', async () => {
  const client = createClient({
    apiKey: API_KEY,
    fetchImpl: () => {
      throw new Error('boom-fetch');
    },
  });
  const result = await client.send(heartbeats(1));

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.error, /boom-fetch/);
});

test('超时：AbortSignal.timeout 生效，返回 timeout 错误', async (t) => {
  const server = await startServer((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(201).end('{}');
      } catch {
        // 连接已被超时中断
      }
    }, 400);
  });
  t.after(() => server.close());

  const client = makeClient(server.url, { timeoutMs: 50 });
  const startedAt = Date.now();
  const result = await client.send(heartbeats(1));
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.retryable, true);
  assert.match(result.error, /timeout after 50ms/);
  assert.ok(elapsed < 400, `应在超时时间附近返回，实际 ${elapsed}ms`);
});

test('缺少 apiKey：直接永久失败，不发请求', async (t) => {
  const server = await startServer((req, res) => res.writeHead(201).end('{}'));
  t.after(() => server.close());

  const client = makeClient(server.url, { apiKey: '' });
  const result = await client.send(heartbeats(1));

  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
  assert.equal(result.sent, 0);
  assert.match(result.error, /missing api_key/);
  assert.equal(server.requests.length, 0);
});

test('代理不可用（无 undici）时降级直连并只告警一次', async (t) => {
  const undiciAvailable = await import('undici').then(
    () => true,
    () => false,
  );
  if (undiciAvailable) {
    t.skip('本机可 import undici，ProxyAgent 行为另测，跳过降级路径');
    return;
  }

  const server = await startServer((req, res) => res.writeHead(201).end('{}'));
  t.after(() => server.close());

  const warnings = [];
  const client = makeClient(server.url, { proxy: 'http://127.0.0.1:9', logger: { warn: (msg) => warnings.push(msg) } });

  const first = await client.send(heartbeats(1));
  const second = await client.send(heartbeats(1));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(server.requests.length, 2, '代理不可用时应直连并正常工作');
  assert.equal(warnings.length, 1, '降级告警只应出现一次');
  assert.match(warnings[0], /降级为直连/);
});
