/**
 * 登录链离线测试：假 CAS + 假 Open WebUI，验证
 *   1) 页面正文里长得像 JWT 的字符串不会被当成令牌（真实踩过的坑）
 *   2) 形状正确但学校不认的 token Cookie 也不会被当成登录成功
 *   3) 密码错误 → bad_credentials；账号锁定 → locked
 *   4) 正常流程能从 302 链里拿到 cookie 令牌并通过 /api/v1/auths/ 校验
 *
 *   node test/login-smoke.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { login, LoginError, parseLoginForm } from '../lib/login.js';

const GOOD_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0IiwibmFtZSI6IuW8oOS4iSIsImV4cCI6NDA3MDkwODgwMH0.c2ln';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjp0cnVlfQ.bm90LWEtdG9rZW4';
const EXECUTION = 'e1s1';

let mode = 'success';
let lastPost = '';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // Open WebUI 侧：登录入口 → CAS
  if (path === '/oauth/github/login') {
    res.writeHead(307, { location: `/cas/oauth2.0/authorize?client_id=x`, 'set-cookie': 'oui-session=abc; Path=/' });
    res.end();
    return;
  }
  if (path === '/cas/oauth2.0/authorize') {
    res.writeHead(302, { location: `/cas/login?service=cb`, 'set-cookie': 'JSESSIONID=s1; Path=/' });
    res.end();
    return;
  }
  if (path === '/cas/login' && req.method === 'GET') {
    // 故意在正文里塞一个 JWT 形状的字符串（真实登录页里就有类似物）
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body>
      <script>window.__CONFIG__ = {"token":"${FAKE_JWT}"}</script>
      <form method="post" action="/cas/login?service=cb">
        <input type="hidden" name="execution" value="${EXECUTION}">
        <input type="hidden" name="_eventId" value="">
        <input type="hidden" name="geolocation" value="">
        <input name="username"><input type="password" name="password">
      </form></body></html>`);
    return;
  }
  if (path === '/cas/login' && req.method === 'POST') {
    lastPost = await readBody(req);
    const params = new URLSearchParams(lastPost);
    if (params.get('execution') !== EXECUTION) {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<html>登录已过期</html>');
      return;
    }
    if (mode === 'locked') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>账号已被锁定，请稍后再试</body></html>');
      return;
    }
    if (params.get('password') !== 'right-pw') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>用户名或密码错误，请尝试。用户名或密码错误，超过5次将被锁定</body></html>');
      return;
    }
    if (mode === 'bogus-cookie') {
      // 形状对、但学校不认的令牌
      res.writeHead(302, { location: '/oauth/github/callback?code=c1', 'set-cookie': `token=${FAKE_JWT}; Path=/` });
      res.end();
      return;
    }
    res.writeHead(302, { location: '/cas/oauth2.0/callbackAuthorize?code=c1' });
    res.end();
    return;
  }
  if (path === '/cas/oauth2.0/callbackAuthorize') {
    res.writeHead(302, { location: '/oauth/github/callback?code=c1' });
    res.end();
    return;
  }
  if (path === '/oauth/github/callback') {
    // bogus-cookie 模式下最后一跳也只发形状正确但学校不认的令牌
    const value = mode === 'bogus-cookie' ? FAKE_JWT : GOOD_JWT;
    res.writeHead(302, { location: '/', 'set-cookie': `token=${value}; Path=/; HttpOnly` });
    res.end();
    return;
  }
  if (path === '/api/v1/auths/') {
    const auth = String(req.headers.authorization || '');
    if (auth === `Bearer ${GOOD_JWT}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: '张同学', email: 's@x', role: 'user' }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"detail":"unauthorized"}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html>ok</html>');
});

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push(['PASS', label]);
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error.message}`]);
  }
}

async function main() {
  await new Promise((resolve) => server.listen(18790, '127.0.0.1', resolve));
  const site = 'http://127.0.0.1:18790';

  await check('解析登录页隐藏字段 execution', () => {
    const form = parseLoginForm(`<form action="/cas/login?service=cb" method="post">
      <input type="hidden" name="execution" value="${EXECUTION}">
      <input name="username"><input type="password" name="password"></form>`);
    assert.equal(form.fields.execution, EXECUTION);
    assert.equal(form.action, '/cas/login?service=cb');
  });

  await check('正确密码能走完整条链并拿到已验证令牌', async () => {
    mode = 'success';
    const result = await login({ username: '20230001', password: 'right-pw', site });
    assert.equal(result.token, GOOD_JWT);
    assert.equal(result.displayName, '张同学');
    assert.equal(result.reusedSession, false);
    assert.ok(result.chain.length >= 4, 'chain 太短: ' + result.chain.length);
  });

  await check('提交的表单带 username/password/execution/_eventId', () => {
    const params = new URLSearchParams(lastPost);
    assert.equal(params.get('username'), '20230001');
    assert.equal(params.get('password'), 'right-pw');
    assert.equal(params.get('execution'), EXECUTION);
    assert.equal(params.get('_eventId'), 'submit');
    assert.equal(params.get('geolocation'), '');
  });

  await check('密码错误 → bad_credentials（不会把正文里的假 JWT 当令牌）', async () => {
    mode = 'success';
    await assert.rejects(
      () => login({ username: '20230001', password: 'wrong-pw', site }),
      (error) => {
        assert.ok(error instanceof LoginError);
        assert.equal(error.code, 'bad_credentials');
        assert.match(error.message, /密码错误/);
        return true;
      },
    );
  });

  await check('账号锁定 → locked', async () => {
    mode = 'locked';
    await assert.rejects(
      () => login({ username: '20230001', password: 'right-pw', site }),
      (error) => {
        assert.equal(error.code, 'locked');
        return true;
      },
    );
  });

  await check('形状正确但学校不认的 token Cookie → 判失败而不是成功', async () => {
    mode = 'bogus-cookie';
    await assert.rejects(
      () => login({ username: '20230001', password: 'right-pw', site }),
      (error) => {
        assert.ok(error instanceof LoginError, '应当抛 LoginError，实际: ' + error);
        assert.notEqual(error.code, 'ok');
        return true;
      },
    );
  });

  await check('空账号/空密码有明确错误', async () => {
    await assert.rejects(() => login({ username: '', password: 'x', site }), (e) => e.code === 'missing_username');
    await assert.rejects(() => login({ username: 'x', password: '', site }), (e) => e.code === 'missing_password');
  });

  server.close();

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
