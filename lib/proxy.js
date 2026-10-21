/**
 * 本地 OpenAI 兼容代理（等价于旧项目的 hainnu_proxy.py，只是换成 Node 跑在 DSH 里）。
 *
 * 端点：
 *   GET  /health                 与旧项目同形状的健康信息 + 插件标记
 *   GET  /v1/models              上游模型列表（缓存 300s，失败沿用上次结果）
 *   POST /v1/chat/completions    转发到 {upstream}/api/chat/completions
 *   （/models、/chat/completions 也认，方便把 baseURL 写成根路径的客户端）
 *
 * 转发语义照抄旧项目：
 *   - 认证：本地 Bearer Key（或 x-api-key），Key 列表为空时全部放行
 *   - 归一化：role=developer → system；max_completion_tokens → max_tokens（仅当缺失/空）
 *   - 头：Authorization: Bearer <学校 JWT>、Accept: application/json, text/event-stream
 *   - 直连上游，不读 HTTP(S)_PROXY（走本机代理常触发 Open WebUI 402）
 *   - SSE 原样透传；429 冷却 12s 后重试；401 触发一次重新登录
 */

import http from 'node:http';
import { checkHttpRequest } from './guard.js';
import { openRequest, readAll, sleep } from './http.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  upstream: 'https://chat.hainnu.edu.cn',
  modelId: 'deepseek-flash',
  timeoutMs: 300000,
  retries: 4,
  rateLimitCooldownMs: 12000,
  modelCacheMs: 300000,
  maxBodyBytes: 64 * 1024 * 1024,
  verifySsl: true,
  extraBody: { reasoning_effort: 'medium' },
};

const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'minimal', 'auto']);
const EFFORT_OFF = new Set(['none', 'off', 'disabled', 'no', 'false', '0']);

function sendJson(res, status, value, extraHeaders) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(text);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function presentedKey(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth !== '') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m !== null) return m[1].trim();
  }
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string') return alt.trim();
  return '';
}

/** 从上游各种形状里抠出模型 id 列表。 */
export function modelIdsOf(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim() !== '') ids.push(item.trim());
      continue;
    }
    if (item === null || typeof item !== 'object') continue;
    for (const key of ['id', 'name', 'model']) {
      const value = item[key];
      if (typeof value === 'string' && value.trim() !== '') {
        ids.push(value.trim());
        break;
      }
    }
  }
  return [...new Set(ids)];
}

