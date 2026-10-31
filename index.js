/**
 * dsh-hainnu —— 在 DSH 里登录海师（海南师范大学）账号，并把学校的
 * Open WebUI 模型接成 DSH 的 provider。
 *
 * Host 半边只做三件事：
 *   1. 在 /dsh-hainnu 上开一组 HTTP 接口，给左侧栏面板用；
 *   2. 在 DSH 启动时把本地代理拉起来（默认 127.0.0.1:8787），
 *      端口被旧项目那个 Python 代理占着就直接"接管"它，不抢端口；
 *   3. 把 provider 配置写进 profile 的 cordis.patch.yml（幂等，改动才写）。
 *
 * 登录流程与旧项目 get_token.py 一致（CAS 表单 → token Cookie），
 * 区别只是不再需要 Playwright：直接走同一条 HTTP 重定向链。
 */

import { checkHttpRequest, LoginBudget } from './lib/guard.js';
import {
  ensureModelConfig,
  readCredential,
  readModelPolicy,
  readProviderSnapshot,
  DEFAULTS as PROVIDER_DEFAULTS,
} from './lib/modelconfig.js';
import { HainnuProxy } from './lib/proxy.js';
import { LOCAL_MODEL, PORTAL_MODELS, allModels } from './lib/models.js';
import { PortalClient, portalLogin } from './lib/portal.js';
import { normalizeUsage, recordUsage, summarizeUsage } from './lib/usage.js';
import { login as loginFlow, LoginError, fetchProfile } from './lib/login.js';
import { jwtExpiry, loadState, publicState, readPassword, readToken, saveState, seal, unseal } from './lib/store.js';

export const name = 'dsh-hainnu';

export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-hainnu';
const VERSION = '0.1.0';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  upstream: 'https://chat.hainnu.edu.cn',
  localApiKey: 'sk-hainnu',
  providerId: 'hainnu',
  apiKeyEnv: 'HAINNU_API_KEY',
  modelId: 'deepseek-flash',
  autoStart: true,
  autoLogin: true,
  writeConfig: true,
  profile: 'desktop',
  verifySsl: true,
  allowRemote: false,
  allowAnonymous: false,
  // 模型策略：本地 dsh 里这条路由的特殊配置（窗口 300,000 / 输出 80,000 /
  // 压缩线 220,000），插件会把它写进 profile 的 cordis.patch.yml。
  // 220,000 = 300,000 − 80,000 − 0，窗口本身不变。
  contextWindow: 300000,
  maxTokens: 80000,
  syncModelPolicy: false,
  syncCompaction: true,
  setDefaultModel: true,
  // 海师大智汇：同一套学号密码，另一条 OAuth2 链路，多带三个阿里云百炼模型。
  portalEnabled: true,
  portalOrigin: 'https://hsaixy.hainnu.edu.cn:9443',
};

