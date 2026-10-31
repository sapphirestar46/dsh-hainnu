/**
 * 海师大智汇（hsaixy）上游客户端。
 *
 * 登录链路（2026-10-31 实测）：
 *   GET  /portal/api/public/login/oauth2?redirect=%2Fportal%2F   ← 必须从这一步开始，
 *        服务端在这里种下带 state 的会话 cookie；直接去 CAS 会因缺 state 回调 500
 *   → 302 /cas/oauth2.0/authorize
 *   → 302 /cas/login?service=...callbackAuthorize...
 *   → POST username/password/execution/_eventId
 *   → 302 callbackAuthorize → 302 /cas/oauth2.0/authorize
 *   → 302 /portal/api/public/login/oauth2/callback?code&state
 *   → 302 /portal/?token=<798 字符的会话令牌>
 *
 * 对话链路（底层是 MaxKB 那套工作流引擎）：
 *   GET  /portal/api/public/config                  → portalId
 *   GET  /portal/api/public/{portalId}/app          → 找 is_router=true 的应用
 *   GET  /portal/api/public/{portalId}/model        → 模型目录
 *   GET  /chat/api/open?application_id={router}     → 新会话 id
 *   POST /chat/api/chat_message/{会话id}?application_id={router}  → SSE
 *
 * 两个坑：
 *   1. POST 的 Accept 不能写 text/event-stream，网关会回 500「无法满足Accept HTTP头」；
 *      用 application/json（或不带）即可，返回的仍然是 text/event-stream。
 *   2. 历史存在服务端会话里，chat_message 只收一条 message；OpenAI 的 messages 需要
 *      在调用方做「续接 / 重开」的判断。
 */

import { CookieJar, openRequest, request } from './http.js';
import { parseLoginForm } from './login.js';
import { PLATFORM_FALLBACK_IDS, PORTAL_MODELS } from './models.js';

/**
 * 必须带 User-Agent：CAS 前面的网关在没有 UA 时会直接回 500
 * （SendTicketGrantingTicketAction 抛异常），带上任意 UA 就正常。
 * Node 的 http 模块默认不发送 UA，fetch 会，所以早期脚本能过、http.js 过不去。
 */
export const USER_AGENT = 'dsh-hainnu/0.2';

export const DEFAULTS = {
  origin: 'https://hsaixy.hainnu.edu.cn:9443',
  timeoutMs: 30000,
  chatTimeoutMs: 300000,
  catalogTtlMs: 600000,
};

export class PortalError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PortalError';
    this.code = options.code || 'portal_error';
    this.status = options.status || 0;
    this.detail = options.detail || '';
  }
}

function tokenOf(url) {
  try {
    return new URL(String(url)).searchParams.get('token') || '';
  } catch {
    return '';
  }
}

/** 密码只准提交到学校自己的域名。 */
function isSchoolHost(host, origin) {
  const h = String(host || '').toLowerCase();
  if (h === '') return false;
  try {
    if (h === new URL(origin).host) return true;
  } catch {
    /* ignore */
  }
  return h === 'hainnu.edu.cn' || h.endsWith('.hainnu.edu.cn');
}

/**
 * 用学号/密码走完整 OAuth2 链路，拿到门户会话令牌。
 * @returns {Promise<string>}
 */