export class HainnuProxy {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.port = Number(this.config.port) || DEFAULTS.port;
    this.server = null;
    this.mode = 'stopped'; // stopped | running | adopted | failed
    this.adoptedHealth = null;
    this.startedAt = 0;
    this.modelCache = { at: 0, ids: [], error: '' };
    this.stats = { requests: 0, errors: 0, lastError: '', lastErrorAt: 0, lastStatus: 0 };
    this.watchdog = null;
  }

  get baseURL() {
    return `http://${this.config.host}:${this.port}/v1`;
  }

  /** 供 UI 展示的状态（不含任何密钥）。 */
  status() {
    const adopted = this.mode === 'adopted';
    return {
      mode: this.mode,
      running: this.mode === 'running' || adopted,
      adopted,
      owned: this.mode === 'running',
      host: this.config.host,
      port: this.port,
      baseURL: this.baseURL,
      upstream: this.config.upstream,
      modelId: this.config.modelId,
      uptime: this.startedAt === 0 ? 0 : Math.floor((Date.now() - this.startedAt) / 1000),
      models: this.modelCache.ids,
      modelsAt: this.modelCache.at,
      modelsError: this.modelCache.error,
      requests: this.stats.requests,
      errors: this.stats.errors,
      lastError: this.stats.lastError,
      lastStatus: this.stats.lastStatus,
      adoptedHealth: this.adoptedHealth,
    };
  }

  async token() {
    try {
      const value = await this.config.getToken();
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  /** 拿令牌；没有就触发一次重新登录。 */
  async ensureToken(force = false) {
    if (!force) {
      const current = await this.token();
      if (current !== '') return current;
    }
    if (typeof this.config.relogin !== 'function') return '';
    const fresh = await this.config.relogin();
    return typeof fresh === 'string' ? fresh : '';
  }

  keyList() {
    const keys = this.config.acceptKeys;
    const list = typeof keys === 'function' ? keys() : keys;
    if (!Array.isArray(list)) return [];
    return list.filter((k) => typeof k === 'string' && k !== '');
  }

  /**
   * keys     正常模式：必须带对口令
   * anonymous 显式配置 allowAnonymous: true，谁都放行（只在被反代/网关挡住时才合理）
   * locked   一个口令都没配好（比如 credential 环境变量没注入）——以前这里放行，
   *          等于失败打开；现在默认拒绝，免得任何本机进程白蹭学校额度。
   */
  authMode() {
    if (this.keyList().length > 0) return 'keys';
    return this.config.allowAnonymous === true ? 'anonymous' : 'locked';
  }

  accepts(key) {
    const array = this.keyList();
    if (array.length === 0) return this.config.allowAnonymous === true;
    return array.includes(key);
  }

  /* ------------------------------------------------------------ 模型列表 */

  async fetchModels(token) {
    const url = `${this.config.upstream.replace(/\/+$/, '')}/api/models`;
    const { res } = await openRequest(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      verifySsl: this.config.verifySsl,
      timeoutMs: 20000,
    });
    const text = await readAll(res, 2 * 1024 * 1024);
    if (res.statusCode !== 200) {
      throw new Error(`upstream /api/models ${res.statusCode}: ${text.slice(0, 200)}`);
    }
    return modelIdsOf(JSON.parse(text));
  }

  async refreshModels(force = false) {
    const fresh = Date.now() - this.modelCache.at < this.config.modelCacheMs;
    if (!force && fresh && this.modelCache.ids.length > 0) return this.modelCache.ids;
    try {
      const token = await this.ensureToken();
      if (token === '') throw new Error('没有可用的学校令牌');
      const ids = await this.fetchModels(token);
      if (ids.length > 0) {
        this.modelCache = { at: Date.now(), ids, error: '' };
        return ids;
      }
      throw new Error('上游返回了空模型列表');
    } catch (error) {
      this.modelCache = { ...this.modelCache, error: String(error.message || error) };
      if (this.modelCache.ids.length === 0) {
        this.modelCache = { ...this.modelCache, at: Date.now(), ids: [this.config.modelId] };
      }
      return this.modelCache.ids;
    }
  }

  /** 客户端写的模型名 → 上游真名。 */
  resolveModel(requested) {
    const want = String(requested === undefined || requested === null ? '' : requested).trim();
    const ids = this.modelCache.ids;
    if (want !== '' && ids.includes(want)) return want;
    if (want !== '' && this.config.aliases && typeof this.config.aliases[want] === 'string') {
      return this.config.aliases[want];
    }
    if (want !== '') {
      const lower = want.toLowerCase();
      const fuzzy = ids.find((id) => id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase()));
      if (fuzzy !== undefined) return fuzzy;
    }
    if (this.config.modelId !== '' && (ids.length === 0 || ids.includes(this.config.modelId))) return this.config.modelId;
    if (ids.length > 0) return ids[0];
    return want === '' ? this.config.modelId : want;
  }

  /* ------------------------------------------------------------ 归一化 */

  normalize(body) {
    const out = body !== null && typeof body === 'object' ? { ...body } : {};
    if (Array.isArray(out.messages)) {
      out.messages = out.messages.map((message) =>
        message !== null && typeof message === 'object' && message.role === 'developer'
          ? { ...message, role: 'system' }
          : message,
      );
    }
    if (Object.prototype.hasOwnProperty.call(out, 'max_completion_tokens')) {
      const value = out.max_completion_tokens;
      delete out.max_completion_tokens;
      if (!out.max_tokens) out.max_tokens = value;
    }
    const extra = this.config.extraBody;
    if (extra !== null && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- 转发 */

  upstreamURL() {
    return `${this.config.upstream.replace(/\/+$/, '')}/api/chat/completions`;
  }

  async postChat(token, body, signal) {
    return openRequest(this.upstreamURL(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      verifySsl: this.config.verifySsl,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
  }

  backoff(attempt) {
    return Math.min(8000, 400 * 2 ** attempt);
  }

  /**
   * 转发一次对话请求。返回 { status, res }（res 尚未消费）。
   * 401 → 强制重登一次；429 → 冷却后重试；5xx/网络错误 → 退避重试。
   */
  async forward(body, options = {}) {
    const attempts = Math.max(1, Number(this.config.retries) || 1);
    let relogged = false;
    let lastError = '';
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await sleep(this.backoff(i - 1));
      let token = await this.ensureToken(relogged && i === 1);
      if (token === '') {
        return {
          status: 401,
          text: JSON.stringify({
            error: { message: '本地代理还没有学校登录令牌，请在「海师账号」面板登录一次', type: 'no_token' },
          }),
          failed: true,
        };
      }
      let res;
      try {
        ({ res } = await this.postChat(token, body, options.signal));
      } catch (error) {
        lastError = String(error.message || error);
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE' || /aborted/i.test(lastError)) break;
        continue;
      }
      const status = res.statusCode || 0;
      if (status === 200) return { status, res, token };

      const text = await readAll(res, 2 * 1024 * 1024).catch(() => '');
      lastError = `HTTP ${status}: ${text.slice(0, 300)}`;
      this.stats.lastStatus = status;

      if (status === 401 || status === 403) {
        if (!relogged) {
          relogged = true;
          try {
            const fresh = await this.ensureToken(true);
            if (fresh !== '') continue;
          } catch (error) {
            lastError = `重新登录失败：${error.message || error}`;
          }
        }
        return { status, text: this.authErrorText(status, text), failed: true };
      }
      if (status === 429) {
        await sleep(this.config.rateLimitCooldownMs);
        continue;
      }
      if (status === 404 && /model/i.test(text)) {
        await this.refreshModels(true).catch(() => {});
        const remapped = this.resolveModel(body.model);
        if (remapped !== body.model) {
          body.model = remapped;
          continue;
        }
      }
      if (status >= 500) continue;
      return { status, text: this.upstreamErrorText(status, text), failed: true };
    }
    return { status: 502, text: this.networkErrorText(lastError), failed: true };
  }

  authErrorText(status, text) {
    return JSON.stringify({
      error: {
        message: '学校的登录令牌已失效，请在 DSH 的「海师账号」面板重新登录',
        type: 'auth_expired',
        upstream_status: status,
        upstream_body: String(text || '').slice(0, 500),
      },
    });
  }

  upstreamErrorText(status, text) {
    const raw = String(text || '');
    let message = raw.slice(0, 800);
    if (raw.includes('Server Connection Error') || status === 402) {
      message =
        status === 402
          ? '学校 Open WebUI 的上游模型服务返回 402（额度/计费问题）。代理与网络都正常，浏览器此刻发消息也会报同样的错，请联系学校信息中心。'
          : '学校后端暂时不可用（Open WebUI 连不上模型服务），本地代理本身是好的，请稍后重试。';
    }
    return JSON.stringify({
      error: {
        message,
        type: raw.includes('Server Connection Error') ? 'upstream_unavailable' : 'upstream_error',
        upstream_status: status,
        upstream_body: raw.slice(0, 500),
      },
    });
  }

  networkErrorText(detail) {
    return JSON.stringify({
      error: {
        message: `连不上学校后端：${detail || '未知错误'}。请确认校园网可用。`,
        type: 'upstream_unreachable',
      },
    });
  }

  /* -------------------------------------------------------------- 路由 */

  async handle(req, res) {
    // /health 是无口令的自检端点（启动时探测端口占用要用），但仍然不接受
    // 非本机来源、非本机 Host 的请求，否则重绑定页可以拿它当存在性探针。
    const rejection = checkHttpRequest(req, { allowRemote: this.config.allowRemote === true });
    if (rejection !== null) {
      sendJson(res, 403, { error: { message: rejection.message, code: rejection.code } });
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' || pathname === '/') {
      const token = await this.token();
      sendJson(res, 200, {
        ok: true,
        upstream: this.config.upstream,
        models: this.modelCache.ids.length > 0 ? this.modelCache.ids : [this.config.modelId],
        default_model: this.config.modelId,
        aliases: this.config.aliases || {},
        rate_limited_now: false,
        rate_cooldown_rem: 0,
        uptime: this.startedAt === 0 ? 0 : Math.floor((Date.now() - this.startedAt) / 1000),
        plugin: { name: 'dsh-hainnu', version: '0.1.0', mode: this.mode, has_token: token !== '' },
        requests: this.stats.requests,
        errors: this.stats.errors,
      });
      return;
    }

    const isModels = pathname === '/v1/models' || pathname === '/models';
    const isChat = pathname === '/v1/chat/completions' || pathname === '/chat/completions';
    if (!isModels && !isChat) {
      sendJson(res, 404, { error: { message: `unknown path ${pathname}` } });
      return;
    }

    if (!this.accepts(presentedKey(req))) {
      // 失败关闭：一个口令都没配好时不再放行，明确告诉调用方该怎么修。
      const locked = this.keyList().length === 0;
      const message = locked ? 'local proxy has no api key configured' : 'bad local api key';
      this.stats.errors += 1;
      this.stats.lastError = message;
      this.stats.lastErrorAt = Date.now();
      sendJson(res, 401, {
        error: {
          message,
          code: locked ? 'proxy_locked' : 'bad_local_api_key',
          hint: locked ? 'set localApiKey in the dsh-hainnu config, or allowAnonymous: true to open the port' : undefined,
        },
      });
      return;
    }

    if (isModels) {
      const ids = await this.refreshModels(false);
      const created = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'hainnu' })),
      });
      return;
    }

    // 对话：先读完整请求体，再归一化转发。
    let raw;
    try {
      raw = await readAll(req, this.config.maxBodyBytes);
    } catch (error) {
      sendJson(res, 400, { error: { message: `读取请求体失败：${error.message}` } });
      return;
    }
    let body;
    try {
      body = raw === '' ? {} : JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: { message: 'invalid json body' } });
      return;
    }
    if (body === null || typeof body !== 'object') {
      sendJson(res, 400, { error: { message: 'invalid json body' } });
      return;
    }

    this.stats.requests += 1;
    const requested = String(body.model || '');
    if (this.modelCache.ids.length === 0) await this.refreshModels(false).catch(() => {});
    body = this.normalize(body);
    body.model = this.resolveModel(requested);
    const wantStream = body.stream === true;

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let outcome;
    try {
      outcome = await this.forward(body, { signal: controller.signal });
    } catch (error) {
      outcome = { status: 502, text: this.networkErrorText(String(error.message || error)), failed: true };
    }

    if (outcome.failed === true) {
      this.stats.errors += 1;
      this.stats.lastError = String(outcome.text || '').slice(0, 300);
      this.stats.lastErrorAt = Date.now();
      sendJson(res, outcome.status, JSON.parse(outcome.text || '{}'));
      return;
    }

    const upstream = outcome.res;
    const status = upstream.statusCode || 200;
    if (!wantStream) {
      const text = await readAll(upstream, this.config.maxBodyBytes).catch(() => '');
      const type = upstream.headers['content-type'] || 'application/json; charset=utf-8';
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(text);
      return;
    }

    // SSE：逐块原样透传，同时在旁路扫 usage（不改字节）。
    const headers = { 'content-type': upstream.headers['content-type'] || 'text/event-stream; charset=utf-8' };
    for (const key of ['cache-control', 'x-request-id']) {
      if (typeof upstream.headers[key] === 'string') headers[key] = upstream.headers[key];
    }
    headers['cache-control'] = headers['cache-control'] || 'no-cache';
    res.writeHead(status, headers);
    let tail = '';
    upstream.on('data', (chunk) => {
      res.write(chunk);
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-8192);
      if (tail.includes('"usage"')) {
        const m = /"usage"\s*:\s*\{[^}]*\}/.exec(tail);
        if (m !== null) {
          tail = '';
          try {
            const usage = JSON.parse(`{${m[0]}}`).usage;
            if (usage && typeof usage === 'object') this.stats.lastUsage = usage;
          } catch {
            /* 忽略统计解析失败 */
          }
        }
      }
    });
    upstream.on('end', () => {
      if (!res.writableEnded) res.end();
    });
    upstream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
  }

  /* -------------------------------------------------------------- 生命周期 */

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.stats.errors += 1;
          this.stats.lastError = String(error.message || error);
          try {
            if (!res.headersSent) sendJson(res, 500, { error: { message: String(error.message || error) } });
            else res.end();
          } catch {
            /* 连接已经没了 */
          }
        });
      });
      server.on('error', reject);
      server.listen(port, this.config.host, () => {
        server.removeListener('error', reject);
        server.on('error', (error) => {
          this.stats.lastError = `server error: ${error.message}`;
        });
        resolve(server);
      });
    });
  }

  /**
   * 带重试的探测。
   * 开机时旧项目的 Python 代理可能还没开始监听，单次探测失败就跳到备用端口的话，
   * 两个代理会各占一个端口、配置来回改。这里给足启动时间。
   */
  async probeWithRetry(port, attempts = 6, delayMs = 900) {
    for (let i = 0; i < attempts; i += 1) {
      const health = await this.probe(port);
      if (health !== null) return health;
      if (i < attempts - 1) await sleep(delayMs);
    }
    return null;
  }

  /** 探测某端口上是不是旧项目那个代理。 */
  async probe(port, timeoutMs = 1500) {
    try {
      const { res } = await openRequest(`http://${this.config.host}:${port}/health`, { timeoutMs });
      const text = await readAll(res, 256 * 1024);
      if (res.statusCode !== 200) return null;
      const health = JSON.parse(text);
      if (health === null || typeof health !== 'object' || health.ok !== true) return null;
      const models = Array.isArray(health.models) ? health.models : [];
      const ours = String(health.upstream || '').replace(/\/+$/, '') === this.config.upstream.replace(/\/+$/, '');
      if (!ours && !models.includes(this.config.modelId)) return null;
      return { ...health, port };
    } catch {
      return null;
    }
  }

  async start() {
    if (this.mode === 'running' || this.mode === 'adopted') return this.status();
    // 同一个实例被重复 start（restart / 热重载）时，先把旧的 server 收掉，
    // 否则会留下一个占着端口、又没人接管的僵尸监听。
    if (this.server !== null) {
      try {
        await this.stop();
      } catch {
        /* 关不掉也继续，下面 listen 会报 EADDRINUSE */
      }
    }
    this.startedAt = Date.now();

    const preferred = Number(this.config.port) || DEFAULTS.port;
    const candidates = [preferred, ...Array.from({ length: 9 }, (_, i) => preferred + i + 1)];
    let lastError = '';

    for (const port of candidates) {
      try {
        this.server = await this.listen(port);
        this.port = port;
        this.mode = 'running';
        this.stats.lastError = '';
        await this.refreshModels(false).catch(() => {});
        this.startWatchdog();
        return this.status();
      } catch (error) {
        lastError = String(error.message || error);
        if (error.code !== 'EADDRINUSE') continue;
        // 首选端口多等一会儿：可能只是对方的代理还在启动
        const health = port === preferred ? await this.probeWithRetry(port) : await this.probe(port);
        if (health !== null) {
          this.port = port;
          this.mode = 'adopted';
          this.adoptedHealth = {
            upstream: health.upstream || '',
            models: Array.isArray(health.models) ? health.models : [],
            uptime: Number(health.uptime) || 0,
          };
          if (Array.isArray(health.models) && health.models.length > 0) {
            this.modelCache = { at: Date.now(), ids: health.models, error: '' };
          }
          this.startWatchdog();
          return this.status();
        }
      }
    }

    this.mode = 'failed';
    this.stats.lastError = `端口 ${preferred}~${preferred + 9} 都被占用：${lastError}`;
    return this.status();
  }

  /** adopted 模式下盯着外部实例：它没了就自己接管。 */
  startWatchdog() {
    this.stopWatchdog();
    if (this.mode !== 'adopted') return;
    const timer = setInterval(async () => {
      if (this.mode !== 'adopted') return;
      const health = await this.probe(this.port);
      if (health === null) {
        this.mode = 'stopped';
        this.adoptedHealth = null;
        this.config.port = this.port;
        await this.start().catch(() => {});
      } else if (Array.isArray(health.models) && health.models.length > 0) {
        this.modelCache = { at: Date.now(), ids: health.models, error: '' };
      }
    }, 30000);
    if (typeof timer.unref === 'function') timer.unref();
    this.watchdog = timer;
  }

  stopWatchdog() {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  async stop() {
    this.stopWatchdog();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
    this.mode = 'stopped';
    this.adoptedHealth = null;
    this.startedAt = 0;
    return this.status();
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}
