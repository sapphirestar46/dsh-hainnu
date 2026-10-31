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
import { openRequest, readAll, readAllStrict, sleep } from './http.js';
import { LOCAL_MODEL, PORTAL_MODELS, isPortalModel, modelById } from './models.js';
import { PortalError, flattenMessages, hashMessages, messageText } from './portal.js';

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

/**
 * 从文本尾巴里取出 `"<key>":{...}` 那个完整对象字面量（含外层花括号）。
 *
 * 不能只写 /"key"\s*:\s*\{[^}]*\}/：上游的 usage 带嵌套对象
 * （prompt_tokens_details / completion_tokens_details），`[^}]*` 会在第一个
 * 内层 `}` 处截断，拼出来的 JSON 不完整，整条统计就被丢掉——流式请求因此
 * 一条都记不上账。这里按花括号配平、并跳过字符串内部的括号；对象还没收全时
 * 返回 null，等下一块继续。
 * @param {string} tail 已累积的文本尾巴
 * @param {string} key 字段名，例如 'usage'
 * @returns {string|null} 完整的对象字面量，或 null
 */
function takeObjectAfter(tail, key) {
  const at = tail.indexOf(`"${key}"`);
  if (at < 0) return null;
  const open = tail.indexOf('{', at + key.length + 2);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < tail.length; i += 1) {
    const ch = tail[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return tail.slice(open, i + 1);
  }
  return null;
}

/**
 * DSH 侧选了「off」档时要真的关掉思考。
 * DSH 发过来的形状不固定（reasoning_effort / reasoning.effort / thinking.type），三种都认。
 * 返回 true / false / undefined（undefined = 不干预，用平台默认）。
 */
export function wantsThinking(body) {
  const effort =
    body !== null && typeof body === 'object'
      ? body.reasoning_effort !== undefined
        ? body.reasoning_effort
        : body.reasoningEffort !== undefined
          ? body.reasoningEffort
          : body.reasoning !== null && typeof body.reasoning === 'object'
            ? body.reasoning.effort
            : undefined
      : undefined;
  if (typeof effort === 'string' && /^(none|off|disabled|minimal)$/i.test(effort)) return false;
  if (body !== null && typeof body === 'object') {
    if (body.enable_thinking === false) return false;
    if (body.enable_thinking === true) return true;
    if (body.thinking !== null && typeof body.thinking === 'object' && body.thinking.type === 'disabled') return false;
  }
  if (typeof effort === 'string' && effort !== '') return true;
  return undefined;
}

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';
/**
 * DSH 自己还有一套原生工具调用标记（DSML）。平台模型在 DSH 的系统提示下
 * 经常直接写这套格式，平台会把它当正文透传，所以这里也要认。
 * 竖线有全角（｜U+FF5C）和半角两种写法。
 */
const DSML_MARKERS = ['<｜DSML｜', '<|DSML|'];
/** 流式捕获时要留住的尾巴长度：取所有标记里最长的那个 */
const TOOL_MARKER_KEEP = Math.max(TOOL_OPEN.length, ...DSML_MARKERS.map((m) => m.length)) - 1;
const TOOL_MARKERS = [TOOL_OPEN, ...DSML_MARKERS];
/**
 * 放在工具协议最后一行，必须是「动作指令」而不是「禁止事项」——
 * 实测大系统提示下，只有这一句能稳定让 kimi 立刻调工具而不是只叙述计划。
 */
const TOOL_DIRECTIVE =
  '【必须】你必须在同一回合内实际调用工具完成工作，不要只说「我先看看 / 我来了解」。需要工具时立即输出 <tool_call>。';
/**
 * 放在整段提示最前面的「角色锁定」。
 * DSH 的系统提示很长、偏聊天口吻，模型容易先叙述计划就收尾；
 * 开头这句把它按回「执行任务」的角色，实测把成功率从 1/3 拉到 4/4。
 */
const TOOL_LOCK =
  '【角色锁定】你不是在聊天，而是在执行任务：每一回合要么调用工具推进，要么给出最终答复。只输出计划、不调用工具，视为这一回合失败。\n\n';

/**
 * 平台不支持原生 function calling，这里用一段文本协议把工具交给模型：
 * 要调用工具就只输出 <tool_call>{"name","arguments"}</tool_call>。
 * 三个模型实测都能严格按这个格式回。
 */
