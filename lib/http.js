/**
 * 极简 HTTP 客户端：手动跟随重定向 + 共享 Cookie 罐。
 *
 * 为什么不直接用全局 fetch：
 * 1) 学校 CAS（auth.hainnu.edu.cn:9443）与 Open WebUI 的登录是一条 307/302 链，
 *    需要逐跳收集 Set-Cookie，并且要在每一跳上判断"这次跳转是不是登录失败"；
 * 2) 需要能关闭 TLS 校验（园区网证书链偶尔不完整），fetch 做不到按请求切换；
 * 3) 代理转发要直接把上游字节流 pipe 给客户端，fetch 的 body 流语义不合用。
 */

import http from 'node:http';
import https from 'node:https';

const agents = new Map();

function agentFor(isHttps, verifySsl) {
  if (!isHttps) return undefined;
  const key = verifySsl ? 'https:strict' : 'https:relaxed';
  let agent = agents.get(key);
  if (agent === undefined) {
    agent = new https.Agent({ keepAlive: true, rejectUnauthorized: verifySsl, maxSockets: 32 });
    agents.set(key, agent);
  }
  return agent;
}

/** Cookie 罐。同名 Cookie 后写覆盖先写（本流程里三个 Cookie 名互不冲突）。 */
export class CookieJar {
  constructor() {
    this.map = new Map();
  }

  /** 吃掉一个响应的 Set-Cookie。 */
  absorb(res) {
    const raw = res.headers['set-cookie'];
    if (!raw || raw.length === 0) return;
    for (const line of raw) {
      const semi = line.indexOf(';');
      const pair = semi === -1 ? line : line.slice(0, semi);
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      let value = pair.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (name === '') continue;
      const lower = line.toLowerCase();
      const expired = /;\s*max-age\s*=\s*0\b/.test(lower) || /;\s*expires\s*=\s*thu, 01 jan 1970/.test(lower);
      if (expired) {
        this.map.delete(name);
        continue;
      }
      this.map.set(name, value);
    }
  }

  get(name) {
    const value = this.map.get(name);
    return value === undefined ? '' : value;
  }

  has(name) {
    return this.map.has(name);
  }

  names() {
    return [...this.map.keys()];
  }

  header() {
    return [...this.map].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** 读干一个流，返回 utf8 文本（超限截断）。 */
export function readAll(stream, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total <= limit) chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * 发起一个请求并拿到尚未消费的响应流。
 * 调用方负责消费 res（readAll 或 pipe）。
 */
export function openRequest(target, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch (error) {
      reject(new Error(`bad url: ${target} (${error.message})`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const verifySsl = options.verifySsl !== false;
    const body =
      options.body === undefined || options.body === null
        ? null
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(String(options.body), 'utf8');
    const headers = { ...(options.headers || {}) };
    if (body !== null && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
    if (headers.host === undefined) headers.host = url.host;

    let req;
    try {
      req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? (isHttps ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: options.method || 'GET',
          headers,
          agent: agentFor(isHttps, verifySsl),
          rejectUnauthorized: verifySsl,
        },
        (res) => resolve({ req, res }),
      );
    } catch (error) {
      reject(error);
      return;
    }
    req.on('error', reject);
    const timeoutMs = options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${url.origin}${url.pathname}`));
      });
    }
    if (body !== null) req.end(body);
    else req.end();
  });
}

/**
 * 跟随重定向的请求，返回最终响应文本与整条跳转链。
 *
 * @returns {Promise<{status:number, headers:object, text:string, url:string, chain:Array}>}
 */
export async function request(target, options = {}) {
  const jar = options.jar || null;
  const maxRedirects = options.maxRedirects === undefined ? 10 : Number(options.maxRedirects);
  const chain = [];
  let current = target;
  let method = options.method || 'GET';
  let body = options.body;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const headers = { ...(options.headers || {}) };
    if (jar !== null) {
      const cookie = jar.header();
      if (cookie !== '') headers.cookie = cookie;
    }
    const { res } = await openRequest(current, {
      method,
      body,
      headers,
      verifySsl: options.verifySsl,
      timeoutMs: options.timeoutMs,
    });
    if (jar !== null) jar.absorb(res);

    const status = res.statusCode || 0;
    const location = res.headers.location;
    const isRedirect = status >= 300 && status < 400 && typeof location === 'string' && location !== '';
    if (isRedirect) {
      chain.push({ url: current, status, location });
      await readAll(res, 64 * 1024).catch(() => '');
      const next = new URL(location, current).toString();
      if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
      continue;
    }

    const text = await readAll(res, options.maxBytes === undefined ? 4 * 1024 * 1024 : options.maxBytes);
    chain.push({ url: current, status });
    return { status, headers: res.headers, text, url: current, chain };
  }
  throw new Error(`too many redirects (>${maxRedirects}) starting at ${target}`);
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
