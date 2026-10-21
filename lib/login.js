/**
 * 海师 CAS 登录 → Open WebUI JWT。
 *
 * 流程与旧项目（hainnu-proxy/get_token.py）一致，只是把"用户盯着 Chromium 登录"
 * 换成直接用 HTTP 走同一条重定向链：
 *
 *   1. GET  https://chat.hainnu.edu.cn/oauth/github/login      （307，下发 oui-session）
 *   2. GET  https://auth.hainnu.edu.cn:9443/cas/oauth2.0/authorize?...
 *                                                              （302，下发 JSESSIONID）
 *   3. GET  .../cas/login?service=...                          （200，登录页，取 execution）
 *   4. POST 表单 username/password/execution/_eventId=submit    （302 回 callbackAuthorize）
 *   5. GET  .../oauth2.0/callbackAuthorize                     （302 到 chat 的 oauth 回调）
 *   6. GET  https://chat.hainnu.edu.cn/oauth/github/callback?code=...
 *                                                              （Set-Cookie: token=eyJ...）
 *
 * 学校这个"oauth provider 名字叫 github"其实是 CAS（/api/config 里 oauth.providers
 * 只有一个 github，但跳转目标就是 auth.hainnu.edu.cn 的 CAS），且 enable_api_key=false，
 * 只能拿 JWT。
 *
 * 已经实测过的点：登录页没有验证码、密码明文提交（没有 pwdEncryptSalt 那一套），
 * 密码错误时 CAS 返回 401 且页面里带"用户名或密码错误，请尝试"，
 * 并且**连续 5 次失败会锁账号**，所以这里绝不做无意义的重试。
 */

import { CookieJar, request } from './http.js';

export const SITE = 'https://chat.hainnu.edu.cn';
const AUTH_ORIGIN = 'https://auth.hainnu.edu.cn:9443';
const DEFAULT_TIMEOUT = 25000;

export class LoginError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LoginError';
    this.code = options.code || 'login_failed';
    this.detail = options.detail || '';
    this.status = Number(options.status) || 0;
    this.hint = options.hint || '';
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      detail: this.detail,
      hint: this.hint,
      status: this.status,
    };
  }
}

function attrOf(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (m === null) return null;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return m[3] === undefined ? '' : m[3];
}

