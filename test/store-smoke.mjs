/**
 * 落盘加密与状态脱敏的离线测试。
 *
 * 这里要证明的是：密码/令牌不会被明文写进 state.json，也不会经 /status 回传。
 * 注意 Electron 里会走 DPAPI（ss1:），普通 node 里走 AES-256-GCM（gcm1:）——
 * 后者只是"本机派生密钥 + 认证加密"，挡的是顺手翻看/换机器拷走，不是同用户恶意进程。
 *
 *   node test/store-smoke.mjs
 */

import assert from 'node:assert/strict';
import { publicState, seal, unseal, jwtExpiry } from '../lib/store.js';

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(['PASS', label]);
  } catch (error) {
    results.push(['FAIL', label + ' :: ' + String(error && error.message ? error.message : error)]);
  }
}

const PASSWORD = 'p@ssw0rd-海师-123';

check('seal / unseal 往返一致，且密文不含明文', () => {
  const sealed = seal(PASSWORD);
  assert.notEqual(sealed, '');
  assert.notEqual(sealed, PASSWORD);
  assert.ok(!sealed.includes('p@ssw0rd'), '密文里不该出现明文');
  assert.ok(!sealed.includes('海师'), '密文里不该出现明文');
  assert.match(sealed, /^(ss1|gcm1):/);
  assert.equal(unseal(sealed), PASSWORD);
});

check('同一明文两次加密结果不同（随机 IV）', () => {
  const a = seal(PASSWORD);
  const b = seal(PASSWORD);
  assert.notEqual(a, b);
  assert.equal(unseal(a), PASSWORD);
  assert.equal(unseal(b), PASSWORD);
});

check('篡改密文解不开（认证加密），坏输入不抛异常', () => {
  const sealed = seal(PASSWORD);
  const head = sealed.slice(0, 5);
  const body = Buffer.from(sealed.slice(5), 'base64');
  body[body.length - 1] ^= 0xff;
  assert.equal(unseal(head + body.toString('base64')), '');
  assert.equal(unseal('garbage'), '');
  assert.equal(unseal(''), '');
  assert.equal(unseal(null), '');
  assert.equal(seal(''), '');
});

check('publicState 绝不包含密码/令牌明文或密文', () => {
  const state = {
    username: '20230001',
    displayName: '张三',
    secret: seal(PASSWORD),
    token: seal('jwt-token-value'),
    tokenAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  };
  const shown = publicState(state);
  const json = JSON.stringify(shown);
  assert.ok(!json.includes('p@ssw0rd'));
  assert.ok(!json.includes('jwt-token-value'));
  assert.ok(!('secret' in shown));
  assert.ok(!('token' in shown));
  assert.equal(shown.hasPassword, true);
  assert.equal(shown.hasToken, true);
  assert.equal(shown.username, '20230001');
});

check('jwtExpiry 只认 exp，不认乱七八糟的输入', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64url');
  assert.equal(jwtExpiry(`h.${payload}.s`), 1893456000 * 1000);
  assert.equal(jwtExpiry('not-a-jwt'), 0);
  assert.equal(jwtExpiry(''), 0);
  assert.equal(jwtExpiry('a.b.c'), 0);
});

let failed = 0;
for (const [kind, label] of results) {
  if (kind === 'FAIL') failed += 1;
  console.log(`${kind === 'PASS' ? '  ok ' : 'FAIL '} ${label}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