/**
 * 工具定义有两种形状，都要认：
 *   - OpenAI：{ type: 'function', function: { name, description, parameters } }
 *   - DSH 内部：{ name, description, parameters }（扁平）
 */
function toolShape(item) {
  if (item === null || typeof item !== 'object') return null;
  if (item.type === 'function' && item.function !== null && typeof item.function === 'object') {
    return {
      name: String(item.function.name || ''),
      description: item.function.description,
      parameters: item.function.parameters,
    };
  }
  if (typeof item.name === 'string' && item.name !== '') {
    return { name: item.name, description: item.description, parameters: item.parameters };
  }
  return null;
}

export function buildToolPrompt(tools) {
  const list = Array.isArray(tools) ? tools.map(toolShape).filter((item) => item !== null && item.name !== '') : [];
  const rows = [];
  for (const item of list.slice(0, 40)) {
    const name = item.name;
    if (name === '') continue;
    const text = String(item.description === undefined ? '' : item.description).replace(/\s+/g, ' ').slice(0, 200);
    let schema = '{}';
    try {
      schema = JSON.stringify(item.parameters === undefined ? { type: 'object', properties: {} } : item.parameters);
    } catch {
      schema = '{"type":"object","properties":{}}';
    }
    if (schema.length > 1200) schema = `${schema.slice(0, 1200)}…`;
    rows.push(`- ${name}：${text}\n  参数 schema：${schema}`);
  }
  if (rows.length === 0) return '';
  return [
    '',
    '—— 工具调用协议（必须遵守）——',
    '你可以调用下面这些工具：',
    rows.join('\n'),
    '',
    '【规则】',
    '1. 需要工具时，立刻按**系统提示里给的调用格式**输出一次调用。本代理两种格式都认，任选其一：',
    `   A) ${TOOL_OPEN}{"name":"工具名","arguments":{...}}${TOOL_CLOSE}`,
    '   B) <|DSML| invoke name="工具名"><|DSML| parameter name="参数名" string="true">值</|DSML| parameter></|DSML| invoke>',
    '   二选一即可，不要同时用两种、也不要混在一行里。',
    '2. 一次只调用一个工具；拿到工具结果后再继续。',
    '3. 不需要工具时，直接给出最终答复。',
    '4. 不要编造工具结果，也不要把工具调用混在正文里。',
    '',
    TOOL_DIRECTIVE,
  ].join('\n');
}

/**
 * 解析 DSH 原生 DSML 工具调用：
 *   <｜DSML｜ invoke name="run_code">
 *   <｜DSML｜ parameter name="code" string="true">…</｜DSML｜ parameter>
 *   </｜DSML｜ invoke>
 * 返回 [{name, arguments}]，arguments 是 JSON 字符串。
 */
export function parseDsmlCalls(text) {
  let raw = String(text || '');
  if (!raw.includes('DSML')) return [];
  // 全角竖线统一成半角，正则只写一种
  raw = raw.replace(/｜/g, '|');
  const calls = [];
  const paramRe = /<\|DSML\|\s*parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/\|DSML\|\s*parameter\s*>/g;
  const invokeRe = /<\|DSML\|\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/\|DSML\|\s*invoke\s*>|$)/g;
  let m;
  while ((m = invokeRe.exec(raw)) !== null) {
    const name = String(m[1] || '');
    if (name === '') continue;
    const args = {};
    let p;
    paramRe.lastIndex = 0;
    while ((p = paramRe.exec(m[2])) !== null) {
      const key = String(p[1] || '');
      if (key === '') continue;
      const isString = /string\s*=\s*"true"/.test(p[2] || '');
      let value = p[3];
      if (isString) {
        value = value.replace(/^\n/, '').replace(/\n$/, '');
      } else {
        const trimmed = value.trim();
        try {
          value = JSON.parse(trimmed);
        } catch {
          value = trimmed;
        }
      }
      args[key] = value;
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls;
}

/** 从模型输出里抽出工具调用；两种协议都认，抽不到就返回 null（当作普通文本）。 */
export function parseToolCall(text) {
  const raw = String(text || '');
  if (!raw.includes(TOOL_OPEN)) {
    // 没有 <tool_call> 时再试 DSH 原生 DSML 格式
    const dsml = parseDsmlCalls(raw);
    return dsml.length > 0 ? dsml[0] : null;
  }
  // 有的模型会把开标记写两遍（"<tool_call>\n<tool_call>{…}"），也有的漏掉闭标记：
  // 取最后一个开标记、可选闭标记，再截出最外层 JSON。
  const open = raw.lastIndexOf(TOOL_OPEN);
  if (open < 0) return null;
  let body = raw.slice(open + TOOL_OPEN.length);
  const close = body.indexOf(TOOL_CLOSE);
  if (close >= 0) body = body.slice(0, close);
  body = body.trim();
  while (body.startsWith(TOOL_OPEN)) body = body.slice(TOOL_OPEN.length).trim();
  const jsonStart = body.indexOf('{');
  const jsonEnd = body.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) body = body.slice(jsonStart, jsonEnd + 1);
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const name = String(payload.name || '');
  if (name === '') return null;
  let args = payload.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (args === null || typeof args !== 'object') args = {};
  return { name, arguments: JSON.stringify(args) };
}