/** 从登录页 HTML 里抠出表单 action 与隐藏字段。 */
export function parseLoginForm(html) {
  const text = String(html || '');
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  const forms = [];
  let match;
  while ((match = formRe.exec(text)) !== null) {
    forms.push({ attrs: match[1] || '', inner: match[2] || '' });
  }
  if (forms.length === 0) return { action: '', fields: {} };
  let picked = forms.find((form) => /name\s*=\s*["']?username/i.test(form.inner)) || null;
  if (picked === null) picked = forms.find((form) => /type\s*=\s*["']?password/i.test(form.inner)) || null;
  if (picked === null) picked = forms[0];

  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let input;
  while ((input = inputRe.exec(picked.inner)) !== null) {
    const tag = input[0];
    const type = (attrOf(tag, 'type') || 'text').toLowerCase();
    if (type !== 'hidden') continue;
    const name = attrOf(tag, 'name');
    if (name === null || name === '') continue;
    const value = attrOf(tag, 'value');
    fields[name] = value === null ? '' : value;
  }
  const action = attrOf(picked.attrs, 'action');
  return { action: action === null ? '' : action, fields };
}

const BAD_PASSWORD_PATTERNS = [
  /用户名或密码错误/,
  /账号或密码错误/,
  /密码错误/,
  /凭证不正确/,
  /Authentication failed/i,
  /Invalid credentials/i,
];

/**
 * 只匹配"确实被锁"的说法。
 * 注意别用裸的 /锁定/：学校密码错误的提示语本身就是
 * "用户名或密码错误，超过5次将被锁定"，裸匹配会把普通错误判成锁定。
 */
const LOCKED_PATTERNS = [
  /账号已被锁定/,
  /账户已被锁定/,
  /账号被锁定/,
  /用户已被锁定/,
  /已被锁定/,
  /锁定中/,
  /处于锁定/,
  /lock(ed)?\s*out/i,
  /too many (failed )?attempts/i,
];
const CAPTCHA_PATTERNS = [/验证码/, /captcha/i, /人机验证/];

function classifyFailure(text, status) {
  const body = String(text || '');
  if (CAPTCHA_PATTERNS.some((re) => re.test(body))) {
    return new LoginError('学校登录页要求验证码，无法在后台自动完成', {
      code: 'captcha',
      status,
      hint: '请先在浏览器登录一次 https://chat.hainnu.edu.cn ，或稍后重试。',
    });
  }
  // 顺序很关键：先判"真锁定"，再判密码错误（后者更常见）。
  if (LOCKED_PATTERNS.some((re) => re.test(body))) {
    return new LoginError('账号已被学校统一身份认证锁定，请稍后再试或联系信息中心解锁', {
      code: 'locked',
      status,
      hint: '连续 5 次密码错误会触发锁定，插件已停止自动重试。',
    });
  }
  if (BAD_PASSWORD_PATTERNS.some((re) => re.test(body))) {
    return new LoginError('学号/工号或密码错误', {
      code: 'bad_credentials',
      status,
      hint: '学校连续 5 次密码错误会锁定账号，请先确认密码再重试。',
    });
  }
  return new LoginError(`登录失败（HTTP ${status}）`, {
    code: 'login_failed',
    status,
    hint: '学校登录页返回了预期之外的内容，可能是校园网未连接或门户改版。',
  });
}

/** 这个地址是不是学校自己的认证/门户域名（密码只允许去这里）。 */
function isTrustedAuthURL(value, trustedOrigins) {
  try {
    const url = new URL(String(value));
    const allowed = Array.isArray(trustedOrigins) && trustedOrigins.length > 0
      ? trustedOrigins
      : [new URL(AUTH_ORIGIN).origin, new URL(SITE).origin];
    if (!allowed.includes(url.origin)) return false;
    // 除了测试用的显式放行，生产路径只接受 https
    if (url.protocol !== 'https:' && !(Array.isArray(trustedOrigins) && trustedOrigins.length > 0)) return false;
    return true;
  } catch {
    return false;
  }
}

function looksLikeLoginPage(url, text) {
  if (typeof url === 'string' && url.includes('/cas/login')) return true;
  const body = String(text || '');
  return /name\s*=\s*["']?password/i.test(body) && /execution/i.test(body);
}

/**
 * 从 Cookie 里取学校令牌。
 *
 * 只认 Cookie：早期版本还会在页面正文里正则找 eyJ...，结果把登录页 HTML 里
 * 一个长得像 JWT 的字符串当成了令牌，导致"密码错误却提示登录成功"。
 * 页面正文一律不作为令牌来源。
 */
function pickToken(jar, site) {
  for (const name of ['token', 'access_token']) {
    // 只认门户自己种下的 Cookie（CookieJar 按域隔离，别的主机种的令牌不算数）
    const value = jar.get(name, site);
    if (value !== '' && value.split('.').length === 3 && value.startsWith('eyJ')) return value;
  }
  return '';
}

function decodeJwtSubject(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload !== null && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

/** 用 JWT 读一下自己的资料（顺带验证令牌真的可用）。 */
export async function fetchProfile(token, options = {}) {
  const site = typeof options.site === 'string' && options.site !== '' ? options.site.replace(/\/+$/, '') : SITE;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const response = await request(`${site}/api/v1/auths/`, {
    headers,
    verifySsl: options.verifySsl !== false,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT,
    maxRedirects: 3,
  });
  if (response.status !== 200) return { ok: false, status: response.status, profile: null };
  try {
    const profile = JSON.parse(response.text);
    return { ok: true, status: 200, profile: profile !== null && typeof profile === 'object' ? profile : null };
  } catch {
    return { ok: false, status: response.status, profile: null };
  }
}

/**
 * 执行一次完整登录。
 *
 * @param {{username:string, password:string, site?:string, verifySsl?:boolean, timeoutMs?:number}} input
 * @returns {Promise<{token:string, username:string, displayName:string, expiresAt:number, chain:Array}>}
 * @throws {LoginError}
 */
export async function login(input) {
  const username = String(input?.username || '').trim();
  const password = String(input?.password === undefined || input?.password === null ? '' : input.password);
  const site = typeof input?.site === 'string' && input.site !== '' ? input.site.replace(/\/+$/, '') : SITE;
  const verifySsl = input?.verifySsl !== false;
  const timeoutMs = Number(input?.timeoutMs) || DEFAULT_TIMEOUT;
  // 只给离线测试用：生产调用方不传，就只认学校两个 https 域名。
  const trustedOrigins = Array.isArray(input?.trustedOrigins) ? input.trustedOrigins : undefined;

  if (username === '') throw new LoginError('请填写学号/工号', { code: 'missing_username' });
  if (password === '') throw new LoginError('请填写密码', { code: 'missing_password' });

  const jar = new CookieJar();
  const texts = [];
  let stage = 'authorize';

  let first;
  try {
    first = await request(`${site}/oauth/github/login`, {
      jar,
      verifySsl,
      timeoutMs,
      maxRedirects: 12,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'dsh-hainnu/0.1' },
    });
  } catch (error) {
    throw new LoginError(`无法连接学校门户：${error.message}`, {
      code: error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' ? 'network' : 'request_failed',
      hint: '请确认已连接校园网（或学校 VPN）。',
      detail: String(error.message || ''),
    });
  }
  texts.push(first.text);

  // 已经带着有效令牌回来（CAS 记住了会话）→ 直接用，但必须由学校接口验证过。
  let token = pickToken(jar, site);
  if (token !== '' && !first.url.includes('/cas/login')) {
    const profile = await fetchProfile(token, { site, verifySsl, timeoutMs }).catch(() => ({ ok: false, profile: null }));
    if (profile.ok === true) {
      return {
        token,
        username,
        displayName: displayNameOf(profile, token, username),
        expiresAt: expiresOf(token),
        chain: first.chain,
        reusedSession: true,
      };
    }
    token = '';
  }

  if (!looksLikeLoginPage(first.url, first.text)) {
    throw new LoginError('学校门户没有返回统一身份认证登录页', {
      code: 'unexpected_landing',
      detail: `landing=${first.url}`,
      hint: '门户可能改版或当前网络被重定向，请把这句话发给插件作者。',
    });
  }

  const form = parseLoginForm(first.text);
  const execution = form.fields.execution;
  if (typeof execution !== 'string' || execution === '') {
    throw new LoginError('没能解析出 CAS 登录页的 execution 参数', {
      code: 'no_execution',
      detail: `fields=${Object.keys(form.fields).join(',')}`,
      hint: '学校登录页结构可能变了。',
    });
  }

  const action = form.action === '' ? first.url : new URL(form.action, first.url).toString();

  // 密码只准提交到学校自己的域名。登录页的 action 是服务端给的，
  // 门户被改版/被投毒、或某一路跳转被劫持时，这一行能保证密码不外泄。
  if (!isTrustedAuthURL(action, trustedOrigins)) {
    throw new LoginError('学校登录页把密码表单指向了非学校地址，已拒绝发送密码', {
      code: 'unexpected_landing',
      detail: `action=${action}`,
      hint: '门户可能被改版或正被劫持，请检查网络后重试；确认无误再联系插件作者。',
    });
  }

  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(form.fields)) {
    if (key === 'username' || key === 'password') continue;
    payload.set(key, value);
  }
  payload.set('username', username);
  payload.set('password', password);
  payload.set('_eventId', 'submit');
  if (!payload.has('geolocation')) payload.set('geolocation', '');
  payload.set('execution', execution);

  stage = 'password';
  let submitted;
  try {
    submitted = await request(action, {
      jar,
      method: 'POST',
      verifySsl,
      timeoutMs,
      maxRedirects: 12,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'content-type': 'application/x-www-form-urlencoded',
        origin: AUTH_ORIGIN,
        referer: first.url,
        'user-agent': 'dsh-hainnu/0.1',
      },
      body: payload.toString(),
    });
  } catch (error) {
    throw new LoginError(`提交账号密码时网络中断：${error.message}`, {
      code: 'network',
      detail: String(error.message || ''),
    });
  }
  texts.push(submitted.text);

  token = pickToken(jar, site);
  if (token !== '') {
    const profile = await fetchProfile(token, { site, verifySsl, timeoutMs }).catch(() => ({ ok: false, profile: null }));
    if (profile.ok === true) {
      return {
        token,
        username,
        displayName: displayNameOf(profile, token, username),
        expiresAt: expiresOf(token),
        chain: [...first.chain, ...submitted.chain],
        reusedSession: false,
      };
    }
    // 拿到了形状像令牌的 Cookie，但学校不认 —— 继续按失败分类。
    token = '';
  }

  // 没拿到令牌：判定是不是密码错误 / 被锁 / 还停在登录页。
  if (looksLikeLoginPage(submitted.url, submitted.text) || submitted.status === 401) {
    throw classifyFailure(submitted.text, submitted.status);
  }
  throw new LoginError('登录流程跑通但没拿到 token', {
    code: 'no_token',
    status: submitted.status,
    detail: `landing=${submitted.url}; cookies=${jar.names().join(',')}`,
    hint: '门户可能改过 Cookie 名，请把 detail 发给插件作者。',
  });
}

function expiresOf(token) {
  const payload = decodeJwtSubject(token);
  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  return Date.now() + 12 * 60 * 60 * 1000;
}

function displayNameOf(profileResult, token, username) {
  const profile = profileResult !== null && typeof profileResult === 'object' ? profileResult.profile : null;
  if (profile !== null) {
    for (const key of ['name', 'username', 'display_name']) {
      const value = profile?.[key];
      if (typeof value === 'string' && value.trim() !== '') {
        const clean = value.trim().slice(0, 32);
        if (clean !== '') return clean;
      }
    }
  }
  const payload = decodeJwtSubject(token);
  for (const key of ['name', 'display_name', 'preferred_username']) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 32);
  }
  return username;
}