/** 自动登录的失败预算：学校连续 5 次密码错误会锁账号，这里留足余量。 */
const MAX_AUTO_FAILURES = 2;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const pick = (key, fallback) => (raw[key] === undefined || raw[key] === null ? fallback : raw[key]);
  return {
    host: String(pick('host', DEFAULTS.host)),
    port: Number(pick('port', DEFAULTS.port)) || DEFAULTS.port,
    upstream: String(pick('upstream', DEFAULTS.upstream)).replace(/\/+$/, ''),
    localApiKey: String(pick('localApiKey', DEFAULTS.localApiKey)),
    providerId: String(pick('providerId', DEFAULTS.providerId)),
    apiKeyEnv: String(pick('apiKeyEnv', DEFAULTS.apiKeyEnv)),
    modelId: String(pick('modelId', DEFAULTS.modelId)),
    autoStart: pick('autoStart', DEFAULTS.autoStart) !== false,
    autoLogin: pick('autoLogin', DEFAULTS.autoLogin) !== false,
    writeConfig: pick('writeConfig', DEFAULTS.writeConfig) !== false,
    profile: String(pick('profile', DEFAULTS.profile)),
    verifySsl: pick('verifySsl', DEFAULTS.verifySsl) !== false,
    allowRemote: pick('allowRemote', DEFAULTS.allowRemote) === true,
    allowAnonymous: pick('allowAnonymous', DEFAULTS.allowAnonymous) === true,
    contextWindow: Number(pick('contextWindow', DEFAULTS.contextWindow)) || DEFAULTS.contextWindow,
    maxTokens: Number(pick('maxTokens', DEFAULTS.maxTokens)) || DEFAULTS.maxTokens,
    syncModelPolicy: pick('syncModelPolicy', DEFAULTS.syncModelPolicy) === true,
    syncCompaction: pick('syncCompaction', DEFAULTS.syncCompaction) !== false,
    setDefaultModel: pick('setDefaultModel', DEFAULTS.setDefaultModel) !== false,
    portalEnabled: pick('portalEnabled', DEFAULTS.portalEnabled) !== false,
    portalOrigin: String(pick('portalOrigin', DEFAULTS.portalOrigin)).replace(/\/+$/, ''),
    aliases: raw.aliases !== null && typeof raw.aliases === 'object' ? raw.aliases : {},
  };
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`request body too large (>${limit} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    throw new Error('invalid json body');
  }
}

/**
 * 令牌是否可用。只看有没有拿到，不看 JWT 里的 exp——学校签发的 exp 上游并不校验
 * （实测同一个令牌文件连续用了 31 天、9.7 万次请求）。照 exp 提前重登只会每天白做
 * 几次密码校验，还会把完全能用的令牌判成「已过期」。真失效时上游回 401，由 proxy
 * 的 relogin 重登一次。
 */
function tokenUsable(state) {
  return (state.token || '') !== '';
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') logger[level](message);
    } catch {
      /* 日志失败不能影响挂载 */
    }
  };

  let state = loadState();
  if (typeof state.autoLogin !== 'boolean') state.autoLogin = settings.autoLogin;
  if (typeof state.autoStart !== 'boolean') state.autoStart = settings.autoStart;

  const persist = () => {
    try {
      saveState(state);
    } catch (error) {
      log('warn', `${name}: 状态落盘失败: ${String(error)}`);
    }
  };

  // 用量统计跟着 state.json 一起落盘，但每个请求都写盘太频繁，这里做 2 秒合并。
  state.usage = normalizeUsage(state.usage);
  let usageTimer = null;
  const schedulePersist = () => {
    if (usageTimer !== null) return;
    usageTimer = setTimeout(() => {
      usageTimer = null;
      persist();
    }, 2000);
    if (typeof usageTimer.unref === 'function') usageTimer.unref();
  };

  let loginPromise = null;
  let configNote = '';

  // 登录限流：/login 谁都能打（含 DNS 重绑定页），而学校 5 次密码错误锁账号。
  // 手动登录、自动登录、代理 401 后的重登共用这一份预算，放在接触学校之前拦。
  const loginBudget = new LoginBudget({
    maxFailures: 3,
    windowMs: FAILURE_WINDOW_MS,
    cooldownMs: FAILURE_WINDOW_MS,
  });

  // 进程级单例。DSH 热重载补丁层时不会杀进程，旧实例的 http server 不会自己消失，
  // 于是新实例只能"接管"旧实例，端口越漂越远、路由还是老的在应答。
  // 这里把当前实例挂在 globalThis 上，新实例先收掉旧的。
  const SINGLETON = Symbol.for('dsh-hainnu.active-proxy');

  // 本地代理每个请求都要判断 Key，读凭据文件带 5 秒缓存，避免每请求一次磁盘 IO。
  let keyCache = { at: 0, keys: [] };
  const acceptKeys = () => {
    const now = Date.now();
    if (now - keyCache.at < 5000) return keyCache.keys;
    const keys = [settings.localApiKey, readCredential(settings.apiKeyEnv)].filter(
      (key) => typeof key === 'string' && key !== '',
    );
    keyCache = { at: now, keys: [...new Set(keys)] };
    return keyCache.keys;
  };

  // ---- 海师大智汇（hsaixy）令牌 ----
  // 和主登录共用同一套学号密码，但走另一条 OAuth2 链路。令牌存在 state 里，
  // 失效由 401 驱动重登；登录本身受与主登录相同的失败预算约束。
  let portalLoginPromise = null;
  const portalGetToken = async (force = false) => {
    const cached = state.portalToken ? unseal(String(state.portalToken)) : '';
    if (!force && cached !== '') return cached;
    if (portalLoginPromise !== null) return portalLoginPromise;
    const password = readPassword(state);
    if (password === '' || state.username === '') return cached;
    const failCount = Number(state.failCount) || 0;
    const failAt = Number(state.failAt) || 0;
    if (failCount >= MAX_AUTO_FAILURES && Date.now() - failAt < FAILURE_WINDOW_MS) return cached;
    portalLoginPromise = (async () => {
      try {
        const token = await portalLogin({
          username: state.username,
          password,
          origin: settings.portalOrigin,
          verifySsl: settings.verifySsl,
        });
        state.portalToken = seal(token);
        state.portalTokenAt = Date.now();
        state.portalError = '';
        persist();
        log('info', `${name}: 海师大智汇已登录`);
        return token;
      } catch (error) {
        state.portalError = error instanceof Error ? error.message : String(error);
        persist();
        log('warn', `${name}: 海师大智汇登录失败: ${state.portalError}`);
        return cached;
      } finally {
        portalLoginPromise = null;
      }
    })();
    return portalLoginPromise;
  };

  const portal =
    settings.portalEnabled === false
      ? null
      : new PortalClient({
          origin: settings.portalOrigin,
          verifySsl: settings.verifySsl,
          getToken: portalGetToken,
        });

  const proxy = new HainnuProxy({
    host: settings.host,
    port: settings.port,
    upstream: settings.upstream,
    modelId: settings.modelId,
    verifySsl: settings.verifySsl,
    aliases: settings.aliases,
    acceptKeys,
    onUsage: (sample) => {
      state.usage = recordUsage(state.usage, sample);
      schedulePersist();
    },
    getToken: () => {
      if (!tokenUsable(state)) return '';
      return readToken(state);
    },
    relogin: () => autoLogin('proxy-401'),
    portal,
  });

  /** 真正的登录动作（含密码校验、落盘、刷新模型）。 */
  const performLogin = async (input) => {
    const username = String(input.username === undefined ? '' : input.username).trim();
    const password = String(input.password === undefined ? '' : input.password);
    const remember = input.remember !== false;
    if (username === '') throw new LoginError('请填写学号/工号', { code: 'missing_username' });
    if (password === '') throw new LoginError('请填写密码', { code: 'missing_password' });

    // 冷却是进程级的，放在这里而不是 handler 里：自动登录、代理重登也要受约束。
    const blocked = loginBudget.check();
    if (blocked !== null) throw new LoginError(blocked.message, { code: blocked.code });

    const result = await loginFlow({
      username,
      password,
      site: settings.upstream,
      verifySsl: settings.verifySsl,
    });

    state.username = result.username;
    state.displayName = result.displayName;
    state.token = seal(result.token);
    state.tokenAt = Date.now();
    state.expiresAt = Number(result.expiresAt) || jwtExpiry(result.token);
    state.lastLoginAt = Date.now();
    state.lastError = '';
    state.failCount = 0;
    state.failAt = 0;
    loginBudget.reset();
    if (remember) state.secret = seal(password);
    persist();

    await proxy.refreshModels(true).catch(() => {});
    const ids = proxy.mergedModelIds();
    if (Array.isArray(ids) && ids.length > 0) {
      state.models = ids;
      persist();
    }
    log('info', `${name}: 登录成功（${result.displayName || result.username}）`);
    return result;
  };

  /** 串行化登录，避免面板连点 / 启动自检和手动登录撞车（会浪费密码次数）。 */
  const runLogin = (input) => {
    if (loginPromise !== null) return loginPromise;
    loginPromise = (async () => {
      try {
        return await performLogin(input);
      } catch (error) {
        // 只有"学校真的记了一笔"的失败才计入限流；网络不通不算。
        if (error instanceof LoginError) loginBudget.recordFailure(error.code);
        throw error;
      } finally {
        loginPromise = null;
      }
    })();
    return loginPromise;
  };

  /**
   * 后台自动登录。用已保存的密码；失败次数受限，避免把学校账号刷到锁定。
   */
  const autoLogin = async (reason) => {
    const password = readPassword(state);
    if (password === '' || state.username === '') {
      state.lastError = '还没有保存账号密码';
      persist();
      return '';
    }
    const now = Date.now();
    const failCount = Number(state.failCount) || 0;
    const failAt = Number(state.failAt) || 0;
    if (failCount >= MAX_AUTO_FAILURES && now - failAt < FAILURE_WINDOW_MS) {
      state.lastError = `自动登录已暂停：最近连续失败 ${failCount} 次，请确认密码后在面板手动登录`;
      persist();
      return '';
    }
    try {
      const result = await runLogin({ username: state.username, password, remember: false });
      return result.token;
    } catch (error) {
      state.failCount = failCount + 1;
      state.failAt = now;
      state.lastError = error instanceof LoginError ? error.message : String(error.message || error);
      persist();
      log('warn', `${name}: 自动登录失败（${reason}）: ${state.lastError}`);
      return '';
    }
  };

  const applyConfig = async (options = {}) => {
    if (settings.writeConfig === false) {
      return { changed: false, notes: ['配置里关闭了 writeConfig'], problems: [] };
    }
    const result = ensureModelConfig({
      profile: settings.profile,
      providerId: settings.providerId,
      apiKeyEnv: settings.apiKeyEnv,
      apiKey: settings.localApiKey,
      modelId: settings.modelId,
      modelName: LOCAL_MODEL.name,
      // 显示名迁移：旧名字（含上一版「(海师自部署)」）都会被换成带 1017 的新名字。
      legacyNames: ['DeepSeek V4.1 Flash (海师)', 'DeepSeek V4.1 Flash (海师自部署)'],
      // 同一 provider 下的三个平台模型：海师大智汇 / 阿里云百炼。
      extraModels:
        portal === null
          ? []
          : PORTAL_MODELS.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              input: model.input,
              reasoningEfforts: model.reasoningEfforts,
            })),
      baseURL: proxy.baseURL,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
      syncModelPolicy: settings.syncModelPolicy,
      syncCompaction: settings.syncCompaction,
      setDefaultModel: settings.setDefaultModel,
      dryRun: options.dryRun === true,
    });
    configNote = result.notes.join('；');
    state.configAppliedAt = Date.now();
    state.configNote = configNote;
    persist();
    if (result.problems.length > 0) {
      log('warn', `${name}: 模型配置写入有问题: ${result.problems.join('; ')}`);
    } else {
      log('info', `${name}: 模型配置 ${result.changed ? '已更新' : '无需改动'}（${proxy.baseURL}）`);
    }
    return result;
  };

  const statusPayload = () => ({
    ok: true,
    version: VERSION,
    endpoint: { baseURL: proxy.baseURL, apiKey: settings.localApiKey, providerId: settings.providerId, modelId: settings.modelId },
    state: publicState(state),
    proxy: proxy.status(),
    // 海师大智汇：三个阿里云百炼模型，面板上要单独标出来源。
    portal:
      portal === null
        ? null
        : {
            enabled: true,
            origin: settings.portalOrigin,
            loggedIn: Boolean(state.portalToken),
            tokenAt: Number(state.portalTokenAt) || 0,
            error: String(state.portalError || ''),
            models: PORTAL_MODELS.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow })),
          },
    // 模型目录 + 每个模型的简介/能力，面板「可用模型」卡片直接渲染这份数据。
    models: allModels().map((model) => ({
      id: model.id,
      name: model.name,
      source: model.source,
      build: model.build === undefined ? '' : model.build,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      requestLimitBytes: model.requestLimitBytes === undefined ? null : model.requestLimitBytes,
      requestLimitLabel: model.requestLimitLabel === undefined ? '' : model.requestLimitLabel,
      input: model.input,
      tools: model.tools,
      vision: model.vision === true,
      summary: model.summary,
      notes: Array.isArray(model.notes) ? model.notes : [],
    })),
    // 经过本插件代理的用量（面板统计条与热力图用）。
    usage: summarizeUsage(state.usage),
    settings: {
      profile: settings.profile,
      upstream: settings.upstream,
      autoLogin: state.autoLogin !== false,
      autoStart: state.autoStart !== false,
      writeConfig: settings.writeConfig,
      apiKeyEnv: settings.apiKeyEnv,
    },
    // 安全面：鉴权模式、是否放开了远程、登录限流状态（面板「诊断」用）。
    security: {
      allowRemote: settings.allowRemote === true,
      allowAnonymous: settings.allowAnonymous === true,
      apiAuth: proxy.authMode(),
      loginGuard: loginBudget.snapshot(),
      originGuard: true,
    },
    configNote,
    provider: (() => {
      try {
        return readProviderSnapshot({ profile: settings.profile, providerId: settings.providerId });
      } catch {
        return null;
      }
    })(),
    // 模型策略：contextWindow / maxTokens / 实际压缩线 / 默认模型，面板直接展示。
    policy: (() => {
      try {
        return readModelPolicy({
          profile: settings.profile,
          providerId: settings.providerId,
          modelId: settings.modelId,
          headroomTokens: PROVIDER_DEFAULTS.compactionHeadroomTokens,
        });
      } catch {
        return null;
      }
    })(),
  });

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad_url', message: 'bad url' } });
      return;
    }
    const route = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // 第一道闸：DSH 的 webServer 对所有本机端口开放，同源策略也挡不住 DNS 重绑定页。
    // 来源说不清就在这里拒掉，后面的路由一律看不到请求。
    const rejection = checkHttpRequest(req, { allowRemote: settings.allowRemote });
    if (rejection !== null) {
      sendJson(res, 403, { ok: false, error: { code: rejection.code, message: rejection.message } });
      return;
    }

    try {
      if (route === '/status' && method === 'GET') {
        sendJson(res, 200, statusPayload());
        return;
      }

      if (route === '/login' && method === 'POST') {
        const body = await readJson(req);
        const password = String(body.password === undefined ? '' : body.password);
        const useStored = password === '';
        if (useStored) {
          const stored = readPassword(state);
          if (stored === '') {
            sendJson(res, 400, { ok: false, error: { code: 'missing_password', message: '请填写密码' } });
            return;
          }
          const result = await runLogin({ username: body.username || state.username, password: stored, remember: false });
          sendJson(res, 200, { ok: true, displayName: result.displayName, status: statusPayload() });
          return;
        }
        const result = await runLogin({
          username: body.username || state.username,
          password,
          remember: body.remember !== false,
        });
        sendJson(res, 200, { ok: true, displayName: result.displayName, status: statusPayload() });
        return;
      }

      if (route === '/save' && method === 'POST') {
        const body = await readJson(req);
        const nextName = String(body.username === undefined ? state.username : body.username).trim();
        const nextPassword = String(body.password === undefined ? '' : body.password);
        if (nextName === '') {
          sendJson(res, 400, { ok: false, error: { code: 'missing_username', message: '请填写学号/工号' } });
          return;
        }
        if (nextPassword === '') {
          sendJson(res, 400, { ok: false, error: { code: 'missing_password', message: '请填写密码' } });
          return;
        }
        state.username = nextName;
        state.secret = seal(nextPassword);
        state.lastError = '';
        state.failCount = 0;
        state.failAt = 0;
        persist();
        sendJson(res, 200, { ok: true, status: statusPayload() });
        return;
      }

      if (route === '/logout' && method === 'POST') {
        state.token = '';
        state.expiresAt = 0;
        state.lastError = '';
        persist();
        sendJson(res, 200, { ok: true, status: statusPayload() });
        return;
      }

      if (route === '/forget' && method === 'POST') {
        state.secret = '';
        state.token = '';
        state.expiresAt = 0;
        state.failCount = 0;
        state.failAt = 0;
        state.lastError = '';
        persist();
        sendJson(res, 200, { ok: true, status: statusPayload() });
        return;
      }

      if (route === '/proxy' && method === 'POST') {
        const body = await readJson(req);
        const action = String(body.action || 'restart');
        if (action === 'start') await proxy.start();
        else if (action === 'stop') await proxy.stop();
        else await proxy.restart();
        sendJson(res, 200, { ok: true, proxy: proxy.status(), status: statusPayload() });
        return;
      }

      if (route === '/apply-config' && method === 'POST') {
        const body = await readJson(req);
        const result = await applyConfig({ dryRun: body.dryRun === true });
        sendJson(res, 200, { ok: result.problems.length === 0, result, status: statusPayload() });
        return;
      }

      if (route === '/refresh-models' && method === 'POST') {
        const ids = await proxy.refreshModels(true);
        state.models = ids;
        persist();
        sendJson(res, 200, { ok: true, models: ids, status: statusPayload() });
        return;
      }

      if (route === '/settings' && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.autoLogin === 'boolean') state.autoLogin = body.autoLogin;
        if (typeof body.autoStart === 'boolean') state.autoStart = body.autoStart;
        persist();
        sendJson(res, 200, { ok: true, status: statusPayload() });
        return;
      }

      if (route === '/models' && method === 'GET') {
        const ids = proxy.modelCache.ids.length > 0 ? proxy.modelCache.ids : await proxy.refreshModels(true);
        sendJson(res, 200, { ok: true, models: ids });
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `unknown route ${route}` } });
    } catch (error) {
      if (error instanceof LoginError) {
        state.lastError = error.message;
        persist();
        sendJson(res, 400, { ok: false, error: error.toJSON(), status: statusPayload() });
        return;
      }
      log('warn', `${name}: ${route} 处理失败: ${String(error && error.message ? error.message : error)}`);
      sendJson(res, 500, {
        ok: false,
        error: { code: 'internal_error', message: String(error && error.message ? error.message : error) },
      });
    }
  };

  const mount = () => {
    const registration = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
    return () => {
      try {
        if (typeof registration === 'function') registration();
      } catch {
        /* 已经销毁 */
      }
    };
  };

  try {
    if (typeof ctx.effect === 'function') ctx.effect(mount, `${name}: HTTP surface`);
    else mount();
  } catch (error) {
    log('warn', `${name}: 挂载 HTTP 面失败: ${String(error)}`);
  }

  const releaseProxy = () => {
    try {
      if (globalThis[SINGLETON] === proxy) delete globalThis[SINGLETON];
    } catch {
      /* ignore */
    }
    proxy.stop().catch(() => {});
  };

  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', releaseProxy);
  } catch {
    /* dispose 钩子拿不到就算了 */
  }
  try {
    // 这个 effect 的清理函数在插件销毁时一定会跑，比 dispose 事件可靠
    if (typeof ctx.effect === 'function') ctx.effect(() => releaseProxy, `${name}: proxy lifecycle`);
  } catch {
    /* ignore */
  }

  /* ------------------------------------------------------------ 启动自检 */

  const boot = async () => {
    // 0) 收掉上一个被热重载替换掉的实例，防止端口漂移与旧路由抢占
    try {
      const previous = globalThis[SINGLETON];
      if (previous !== undefined && previous !== null && previous !== proxy) {
        await previous.stop();
        log('info', `${name}: 已关闭上一个插件实例的代理（端口 ${previous.port}）`);
      }
    } catch (error) {
      log('warn', `${name}: 关闭上一个实例失败: ${String(error)}`);
    }
    globalThis[SINGLETON] = proxy;

    // 1) 代理先起来（后面的 baseURL 要写实际端口）
    if (settings.autoStart !== false && state.autoStart !== false) {
      try {
        const status = await proxy.start();
        if (status.adopted) {
          log('info', `${name}: 端口 ${status.port} 上已有兼容的海师代理，直接接管（不再另起进程）`);
        } else if (status.mode === 'running') {
          log('info', `${name}: 本地代理已启动 ${status.baseURL}`);
        } else {
          log('warn', `${name}: 本地代理启动失败: ${status.lastError}`);
        }
      } catch (error) {
        log('warn', `${name}: 本地代理启动异常: ${String(error)}`);
      }
    }

    // 2) 模型配置（幂等：已经正确就不写盘，避免无谓的 loader 重载）
    try {
      const result = await applyConfig();
      if (result.problems.length > 0) {
        log('warn', `${name}: 模型配置未写入: ${result.problems.join('; ')}`);
      }
    } catch (error) {
      log('warn', `${name}: 模型配置写入异常: ${String(error)}`);
    }

    // 3) 需要的话自动登录一次
    //    接管外部实例时不登录：那个实例自己有令牌，我们登录只会白白消耗学校的
    //    "连续 5 次密码错误锁账号"额度。真需要时（外部实例退出、我们接管端口后
    //    收到 401）会由 proxy 的 relogin 触发。
    const adopted = proxy.status().adopted === true;
    const shouldLogin =
      !adopted &&
      state.autoLogin !== false &&
      settings.autoLogin !== false &&
      !tokenUsable(state) &&
      readPassword(state) !== '';
    if (adopted) {
      log('info', `${name}: 当前接管外部代理实例，跳过自动登录（省一次密码校验）`);
    }
    if (shouldLogin) {
      const token = await autoLogin('boot');
      if (token !== '') log('info', `${name}: 启动时自动登录成功`);
    }
  };

  boot().catch((error) => log('warn', `${name}: 启动自检失败: ${String(error)}`));

  log('info', `${name}: 已挂载 ${ROUTE_PREFIX}（代理 ${proxy.baseURL}，provider ${settings.providerId}/${settings.modelId}）`);
}

/** 离线测试面；Loader 只读 name / inject / apply。 */
export const __internals = {
  ROUTE_PREFIX,
  VERSION,
  DEFAULTS,
  PROVIDER_DEFAULTS,
  normalizeConfig,
  tokenUsable,
  sendJson,
  readBody,
  fetchProfile,
  unseal,
};