export async function portalLogin(options = {}) {
  const origin = String(options.origin || DEFAULTS.origin).replace(/\/+$/, '');
  const username = String(options.username || '').trim();
  const password = String(options.password === undefined || options.password === null ? '' : options.password);
  const verifySsl = options.verifySsl !== false;
  const timeoutMs = Number(options.timeoutMs) || DEFAULTS.timeoutMs;
  if (username === '') throw new PortalError('缺少学号/工号', { code: 'missing_username' });
  if (password === '') throw new PortalError('缺少密码', { code: 'missing_password' });

  const jar = new CookieJar();
  const start = `${origin}/portal/api/public/login/oauth2?redirect=${encodeURIComponent('/portal/')}`;

  let first;
  try {
    first = await request(start, {
      jar,
      verifySsl,
      timeoutMs,
      maxRedirects: 14,
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
    });
  } catch (error) {
    throw new PortalError(`连不上海师大智汇：${error.message}`, {
      code: 'portal_network',
      detail: String(error.message || ''),
    });
  }

  // CAS 会话还在时可能直接带着令牌回来，不用再填一次表。
  const early = tokenOf(first.url);
  if (early !== '') return early;

  let host = '';
  try {
    host = new URL(first.url).hostname;
  } catch {
    host = '';
  }
  if (!isSchoolHost(host, origin)) {
    throw new PortalError('登录页跳到了非学校域名，已拒绝提交密码', {
      code: 'unexpected_landing',
      detail: `landing=${first.url}`,
    });
  }

  const form = parseLoginForm(first.text);
  const execution = form.fields.execution;
  if (typeof execution !== 'string' || execution === '') {
    throw new PortalError('没能解析出统一身份认证的 execution 参数', {
      code: 'no_execution',
      detail: `url=${first.url}`,
    });
  }

  const body = new URLSearchParams({
    username,
    password,
    execution,
    _eventId: 'submit',
  }).toString();

  let done;
  try {
    done = await request(first.url, {
      jar,
      verifySsl,
      timeoutMs,
      maxRedirects: 14,
      method: 'POST',
      body,
      headers: { accept: 'text/html', 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded' },
    });
  } catch (error) {
    throw new PortalError(`提交登录表单失败：${error.message}`, {
      code: 'portal_network',
      detail: String(error.message || ''),
    });
  }

  const token = tokenOf(done.url);
  if (token === '') {
    const bad = /密码|错误|锁定/i.test(done.text) ? '账号或密码不对' : '回调没有带回令牌';
    throw new PortalError(`海师大智汇登录失败：${bad}`, {
      code: 'portal_auth',
      status: done.status,
      detail: `landing=${done.url}`,
    });
  }
  return token;
}

/** 把 OpenAI 的 messages 压成一段纯文本（平台只收一条 message 时用）。 */
export function flattenMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = [];
  const turns = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const role = String(item.role || '');
    const text = messageText(item.content);
    if (text === '') continue;
    if (role === 'system' || role === 'developer') system.push(text);
    else if (role === 'assistant') turns.push(`助手：${text}`);
    else turns.push(`用户：${text}`);
  }
  const parts = [];
  if (system.length > 0) parts.push(system.join('\n\n'));
  if (turns.length > 1) {
    parts.push(`以下是此前的对话记录：\n${turns.slice(0, -1).join('\n')}`);
  }
  if (turns.length > 0) parts.push(`用户：${turns[turns.length - 1].replace(/^用户：/, '')}`);
  return parts.join('\n\n');
}

/** 抽出一条消息的文本；数组形式只取 text 部分。 */
export function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const piece of content) {
    if (piece !== null && typeof piece === 'object' && typeof piece.text === 'string') parts.push(piece.text);
  }
  return parts.join('\n').trim();
}

/** 稳定的 64 位散列（FNV-1a），只用于判断 messages 前缀有没有变。 */
export function hashMessages(messages) {
  const text = JSON.stringify(messages);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16);
}

export class PortalClient {
  constructor(config = {}) {
    this.origin = String(config.origin || DEFAULTS.origin).replace(/\/+$/, '');
    this.verifySsl = config.verifySsl !== false;
    this.timeoutMs = Number(config.timeoutMs) || DEFAULTS.timeoutMs;
    this.chatTimeoutMs = Number(config.chatTimeoutMs) || DEFAULTS.chatTimeoutMs;
    this.catalogTtlMs = Number(config.catalogTtlMs) || DEFAULTS.catalogTtlMs;
    this.getToken = typeof config.getToken === 'function' ? config.getToken : null;
    this.catalog = { at: 0, portalId: '', applicationId: '', platformIds: {} };
  }

  async token(force = false) {
    if (this.getToken === null) throw new PortalError('没有配置令牌来源', { code: 'no_token_source' });
    const value = await this.getToken(force);
    if (value === '') throw new PortalError('海师大智汇未登录', { code: 'portal_auth' });
    return value;
  }

  async json(path, options = {}) {
    const token = options.token || (await this.token());
    const url = `${this.origin}${path}`;
    const response = await request(url, {
      verifySsl: this.verifySsl,
      timeoutMs: this.timeoutMs,
      method: options.method || 'GET',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      maxBodyBytes: 8 * 1024 * 1024,
    });
    let payload = null;
    try {
      payload = JSON.parse(response.text);
    } catch {
      payload = null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new PortalError('海师大智汇令牌失效', { code: 'portal_auth', status: response.status });
    }
    if (response.status !== 200) {
      throw new PortalError(`海师大智汇返回 ${response.status}`, {
        code: 'portal_upstream',
        status: response.status,
        detail: response.text.slice(0, 300),
      });
    }
    if (payload === null || typeof payload !== 'object') {
      throw new PortalError('海师大智汇返回了非 JSON 内容', { code: 'portal_upstream', detail: response.text.slice(0, 200) });
    }
    const code = Number(payload.code);
    if (Number.isFinite(code) && code !== 200) {
      const message = String(payload.message || '');
      const auth = /登录|令牌|未授权|token/i.test(message);
      throw new PortalError(`海师大智汇：${message || code}`, {
        code: auth ? 'portal_auth' : 'portal_upstream',
        status: response.status,
      });
    }
    return payload.data;
  }