/** 平台把上游异常当成正文吐回来（例如 kimi 改温度 → "Exception:Error code"）。 */
/** 只说了「我先去看看」这类计划、却没有真的调工具。 */
export function looksLikePlan(text) {
  const value = String(text || '').trim();
  if (value === '' || value.length > 240) return false;
  // 中英文都要认：温度被平台锁死在 1，模型偶尔会用英文「Let me…」叙述一遍计划。
  return /^(好[的，,]?|嗯[，,]?|我(先|来|去|这就|现在)|首先|让我|接下来|下一步)/.test(value) ||
    /^(let me|i'?ll|i will|i'?m going to|first[, ]|okay[, ]|ok[, ]|sure[, ]|alright[, ]|to start[, ])/i.test(value);
}

export function looksLikePlatformError(text) {
  const value = String(text || '').trim();
  return /^Exception:/.test(value) || /^Error code\b/i.test(value);
}

/**
 * 温度：kimi 被平台锁死在 1（改了就报 Exception）；qwen / deepseek 可改。
 * 带工具（agent 场景）时压低到 0.2 —— 实测这两个模型在 0.1 下 2/2 都立刻调工具，
 * 而 kimi 在 1 下是三分之二左右，只能靠重试兜。
 */
function portalTemperature(model, toolMode) {
  const params = model !== null && typeof model === 'object' && model.params !== undefined ? model.params : null;
  if (params === null) return undefined;
  const base = Number.isFinite(Number(params.temperature)) ? Number(params.temperature) : 1;
  if (toolMode && params.temperatureEditable === true) return Math.min(base, 0.2);
  return base;
}

