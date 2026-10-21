/**
 * 代理冒烟测试：用假的 Open WebUI 上游验证转发语义（不联网、不碰真令牌）。
 *
 *   node test/proxy-smoke.mjs
 *
 * 覆盖：本地鉴权、模型列表与缓存、developer→system、max_completion_tokens→max_tokens、
 * 5xx 退避重试、SSE 原样透传、401 → 重新登录 → 仍失败时的错误形状、/health。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { HainnuProxy } from '../lib/proxy.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
const seen = [];
let chatCalls = 0;
let failFirstChat = false;
let force401 = false;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/models') {
    seen.push({ path: url.pathname, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'other-model' }] }));
    return;
  }
  if (url.pathname === '/api/chat/completions') {
    chatCalls += 1;
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = { parseError: true };
    }
    seen.push({ path: url.pathname, authorization: req.headers.authorization, accept: req.headers.accept, body });
    if (force401) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'unauthorized' }));
      return;
    }
    if (failFirstChat && chatCalls === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Server Connection Error' }));
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 1 },
    }));
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

function fetchJson(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options || {}, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (options && options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

function postJson(url, value, headers) {
  const body = JSON.stringify(value);
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(headers || {}) },
    body,
  });
}

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

/** 让系统分配一个空闲端口（避免和本机其它代理实例撞端口）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const results = [];
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(['PASS', label]);
    })
    .catch((error) => {
      results.push(['FAIL', `${label} :: ${error.message}`]);
    });
}

async function main() {
  const upstreamPort = await freePort();
  let requestedPort = await freePort();
  while (requestedPort === upstreamPort) requestedPort = await freePort();
  await listen(upstream, upstreamPort);
  const proxy = new HainnuProxy({
    host: '127.0.0.1',
    port: requestedPort,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    modelId: 'deepseek-flash',
    acceptKeys: ['sk-test'],
    getToken: () => JWT,
    relogin: () => JWT,
    retries: 3,
    rateLimitCooldownMs: 20,
    modelCacheMs: 60000,
  });
  const status = await proxy.start();
  assert.equal(status.mode, 'running');
  // 以实际绑定端口为准（start() 可能在端口被抢时顺延）
  const proxyPort = status.port;
  const base = `http://127.0.0.1:${proxyPort}`;

  await check('坏 Key 被拒（401 bad local api key）', async () => {
    const r = await fetchJson(`${base}/v1/models`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.message, 'bad local api key');
  });

  await check('模型列表透出上游两个模型', async () => {
    const r = await fetchJson(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-test' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.map((m) => m.id).sort(), ['deepseek-flash', 'other-model']);
    assert.equal(r.json.object, 'list');
  });

  await check('上游 /api/models 带 Bearer 学校令牌', async () => {
    const modelsCall = seen.find((entry) => entry.path === '/api/models');
    assert.equal(modelsCall.authorization, `Bearer ${JWT}`);
  });

  await check('developer→system 且 max_completion_tokens→max_tokens', async () => {
    const r = await postJson(`${base}/v1/chat/completions`, {
      model: 'deepseek-flash',
      messages: [
        { role: 'developer', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      max_completion_tokens: 1234,
      stream: false,
    }, { authorization: 'Bearer sk-test' });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'ok');
    const call = seen.filter((entry) => entry.path === '/api/chat/completions').at(-1);
    assert.equal(call.body.messages[0].role, 'system');
    assert.equal(call.body.max_tokens, 1234);
    assert.equal('max_completion_tokens' in call.body, false);
    assert.equal(call.body.model, 'deepseek-flash');
    assert.equal(call.authorization, `Bearer ${JWT}`);
    assert.equal(call.accept, 'application/json, text/event-stream');
  });

  await check('未知名模型被解析到已知模型', async () => {
    const r = await postJson(`${base}/v1/chat/completions`, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, { authorization: 'Bearer sk-test' });
    assert.equal(r.status, 200);
    const call = seen.filter((entry) => entry.path === '/api/chat/completions').at(-1);
    assert.equal(call.body.model, 'deepseek-flash');
  });

  await check('SSE 流原样透传且不丢字节', async () => {
    const r = await postJson(`${base}/v1/chat/completions`, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, { authorization: 'Bearer sk-test' });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /text\/event-stream/);
    assert.equal(r.text, 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  });

  await check('上游 500 会退避重试并最终成功', async () => {
    failFirstChat = true;
    chatCalls = 0;
    const r = await postJson(`${base}/v1/chat/completions`, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, { authorization: 'Bearer sk-test' });
    failFirstChat = false;
    assert.equal(r.status, 200);
    assert.equal(chatCalls, 2);
  });

  await check('上游 401 转成「令牌失效，请重新登录」', async () => {
    force401 = true;
    const r = await postJson(`${base}/v1/chat/completions`, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, { authorization: 'Bearer sk-test' });
    force401 = false;
    assert.equal(r.status, 401);
    assert.equal(r.json.error.type, 'auth_expired');
    assert.match(r.json.error.message, /重新登录/);
  });

  await check('/health 形状与旧项目兼容并带插件标记', async () => {
    const r = await fetchJson(`${base}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.default_model, 'deepseek-flash');
    assert.ok(Array.isArray(r.json.models));
    assert.equal(r.json.plugin.name, 'dsh-hainnu');
    assert.equal(r.json.plugin.mode, 'running');
  });

  await check('未知路径 404', async () => {
    const r = await fetchJson(`${base}/nope`, { headers: { authorization: 'Bearer sk-test' } });
    assert.equal(r.status, 404);
  });

  await check('外部实例占端口时进入 adopted 而不是报错', async () => {
    const second = new HainnuProxy({
      host: '127.0.0.1',
      port: proxyPort,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      modelId: 'deepseek-flash',
      acceptKeys: ['sk-test'],
      getToken: () => JWT,
      relogin: () => JWT,
    });
    const adopted = await second.start();
    assert.equal(adopted.mode, 'adopted');
    assert.equal(adopted.port, proxyPort);
    await second.stop();
  });

  await proxy.stop();
  await new Promise((resolve) => upstream.close(resolve));

  let failed = 0;
  for (const [kind, label] of results) {
    if (kind === 'FAIL') failed += 1;
    console.log(`${kind === 'PASS' ? '  ok ' : 'FAIL '} ${label}`);
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试脚本自身出错：', error);
  process.exit(2);
});