  /** portalId + 路由应用 + 模型映射；缓存 10 分钟。 */
  async describe(force = false) {
    if (!force && this.catalog.at > 0 && Date.now() - this.catalog.at < this.catalogTtlMs && this.catalog.portalId !== '') {
      return this.catalog;
    }
    const config = await this.json('/portal/api/public/config');
    const portalId = config !== null && typeof config === 'object' ? String(config.id || '') : '';
    if (portalId === '') throw new PortalError('门户配置里没有 id', { code: 'portal_upstream' });

    let applicationId = '';
    try {
      const apps = await this.json(`/portal/api/public/${portalId}/app`);
      const list = Array.isArray(apps) ? apps : [];
      const router = list.find((a) => a !== null && typeof a === 'object' && a.is_router === true && typeof a.application_id === 'string');
      if (router !== undefined) applicationId = router.application_id;
    } catch {
      /* 应用列表拿不到不影响模型列表 */
    }

    const platformIds = { ...PLATFORM_FALLBACK_IDS };
    try {
      const models = await this.json(`/portal/api/public/${portalId}/model`);
      for (const item of Array.isArray(models) ? models : []) {
        if (item === null || typeof item !== 'object') continue;
        const name = String(item.model_name || '');
        const id = String(item.model_id || '');
        const local = PORTAL_MODELS.find((m) => m.platformName === name);
        if (local !== undefined && id !== '') platformIds[local.id] = id;
      }
    } catch {
      /* 目录拿不到就用兜底 id */
    }

    this.catalog = { at: Date.now(), portalId, applicationId, platformIds };
    return this.catalog;
  }

  async openConversation(applicationId) {
    const id = await this.json(`/chat/api/open?application_id=${encodeURIComponent(applicationId)}`);
    const conversationId = typeof id === 'string' ? id : '';
    if (conversationId === '') throw new PortalError('没能开启新会话', { code: 'portal_upstream' });
    return conversationId;
  }

  /**
   * 发一条消息并流式收取 SSE。
   * onDelta({content, reasoning}) 每帧回调一次。
   * @returns {Promise<{content:string, reasoning:string, usage:object|null}>}
   */
  streamChat(options = {}) {
    const token = String(options.token || '');
    const applicationId = String(options.applicationId || '');
    const conversationId = String(options.conversationId || '');
    const platformModelId = String(options.platformModelId || '');
    const message = String(options.message || '');
    const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;
    const url = `${this.origin}/chat/api/chat_message/${conversationId}?application_id=${encodeURIComponent(applicationId)}`;
    const body = JSON.stringify({
      message,
      stream: true,
      re_chat: false,
      form_data: {
        model_type: '',
        selected_model: {
          model_id: platformModelId,
          model_params_setting: {
            temperature: 1,
            max_tokens: Number(options.maxTokens) || 8192,
            top_k: 50,
          },
        },
      },
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };

      openRequest(url, {
        method: 'POST',
        body,
        verifySsl: this.verifySsl,
        timeoutMs: this.chatTimeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': USER_AGENT,
          // 关键：不能写 text/event-stream，网关会 500。
          accept: 'application/json',
          'content-type': 'application/json',
        },
      })
        .then(({ req, res }) => {
          if (options.signal !== undefined && options.signal !== null) {
            options.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
          }
          const status = res.statusCode || 0;
          if (status !== 200) {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8').slice(0, 300);
              finish(
                new PortalError(`海师大智汇对话返回 ${status}`, {
                  code: status === 401 || status === 403 ? 'portal_auth' : 'portal_upstream',
                  status,
                  detail: text,
                }),
              );
            });
            res.on('error', () => finish(new PortalError('读取上游响应失败', { code: 'portal_network' })));
            return;
          }

          let buffer = '';
          let content = '';
          let reasoning = '';
          let usage = null;
          // 平台工作流的节点状态（SUCCESS / ERROR / …）：空回复时用来判断是不是平台侧出错。
          let nodeStatus = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const line = block.split('\n').find((item) => item.startsWith('data: '));
              if (line === undefined) continue;
              let frame = null;
              try {
                frame = JSON.parse(line.slice(6));
              } catch {
                continue;
              }
              if (frame === null || typeof frame !== 'object') continue;
              if (typeof frame.node_status === 'string' && frame.node_status !== '') nodeStatus = frame.node_status;
              if (frame.usage !== null && typeof frame.usage === 'object') {
                const total = Number(frame.usage.total_tokens);
                if (Number.isFinite(total) && total > 0) usage = frame.usage;
              }
              const idea = typeof frame.reasoning_content === 'string' ? frame.reasoning_content : '';
              const piece = typeof frame.content === 'string' ? frame.content : '';
              if (idea !== '') {
                reasoning += idea;
                if (onDelta !== null) onDelta({ content: '', reasoning: idea });
              }
              if (piece !== '') {
                content += piece;
                if (onDelta !== null) onDelta({ content: piece, reasoning: '' });
              }
            }
          });
          res.on('end', () => finish(null, { content, reasoning, usage, nodeStatus }));
          res.on('error', (error) => finish(new PortalError(`对话中断：${error.message}`, { code: 'portal_network' })));
        })
        .catch((error) => {
          finish(new PortalError(`连不上海师大智汇：${error.message}`, { code: 'portal_network', detail: String(error.message || '') }));
        });
    });
  }
}
