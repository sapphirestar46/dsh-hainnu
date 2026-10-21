/**
 * 本地 HTTP 面的入口校验（插件路由 + 8787 代理共用）。
 *
 * 为什么需要：这两个端口都只监听回环地址，但"只监听回环"挡不住浏览器。
 * 任何网页都能向 127.0.0.1 的端口发请求；更麻烦的是 DNS 重绑定——攻击者把
 * 自己的域名解析到 127.0.0.1，浏览器就认为"这个页面和本机端口同源"，同源策略
 * 不再保护我们，页面可以读响应。
 *
 * 能自保的信号只有请求头：
 *   Host            重绑定时是攻击者域名，不是 127.0.0.1/localhost —— 最硬的判据
 *   Origin          跨站请求和同源请求都带；'null' 表示沙箱页 / file://
 *   Sec-Fetch-Site  cross-site / same-site 说明不是本页发起
 *
 * 策略：来源说不清就拒绝（默认拒绝）。curl / Node 客户端不带 Origin、不带
 * Sec-Fetch-Site，只做 Host 校验，不会把自己人挡在外面。
 *
 * 不在防御范围内：本机、同一用户的其它进程。它本来就能直接读 state.json，
 * 用握手口令也拦不住（它同样能读到口令），属于同一信任域。
 */

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

/** 回环地址（含 IPv4-mapped IPv6）。127.0.0.0/8 全部算。 */
export function isLoopbackAddress(address) {
  const text = String(address === undefined || address === null ? '' : address)
    .trim()
    .toLowerCase();
  if (text === '') return false;
  if (text === '::1' || text === '0:0:0:0:0:0:0:1') return true;
  const v4 = text.startsWith('::ffff:') ? text.slice(7) : text;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (match === null) return false;
  return Number(match[1]) === 127;
}

export function isLoopbackName(name) {
  const text = String(name === undefined || name === null ? '' : name)
    .trim()
    .toLowerCase();
  if (text === '') return false;
  if (LOOPBACK_NAMES.has(text)) return true;
  if (text.startsWith('[') && text.endsWith(']')) return isLoopbackAddress(text.slice(1, -1));
  if (text.endsWith('.localhost')) return true;
  return isLoopbackAddress(text);
}

/** 拆 Host 头。返回 {name, host, port}，端口缺省时 port 为 ''。 */
export function parseHostHeader(value) {
  const raw = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();
  if (raw === '') return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    const name = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest === '') return { name, host: name, port: '' };
    if (!rest.startsWith(':')) return null;
    const port = rest.slice(1);
    if (port === '' || !/^\d+$/.test(port)) return null;
    return { name, host: raw, port };
  }
  const colon = raw.lastIndexOf(':');
  if (colon < 0) return { name: raw, host: raw, port: '' };
  const name = raw.slice(0, colon);
  const port = raw.slice(colon + 1);
  if (name === '' || port === '' || !/^\d+$/.test(port)) return null;
  return { name, host: raw, port };
}

function deny(code, message) {
  return { code, message };
}

