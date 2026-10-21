/**
 * 入口校验与登录限流的离线测试。
 *
 * 这层是给「浏览器能访问本机端口」这个前提兜底的：DNS 重绑定、跨站表单、
 * 沙箱页（Origin: null）都必须被拒，而 curl/Node 这类没有 Origin 的客户端要放行。
 * 登录限流要保证：只有学校真的记了一笔的失败才计数，网络错误不计。
 *
 *   node test/guard-smoke.mjs
 */

import assert from 'node:assert/strict';
import { checkHttpRequest, isLoopbackAddress, isLoopbackName, LoginBudget, parseHostHeader } from '../lib/guard.js';

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(['PASS', label]);
  } catch (error) {
    results.push(['FAIL', label + ' :: ' + String(error && error.message ? error.message : error)]);
  }
}

function req(headers, { remoteAddress = '127.0.0.1', localPort = 3218 } = {}) {
  return { socket: { remoteAddress, localPort }, headers };
}

check('回环地址识别（含 IPv4-mapped）', () => {
  for (const value of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackAddress(value), true, value);
  }
  for (const value of ['10.0.0.2', '192.168.1.5', '::2', '8.8.8.8', '', null]) {
    assert.equal(isLoopbackAddress(value), false, String(value));
  }
});

check('Host 名识别：localhost / *.localhost / 127.x / [::1]', () => {
  for (const value of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '[::1]']) {
    assert.equal(isLoopbackName(value), true, value);
  }
  for (const value of ['evil.example.com', '127.0.0.1.evil.com', 'localhost.evil.com', '10.0.0.1']) {
    assert.equal(isLoopbackName(value), false, value);
  }
});

check('Host 头解析：端口可选、IPv6 要方括号', () => {
  assert.deepEqual(parseHostHeader('127.0.0.1:3218'), { name: '127.0.0.1', host: '127.0.0.1:3218', port: '3218' });
  assert.deepEqual(parseHostHeader('localhost'), { name: 'localhost', host: 'localhost', port: '' });
  assert.deepEqual(parseHostHeader('[::1]:3218'), { name: '[::1]', host: '[::1]:3218', port: '3218' });
  assert.equal(parseHostHeader(''), null);
  assert.equal(parseHostHeader('127.0.0.1:'), null);
});

check('正常本机请求（curl/Node，无 Origin）放行', () => {
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218' })), null);
  assert.equal(checkHttpRequest(req({ host: 'localhost:3218' })), null);
  assert.equal(checkHttpRequest(req({ host: '[::1]:3218' })), null);
});

check('伪造 Host（DNS 重绑定）被拒', () => {
  const denial = checkHttpRequest(req({ host: 'evil.example.com' }));
  assert.equal(denial.code, 'bad_host');
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1.nip.io:3218' })).code, 'bad_host');
  // 端口和本机监听端口对不上也是重绑定的典型特征
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:8080' })).code, 'bad_host');
  assert.equal(checkHttpRequest(req({})).code, 'bad_host');
});

check('跨站 Origin / Origin: null 被拒', () => {
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', origin: 'null' })).code, 'cross_site');
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', origin: 'https://evil.example' })).code, 'cross_site');
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', origin: 'file:///tmp/x.html' })).code, 'cross_site');
});

check('同源 Origin / Sec-Fetch-Site 放行', () => {
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', origin: 'http://127.0.0.1:3218' })), null);
  assert.equal(checkHttpRequest(req({ host: 'localhost:3218', origin: 'http://localhost:3218' })), null);
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', 'sec-fetch-site': 'same-origin' })), null);
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', 'sec-fetch-site': 'none' })), null);
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', 'sec-fetch-site': 'cross-site' })).code, 'cross_site');
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218', 'sec-fetch-site': 'same-site' })).code, 'cross_site');
});

check('非本机来源默认拒绝；allowRemote 才放开（仍查同源）', () => {
  const remote = { remoteAddress: '192.168.1.9' };
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218' }, remote)).code, 'remote_not_allowed');
  assert.equal(checkHttpRequest(req({ host: '127.0.0.1:3218' }, remote), { allowRemote: true }), null);
  assert.equal(
    checkHttpRequest(req({ host: '127.0.0.1:3218', origin: 'https://evil.example' }, remote), { allowRemote: true }).code,
    'cross_site',
  );
});

check('登录限流：3 次密码错误后冷却，网络错误不计', () => {
  const budget = new LoginBudget({ maxFailures: 3, windowMs: 60000, cooldownMs: 60000 });
  assert.equal(budget.check(), null);
  budget.recordFailure('network');
  budget.recordFailure('request_failed');
  assert.equal(budget.check(), null, '网络类错误不该计入');
  budget.recordFailure('bad_credentials');
  budget.recordFailure('locked');
  assert.equal(budget.check(), null, '2 次还没到上限');
  budget.recordFailure('bad_credentials');
  const blocked = budget.check();
  assert.equal(blocked.code, 'login_cooldown');
  assert.match(blocked.message, /暂停/);
  assert.equal(budget.snapshot().cooldown, true);
  assert.ok(budget.snapshot().cooldownSeconds > 0);
});

check('登录限流：成功登录后清零', () => {
  const budget = new LoginBudget({ maxFailures: 3 });
  budget.recordFailure('bad_credentials');
  budget.recordFailure('bad_credentials');
  budget.reset();
  assert.equal(budget.snapshot().failures, 0);
  budget.recordFailure('bad_credentials');
  budget.recordFailure('bad_credentials');
  assert.equal(budget.check(), null, '清零后重新计数');
});

check('登录限流：窗口外的旧失败自动过期', () => {
  const budget = new LoginBudget({ maxFailures: 2, windowMs: 1000, cooldownMs: 60000 });
  const start = Date.now();
  budget.recordFailure('bad_credentials', start);
  budget.recordFailure('bad_credentials', start + 500);
  assert.equal(budget.check(start + 600).code, 'login_cooldown');
  // 冷却结束后再看：旧失败已过窗
  const after = start + 61000;
  assert.equal(budget.check(after), null);
  budget.recordFailure('bad_credentials', after + 5000);
  assert.equal(budget.check(after + 5000), null);
});

let failed = 0;
for (const [kind, label] of results) {
  if (kind === 'FAIL') failed += 1;
  console.log(`${kind === 'PASS' ? '  ok ' : 'FAIL '} ${label}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