function usageOf(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const total = Number(raw.total_tokens);
  if (!Number.isFinite(total) || total <= 0) return null;
  const prompt = Number(raw.prompt_tokens);
  const completion = Number(raw.completion_tokens);
  return {
    prompt_tokens: Number.isFinite(prompt) && prompt >= 0 ? prompt : 0,
    completion_tokens: Number.isFinite(completion) && completion >= 0 ? completion : 0,
    total_tokens: total,
  };
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
    /** 用量回调，由宿主注入；统计失败绝不能影响转发。 */
    this.onUsage = typeof this.config.onUsage === 'function' ? this.config.onUsage : null;
    /** 海师大智汇上游（PortalClient）；没配就是 null，此时只服务自部署那一个模型。 */
    this.portal = this.config.portal === undefined ? null : this.config.portal;
    /** 会话续接表：threadKey -> {conversationId, length, hash}。 */
    this.portalThreads = new Map();
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
      // 合并清单：面板要能看到海师大智汇那三个（它们不在上游 /api/models 里）。
      models: this.mergedModelIds(),
      modelsAt: this.modelCache.at,
      modelsError: this.modelCache.error,
      requests: this.stats.requests,
      errors: this.stats.errors,
      lastError: this.stats.lastError,
      lastStatus: this.stats.lastStatus,
      adoptedHealth: this.adoptedHealth,
      auth: this.authMode(),
      allowRemote: this.config.allowRemote === true,
      portal:
        this.portal === null
          ? null
          : { enabled: true, threads: this.portalThreads.size, lastTurn: this.stats.lastPortal || null },
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
    // 用合并后的清单：海师大智汇那三个模型不在上游 /api/models 里，
    // 只认 modelCache 的话它们会被"兜底"成 deepseek-flash。
    const ids = this.mergedModelIds();
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

  /** 把一次成功请求的 usage 交给宿主记账；任何异常都吞掉，绝不影响转发。 */
  pushUsage(usage, startedAt, model) {
    if (this.onUsage === null) return;
    if (usage === null || typeof usage !== 'object') return;
    const pick = (snake, camel) => (typeof usage[snake] === 'number' ? usage[snake] : usage[camel]);
    try {
      this.onUsage({
        at: Date.now(),
        model: String(model || ''),
        promptTokens: pick('prompt_tokens', 'promptTokens'),
        completionTokens: pick('completion_tokens', 'completionTokens'),
        totalTokens: pick('total_tokens', 'totalTokens'),
        durationMs: Date.now() - Number(startedAt || Date.now()),
      });
    } catch {
      /* 统计失败不影响转发 */
    }
  }

  authErrorText(status, text) {    return JSON.stringify({
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
        models: this.mergedModelIds(),
        default_model: this.config.modelId,
        aliases: this.config.aliases || {},
        rate_limited_now: false,
        rate_cooldown_rem: 0,
        uptime: this.startedAt === 0 ? 0 : Math.floor((Date.now() - this.startedAt) / 1000),
        plugin: { name: 'dsh-hainnu', version: '0.1.0', mode: this.mode, has_token: token !== '', auth: this.authMode() },
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
      await this.refreshModels(false);
      const created = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        object: 'list',
        data: this.mergedModelIds().map((id) => ({ id, object: 'model', created, owned_by: 'hainnu' })),
      });
      return;
    }

    // 对话：先读完整请求体，再归一化转发。
    let raw;
    try {
      raw = await readAllStrict(req, this.config.maxBodyBytes);
    } catch (error) {
      const tooLarge = error !== null && error !== undefined && error.code === 'BODY_TOO_LARGE';
      // 请求体没读完，这条连接不能再复用，回完就关。
      if (tooLarge) res.setHeader('connection', 'close');
      sendJson(res, tooLarge ? 413 : 400, {
        error: { message: `读取请求体失败：${error.message}`, code: tooLarge ? 'body_too_large' : 'body_read_failed' },
      });
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
    const startedAt = Date.now();
    const requested = String(body.model || '');
    if (this.modelCache.ids.length === 0) await this.refreshModels(false).catch(() => {});
    body = this.normalize(body);
    body.model = this.resolveModel(requested);
    const wantStream = body.stream === true;

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    // 海师大智汇的三个模型走另一条上游（MaxKB 风格 SSE），协议不同，单独处理。
    if (isPortalModel(body.model)) {
      await this.handlePortalChat(body, res, controller, startedAt);
      return;
    }

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
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      this.pushUsage(payload?.usage, startedAt, body.model);
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
    let streamUsage = null;
    upstream.on('data', (chunk) => {
      res.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-8192);
      if (tail.includes('"usage"')) {
        const raw = takeObjectAfter(tail, 'usage');
        if (raw !== null) {
          tail = '';
          try {
            const usage = JSON.parse(raw);
            if (usage && typeof usage === 'object') {
              this.stats.lastUsage = usage;
              streamUsage = usage;
            }
          } catch {
            /* 忽略统计解析失败 */
          }
        }
      }
    });
    upstream.on('end', () => {
      if (!res.writableEnded) res.end();
      this.pushUsage(streamUsage, startedAt, body.model);
    });
    upstream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
  }

  /* ------------------------------------------------------- 海师大智汇上游 */

  /** 对外的模型清单：自部署那一个 + 上游目录 + 平台目录。 */
  mergedModelIds() {
    const ids = [];
    const push = (id) => {
      if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
    };
    push(LOCAL_MODEL.id);
    for (const id of this.modelCache.ids) push(id);
    if (this.portal !== null) {
      for (const model of PORTAL_MODELS) push(model.id);
    }
    return ids;
  }

  /** 续接键：同一个首条消息（system 提示）+ 同一个模型，视为同一条会话。 */
  threadKeyFor(modelId, messages) {
    const head = Array.isArray(messages) && messages.length > 0 ? [messages[0]] : [];
    return `${modelId}|${hashMessages(head)}`;
  }

  /**
   * 决定这一轮怎么发：
   *   B（主）——上次的 messages 正好是本轮前缀、且只多了「助手回复 + 新提问」，
   *            就复用平台会话，只发新增的那条 user 消息；
   *   A（兜底）——其余情况新开一个会话，把整段历史压成一条消息发过去。
   */
  async preparePortalTurn(model, messages, force, options = {}) {
    const token = await this.portal.token(force);
    // 把刚拿到的 token 一路带下去，避免 describe/openConversation 再问一次 getToken(false)
    const catalog = await this.portal.describe(force, token);
    const platformModelId = catalog.platformIds[model.id] || '';
    if (platformModelId === '') {
      throw new PortalError(`海师大智汇没有模型 ${model.id}`, { code: 'portal_upstream' });
    }

    const key = this.threadKeyFor(model.id, messages);
    const prev = options.fresh === true ? undefined : this.portalThreads.get(key);
    let conversationId = '';
    let prompt = '';
    let continued = false;
    if (prev !== undefined && messages.length > prev.length && prev.hash === hashMessages(messages.slice(0, prev.length))) {
      const extra = messages.slice(prev.length);
      const head = extra[0];
      const headRole = head !== null && typeof head === 'object' ? String(head.role || '') : '';
      if (headRole === 'assistant' && extra.length === 2) {
        const user = extra[1];
        if (user !== null && typeof user === 'object' && user.role === 'user') {
          const text = messageText(user.content);
          if (text !== '') {
            conversationId = prev.conversationId;
            prompt = text;
            continued = true;
          }
        }
      } else if (headRole === 'assistant' && extra.length > 1 && extra.slice(1).every((m) => m !== null && typeof m === 'object' && m.role === 'tool')) {
        // 上一轮模型调了工具，这一轮把工具结果接回同一条平台会话。
        const results = extra.slice(1).map((m) => messageText(m.content)).filter((value) => value !== '');
        if (results.length > 0) {
          conversationId = prev.conversationId;
          prompt = `工具结果：\n${results.join('\n---\n')}\n\n请根据工具结果继续。`;
          continued = true;
        }
      }
    }
    if (conversationId === '') {
      conversationId = await this.portal.openConversation(catalog.applicationId, token);
      prompt = flattenMessages(messages);
      // 新会话才需要把工具清单带上；复用会话时协议已经在上文里了。
      // 工具清单放末尾、角色锁定放开头的开头，两头夹住。
      if (typeof options.toolSection === 'string' && options.toolSection !== '') {
        prompt = `${TOOL_LOCK}${prompt}${options.toolSection}`;
      }
      // 空回复重试时补一句：这类思考型模型容易只产思考不给正文。
      if (options.nudge === true) prompt += '\n\n（请直接给出最终答复，不要只输出思考过程。）';
    }
    if (prompt.trim() === '') throw new PortalError('没有可发送的消息内容', { code: 'empty_message' });
    // mode: 'continue' 表示接在已有平台会话后面（工具结果续接）。
    // 这种轮次绝不能换新会话重试，否则会丢掉之前所有工具结果。
    return { token, catalog, platformModelId, conversationId, prompt, key, mode: continued ? 'continue' : 'fresh' };
  }

  rememberThread(key, messages, conversationId) {
    this.portalThreads.delete(key);
    this.portalThreads.set(key, { conversationId, length: messages.length, hash: hashMessages(messages) });
    while (this.portalThreads.size > 32) {
      const oldest = this.portalThreads.keys().next();
      if (oldest.done === true) break;
      this.portalThreads.delete(oldest.value);
    }
  }

  async handlePortalChat(body, res, controller, startedAt) {
    const model = modelById(body.model);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const wantStream = body.stream === true;

    const report = (error) => {
      const message = String(error && error.message ? error.message : error);
      this.stats.errors += 1;
      this.stats.lastError = message.slice(0, 300);
      this.stats.lastErrorAt = Date.now();
      this.stats.lastStatus = Number(error && error.status) || 502;
      if (!res.headersSent) {
        sendJson(res, Number(error && error.status) === 401 ? 401 : 502, {
          error: { message, code: String((error && error.code) || 'portal_upstream') },
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    };

    if (model === null) {
      report(new PortalError(`未知模型 ${body.model}`, { code: 'unknown_model' }));
      return;
    }
    if (this.portal === null) {
      report(new PortalError('海师大智汇上游未启用', { code: 'portal_disabled' }));
      return;
    }

    // off 档 → enable_thinking: false；其它档位沿用平台默认（开）。
    const thinking = wantsThinking(body);
    // 平台没有原生 function calling：把工具清单写进提示，按文本协议解析回来。
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolSection = tools.length > 0 ? buildToolPrompt(tools) : '';
    let pending = '';
    let toolRaw = '';
    let capturing = false;
    const flushPending = (write) => {
      if (pending !== '') {
        content += pending;
        if (write && wantStream) res.write(`data: ${JSON.stringify(chunkOf({ content: pending }))}\n\n`);
        pending = '';
      }
    };
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${created.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const chunkOf = (delta, finish) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: model.id,
      choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }],
    });

    let content = '';
    let reasoning = '';
    if (wantStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(chunkOf({ role: 'assistant', content: '' }))}\n\n`);
    }

    // 发一轮并收集。准备阶段还没有任何输出，令牌失效时重登一次是安全的。
    const sendTurn = async (options) => {
      let turn = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          turn = await this.preparePortalTurn(model, messages, attempt > 0, options);
          break;
        } catch (error) {
          if (attempt === 0 && error !== null && error !== undefined && error.code === 'portal_auth') continue;
          throw error;
        }
      }
      if (turn === null) throw new PortalError('海师大智汇未登录', { code: 'portal_auth' });
      const result = await this.portal.streamChat({
        token: turn.token,
        applicationId: turn.catalog.applicationId,
        conversationId: turn.conversationId,
        platformModelId: turn.platformModelId,
        message: turn.prompt,
        maxTokens: Number(options.maxTokens) || model.maxTokens,
        temperature: portalTemperature(model, tools.length > 0),
        topK: model.params !== undefined ? model.params.topK : undefined,
        enableThinking: options.enableThinking,
        signal: controller.signal,
        onDelta: (delta) => {
          if (delta.reasoning !== '') {
            reasoning += delta.reasoning;
            if (wantStream) res.write(`data: ${JSON.stringify(chunkOf({ reasoning_content: delta.reasoning }))}\n\n`);
          }
          if (delta.content !== '') {
            // 已经在收集工具调用：正文不再往外发。
            if (capturing) {
              toolRaw += delta.content;
              return;
            }
            pending += delta.content;
            // 两种协议都要在流里被截住：<tool_call> 与 DSH 的 <｜DSML｜
            let at = -1;
            for (const marker of TOOL_MARKERS) {
              const found = pending.indexOf(marker);
              if (found >= 0 && (at < 0 || found < at)) at = found;
            }
            if (at >= 0) {
              const before = pending.slice(0, at);
              if (before !== '') {
                content += before;
                if (wantStream) res.write(`data: ${JSON.stringify(chunkOf({ content: before }))}\n\n`);
              }
              capturing = true;
              toolRaw = pending.slice(at);
              pending = '';
              return;
            }
            // 留住可能是标记前缀的尾巴，其余立刻发出去（保证流式不卡）。
            const keep = TOOL_MARKER_KEEP;
            if (pending.length > keep) {
              const safe = pending.slice(0, pending.length - keep);
              pending = pending.slice(pending.length - keep);
              const broken = looksLikePlatformError(content + safe);
              content += safe;
              // 平台把异常当正文时不要转发给 DSH，留着走重试/报错。
              if (!broken && wantStream) res.write(`data: ${JSON.stringify(chunkOf({ content: safe }))}\n\n`);
            }
          }
        },
      });
      return { turn, result };
    };

    // 思考型模型偶尔只吐思考、不给正文；平台侧偶发截断也是这样。
    // 正文为空时换一个新会话、加一句「直接给结论」再来一次，正文一旦出现就不再重试。
    let last = null;
    // 工具模式下温度被平台锁在 1，模型偶尔会「只说不做」；多给一次重试机会。
    const maxRounds = tools.length > 0 ? 3 : 2;
    try {
      for (let round = 0; round < maxRounds; round += 1) {
        const options =
          round === 0
            ? { enableThinking: thinking }
            : { fresh: true, nudge: tools.length === 0, maxTokens: Math.max(model.maxTokens, 16384), enableThinking: thinking };
        pending = '';
        toolRaw = '';
        capturing = false;
        const contentBefore = content.length;
        // 第二轮把那条「必须动手」再压一遍到末尾。
        const section = toolSection === '' ? '' : round === 0 ? toolSection : `${toolSection}\n${TOOL_DIRECTIVE}`;
        last = await sendTurn({ ...options, toolSection: section });
        // 收尾：没进工具收集的尾巴当正文发出去；进了的并进 toolRaw。
        if (capturing) toolRaw += pending;
        else flushPending(true);
        pending = '';
        // 平台把异常当正文吐回来时，等同「没拿到正文」，交给下一轮重试。
        const broken = looksLikePlatformError(content);
        if (broken) content = '';
        this.stats.lastPortal = {
          at: Date.now(),
          model: model.id,
          rounds: round + 1,
          thinking: thinking === undefined ? 'default' : thinking,
          temperature: model.params !== undefined ? model.params.temperature : null,
          promptChars: last.turn.prompt.length,
          tools: tools.length,
          toolPromptChars: toolSection.length,
          content: content.length,
          reasoning: reasoning.length,
          nodeStatus: String(last.result.nodeStatus || ''),
          platformError: broken ? 'yes' : '',
        };
        // 有正文、或模型已经给出了工具调用，都算这一轮成功，别再多打一次。
        // 例外：只说了「我先看看」却没动手——换新会话、末尾再压一遍硬要求重来。
        const called = parseToolCall(toolRaw) !== null;
        // 只看「这一轮」的输出：多轮累积的正文会超出长度阈值，判不出来。
        // 只在新开会话的轮次重试：续接轮换新会话会丢掉之前的工具结果。
        const idlePlan =
          tools.length > 0 && !called && last.turn.mode === 'fresh' && looksLikePlan(content.slice(contentBefore));
        if ((content.trim() !== '' || called) && !idlePlan) break;
        if (controller.signal.aborted) break;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      report(error);
      return;
    }

    // 模型按协议调了工具就把正文换成一个 tool_calls，让 DSH 去真正执行。
    // 名字必须在这轮的工具表里，否则当作普通文本吐出去（别吞内容）。
    const parsedCall = parseToolCall(toolRaw);
    const known = tools.map(toolShape).filter((item) => item !== null).map((item) => item.name);
    const toolCall = parsedCall !== null && known.includes(parsedCall.name) ? parsedCall : null;
    if (parsedCall === null && toolRaw !== '' && content.trim() === '') {
      // 捕获到疑似调用但解析失败：不要静默丢掉，原样当正文。
      content += toolRaw;
      if (wantStream) res.write(`data: ${JSON.stringify(chunkOf({ content: toolRaw }))}\n\n`);
    }
    const callId = `call_${Math.random().toString(36).slice(2, 10)}`;

    if (content.trim() === '' && toolCall === null) {
      // 两轮都没有正文：把原因说清楚，别让 DSH 只报一句 "no content"。
      const node = last !== null && last.result.nodeStatus ? `（平台节点状态：${last.result.nodeStatus}）` : '';
      const note =
        `⚠️ 海师大智汇的 ${model.id} 这一轮没有返回正文${node}，已自动换新会话重试一次。` +
        '通常是平台侧截断，或该轮只产出了思考内容；换个问法或稍后再试。';
      this.stats.lastError = note.slice(0, 300);
      this.stats.lastErrorAt = Date.now();
      if (wantStream) {
        res.write(`data: ${JSON.stringify(chunkOf({ content: note }))}\n\n`);
        res.write(`data: ${JSON.stringify(chunkOf({}, 'stop'))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      report(new PortalError(note, { code: 'portal_empty' }));
      return;
    }

    const usage = usageOf(last.result.usage);
    this.pushUsage(usage, startedAt, model.id);
    this.rememberThread(last.turn.key, messages, last.turn.conversationId);

    const toolDelta =
      toolCall === null
        ? null
        : { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }] };

    if (wantStream) {
      if (toolDelta !== null) res.write(`data: ${JSON.stringify(chunkOf(toolDelta))}\n\n`);
      // usage 挂在最后那个 finish 帧上，而不是再补一个 choices 为空的帧：
      // 有些客户端会直接读 choices[0]，空数组会让它们抛。
      const finalChunk = chunkOf({}, toolCall === null ? 'stop' : 'tool_calls');
      if (usage !== null) finalChunk.usage = usage;
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const message = { role: 'assistant', content: toolCall === null ? content : content };
    if (reasoning !== '') message.reasoning_content = reasoning;
    if (toolCall !== null) {
      message.tool_calls = [{ id: callId, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }];
    }
    sendJson(res, 200, {
      id: completionId,
      object: 'chat.completion',
      created,
      model: model.id,
      choices: [{ index: 0, message, finish_reason: toolCall === null ? 'stop' : 'tool_calls' }],
      usage: usage === null ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } : usage,
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