function checkOrigin(origin, host, allowRemote) {
  const text = String(origin).trim().toLowerCase();
  if (text === 'null') {
    return deny('cross_site', 'Origin 为 null（沙箱页或本地文件），已拒绝');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return deny('cross_site', `Origin ${origin} 无法解析，已拒绝`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return deny('cross_site', `Origin 协议 ${parsed.protocol} 不被接受，已拒绝`);
  }
  if (!allowRemote && !isLoopbackName(parsed.hostname)) {
    return deny('cross_site', `Origin ${parsed.host} 不是本机地址，已拒绝`);
  }
  if (parsed.host !== host.host) {
    return deny('cross_site', `Origin ${parsed.host} 与 Host ${host.host} 不同源，已拒绝`);
  }
  return null;
}

/**
 * 校验一个入站 HTTP 请求。
 *
 * @param {object} req Node 的 IncomingMessage。
 * @param {{allowRemote?: boolean}} [options]
 *   allowRemote: 允许非本机来源（DSH 反代 / 局域网共享时才开；开了就只剩同源校验）。
 * @returns {null | {code: string, message: string}} null 表示放行。
 */
export function checkHttpRequest(req, options = {}) {
  const allowRemote = options.allowRemote === true;
  const socket = req !== null && typeof req === 'object' ? req.socket : null;
  const headers = req !== null && typeof req === 'object' && req.headers ? req.headers : {};
  const remote = socket ? socket.remoteAddress : undefined;
  const localPort = socket && socket.localPort ? String(socket.localPort) : '';

  if (!allowRemote && typeof remote === 'string' && !isLoopbackAddress(remote)) {
    return deny(
      'remote_not_allowed',
      `拒绝来自 ${remote} 的请求：这个接口只服务本机。确实需要远程访问时，把插件配置里的 allowRemote 设为 true。`,
    );
  }

  const host = parseHostHeader(headers.host);
  if (host === null) return deny('bad_host', '缺少或无法解析 Host 头，已拒绝');

  if (!allowRemote) {
    if (!isLoopbackName(host.name)) {
      return deny('bad_host', `Host ${host.name} 不是本机地址，已拒绝（防止 DNS 重绑定）`);
    }
    if (host.port !== '' && localPort !== '' && host.port !== localPort) {
      return deny(
        'bad_host',
        `Host 端口 ${host.port} 与本机监听端口 ${localPort} 不一致，已拒绝（防止 DNS 重绑定）`,
      );
    }
  }

  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    const failure = checkOrigin(origin, host, allowRemote);
    if (failure !== null) return failure;
  }

  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '') {
    const value = site.trim().toLowerCase();
    if (value !== 'same-origin' && value !== 'none') {
      return deny('cross_site', `Sec-Fetch-Site=${value}，不是本页发起的请求，已拒绝`);
    }
  }

  return null;
}

/**
 * 登录次数预算。
 *
 * 学校连续 5 次密码错误就锁账号，而 /login 是可以被任何本地页面（含重绑定页）
 * 触发的。这里在"真正去敲学校门"之前做一次进程级限流：窗口内失败到上限就整体
 * 冷却一段时间，手动登录和自动登录共用同一份预算。
 *
 * 只统计会被学校记一笔的错误（密码错 / 已锁定）。网络类错误不计，否则断一次网
 * 就把自己锁在外面。
 */
export class LoginBudget {
  constructor(options = {}) {
    const config = options !== null && typeof options === 'object' ? options : {};
    this.maxFailures = Math.max(1, Number(config.maxFailures) || 3);
    this.windowMs = Math.max(1000, Number(config.windowMs) || 10 * 60 * 1000);
    this.cooldownMs = Math.max(1000, Number(config.cooldownMs) || 10 * 60 * 1000);
    this.failures = [];
    this.lockedUntil = 0;
  }

  static counts(code) {
    return code === 'bad_credentials' || code === 'locked';
  }

  /** 现在能不能去登录。能则返回 null，不能则返回要给用户看的错误。 */
  check(now = Date.now()) {
    if (now >= this.lockedUntil) return null;
    const minutes = Math.max(1, Math.ceil((this.lockedUntil - now) / 60000));
    return {
      code: 'login_cooldown',
      message: `连续登录失败，已暂停向学校发起登录约 ${minutes} 分钟，避免把账号刷到锁定。请确认密码后再试。`,
    };
  }

  recordFailure(code, now = Date.now()) {
    if (!LoginBudget.counts(code)) return this.snapshot(now);
    this.failures = this.failures.filter((at) => now - at < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.maxFailures) {
      this.lockedUntil = now + this.cooldownMs;
      this.failures = [];
    }
    return this.snapshot(now);
  }

  reset() {
    this.failures = [];
    this.lockedUntil = 0;
  }

  snapshot(now = Date.now()) {
    const locked = now < this.lockedUntil;
    return {
      failures: this.failures.length,
      maxFailures: this.maxFailures,
      cooldown: locked,
      cooldownSeconds: locked ? Math.ceil((this.lockedUntil - now) / 1000) : 0,
    };
  }
}
