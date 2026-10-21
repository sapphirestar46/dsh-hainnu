/**
 * dsh-hainnu —— client half (web bundle).
 *
 * 左侧栏新增一个「海师账号」入口，点开是一个面板：
 *
 *   学号/工号 + 密码 → 保存（加密落盘）→ 后台走学校 CAS 登录拿 JWT
 *   → 本地代理用这个 JWT 转发 → provider 已自动写进 cordis.patch.yml
 *
 * 打包形态与官方插件一致：manifest 里 `dsh.client = { platform: 'web' }`，
 * 客户端模块系统用 `window.__ModuleLoader__.load({ id, factory })` 加载，
 * `factory(require)` 只从共享模块表取 `react` / `react/jsx-runtime`。
 *
 * 没有 JSX、没有构建步骤：全部用 `jsx(type, props)` 调用，
 * children 走 props.children（这样不必区分 jsx/jsxs）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-hainnu',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const jsx = jsxRuntime.jsx;

    const ENDPOINT = '/dsh-hainnu';
    const PANEL_ID = 'hainnu-account';
    const NS = 'hainnu';
    const CSS_TAG = 'dsh-hainnu/panel.css';

    const zh = {
      panel: '海师账号',
      title: '海师账号',
      subtitle: '登录学校统一身份认证，DSH 自动接入海师模型代理',
    };
    const en = {
      panel: 'HAINNU account',
      title: 'HAINNU account',
      subtitle: 'Sign in to the school portal; DSH wires up the HAINNU model proxy',
    };

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.hn-root { height: 100%; overflow-y: auto; padding: 24px 28px 56px; box-sizing: border-box;
  font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.hn-wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.hn-head h2 { margin: 0 0 2px; font-size: 17px; font-weight: 600; }
.hn-head p { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.hn-card { border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: 10px;
  background: var(--dsw-alias-settings-card-fill); padding: 14px 16px; }
.hn-card > h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.hn-rows { display: flex; flex-direction: column; gap: 8px; }
.hn-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.hn-k { color: var(--dsw-alias-label-tertiary); min-width: 68px; }
.hn-v { color: var(--dsw-alias-label-primary); word-break: break-all; }
.hn-v.mono { font-family: var(--dsh-font-family-code); font-size: 12px; }
.hn-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px;
  padding: 1px 9px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-secondary); }
.hn-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.hn-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.hn-badge.err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.hn-badge.off { color: var(--dsw-alias-label-tertiary); }
.hn-form { display: flex; flex-direction: column; gap: 10px; }
.hn-field { display: flex; flex-direction: column; gap: 4px; }
.hn-field label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.hn-field input { height: 32px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px; font-size: 13px; background: var(--dsw-alias-bg-l1);
  color: var(--dsw-alias-label-primary); outline: none; }
.hn-field input:focus { border-color: var(--dsw-alias-brand-primary); }
.hn-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.hn-btn { height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary);
  font-size: 12.5px; cursor: pointer; }
.hn-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.hn-btn:disabled { opacity: .55; cursor: default; }
.hn-btn.primary { background: var(--dsw-alias-button-primary-fill);
  border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.hn-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.hn-btn.danger { color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-secondary); }
.hn-btn.danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.hn-toggle { display: flex; align-items: center; gap: 7px; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); }
.hn-toggle input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.hn-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.hn-alert { border-radius: 8px; padding: 9px 12px; font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-fill-l1);
  color: var(--dsw-alias-label-primary); }
.hn-alert.err { border-color: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary); }
.hn-alert.ok { border-color: var(--dsw-alias-state-success-secondary);
  color: var(--dsw-alias-state-success-primary); }
.hn-alert.info { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.hn-models { display: flex; flex-wrap: wrap; gap: 6px; }
.hn-chip { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 1px 8px;
  font-size: 12px; background: var(--dsw-alias-fill-l1);
  font-family: var(--dsh-font-family-code); color: var(--dsw-alias-label-secondary); }
.hn-chip.on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-text); }
.hn-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 12.5px; }
.hn-kv > div:nth-child(odd) { color: var(--dsw-alias-label-tertiary); }
.hn-kv > div:nth-child(even) { word-break: break-all; color: var(--dsw-alias-label-primary); }
.hn-sep { height: 1px; background: var(--dsw-alias-separator-primary); margin: 2px 0; }
`;

    function ensureStyle() {
      if (typeof document === 'undefined' || document === null) return null;
      try {
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') !== null) return null;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-hainnu';
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return tag;
      } catch (error) {
        console.warn('[dsh-hainnu] 样式注入失败，面板会以无样式形式渲染：', error);
        return null;
      }
    }

    /* ---------------------------------------------------------------- 小工具 */

    function fmtTime(ts) {
      const value = Number(ts) || 0;
      if (value <= 0) return '—';
      try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return new Date(value).toISOString();
      }
    }

    function fmtLeft(ts) {
      const value = Number(ts) || 0;
      if (value <= 0) return '—';
      const left = value - Date.now();
      if (left <= 0) return '已过期';
      const minutes = Math.floor(left / 60000);
      if (minutes < 60) return `${minutes} 分钟后过期`;
      const hours = Math.floor(minutes / 60);
      return `${hours} 小时 ${minutes % 60} 分后过期`;
    }

    async function call(path, body) {
      const options = body === undefined ? { method: 'GET' } : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
      const response = await fetch(ENDPOINT + path, options);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok && (payload === null || payload.ok !== false)) {
        return { ok: false, error: { code: 'http_' + response.status, message: `请求失败（HTTP ${response.status}）` } };
      }
      return payload === null ? { ok: false, error: { code: 'bad_response', message: '宿主返回了非 JSON 内容' } } : payload;
    }

    function badge(text, kind) {
      return jsx('span', { className: 'hn-badge ' + (kind || 'off'), children: text });
    }

    function kv(pairs) {
      const children = [];
      for (const [key, value] of pairs) {
        children.push(jsx('div', { children: key }, 'k-' + key));
        children.push(jsx('div', { children: value }, 'v-' + key));
      }
      return jsx('div', { className: 'hn-kv', children });
    }

    /* ------------------------------------------------------------- 侧栏图标 */

    function HainnuIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 18;
      return jsx('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx('path', { d: 'M12 3 2.5 8 12 13l9.5-5L12 3Z', key: 'a' }),
          jsx('path', { d: 'M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5', key: 'b' }),
          jsx('path', { d: 'M21.5 8v5', key: 'c' }),
        ],
      });
    }

    /* ---------------------------------------------------------------- 面板 */

    function HainnuPanel() {
      const [status, setStatus] = react.useState(null);
      const [error, setError] = react.useState('');
      const [notice, setNotice] = react.useState('');
      const [busy, setBusy] = react.useState('');
      const [username, setUsername] = react.useState('');
      const [password, setPassword] = react.useState('');
      const [touchedName, setTouchedName] = react.useState(false);
      const alive = react.useRef(true);

      react.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const applyStatus = react.useCallback((payload) => {
        if (!alive.current || payload === null || payload === undefined) return;
        setStatus(payload);
        if (!touchedName && payload.state !== undefined && typeof payload.state.username === 'string' && payload.state.username !== '') {
          setUsername(payload.state.username);
        }
      }, [touchedName]);

      const refresh = react.useCallback(async () => {
        try {
          const payload = await call('/status');
          if (payload.ok === true) {
            applyStatus(payload);
            setError('');
          } else {
            setError(payload.error && payload.error.message ? payload.error.message : '读取状态失败');
          }
        } catch (cause) {
          if (alive.current) setError('连不上 DSH 宿主：' + String(cause && cause.message ? cause.message : cause));
        }
      }, [applyStatus]);

      react.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
      }, [refresh]);

      const run = react.useCallback(async (label, task) => {
        setBusy(label);
        setError('');
        setNotice('');
        try {
          const payload = await task();
          if (payload !== null && payload !== undefined) {
            if (payload.status !== undefined) applyStatus(payload.status);
            else await refresh();
            if (payload.ok === false) {
              const detail = payload.error || {};
              const text = [detail.message, detail.hint].filter((x) => typeof x === 'string' && x !== '').join('　');
              setError(text === '' ? '操作失败' : text);
            } else if (payload.ok === true) {
              if (label === 'login') setNotice('登录成功，模型已接入');
              else if (label === 'save') setNotice('账号密码已加密保存');
              else if (label === 'forget') setNotice('已清除保存的账号密码和令牌');
              else if (label === 'logout') setNotice('已退出登录（令牌已清除）');
              else if (label === 'proxy') setNotice('代理操作完成');
              else if (label === 'config') setNotice('模型配置已检查并应用');
              else if (label === 'models') setNotice('模型列表已刷新');
              else if (label === 'settings') setNotice('设置已保存');
            }
          }
        } catch (cause) {
          setError('操作失败：' + String(cause && cause.message ? cause.message : cause));
        } finally {
          if (alive.current) setBusy('');
        }
      }, [applyStatus, refresh]);

      const state = status !== null && status.state !== undefined ? status.state : {};
      const proxy = status !== null && status.proxy !== undefined ? status.proxy : {};
      const endpoint = status !== null && status.endpoint !== undefined ? status.endpoint : {};
      const settings = status !== null && status.settings !== undefined ? status.settings : {};

      const loggedIn = state.hasToken === true && Number(state.expiresAt) > Date.now();
      const loginBadge = loggedIn ? badge('已登录', 'ok') : state.hasToken === true ? badge('令牌已过期', 'warn') : badge('未登录', 'off');
      const proxyMode = String(proxy.mode || 'stopped');
      const proxyBadge =
        proxyMode === 'running' ? badge('运行中', 'ok')
          : proxyMode === 'adopted' ? badge('接管外部实例', 'ok')
            : proxyMode === 'failed' ? badge('启动失败', 'err')
              : badge('已停止', 'off');
      const models = Array.isArray(proxy.models) && proxy.models.length > 0
        ? proxy.models
        : Array.isArray(state.models) ? state.models : [];
      const activeModel = String(endpoint.modelId || '');

      const doLogin = () => run('login', () => call('/login', { username, password }));
      const doSave = () => run('save', () => call('/save', { username, password }));
      const doForget = () => run('forget', () => call('/forget', {}));
      const doLogout = () => run('logout', () => call('/logout', {}));
      const doProxy = (action) => run('proxy', () => call('/proxy', { action }));
      const doConfig = () => run('config', () => call('/apply-config', {}));
      const doModels = () => run('models', () => call('/refresh-models', {}));
      const doToggle = (key, value) => run('settings', () => call('/settings', { [key]: value }));

      const cards = [];

      cards.push(jsx('div', { className: 'hn-head', key: 'head', children: [
        jsx('h2', { children: zh.title, key: 'h' }),
        jsx('p', { children: zh.subtitle, key: 'p' }),
      ] }));

      if (error !== '') cards.push(jsx('div', { className: 'hn-alert err', key: 'err', children: error }));
      if (notice !== '') cards.push(jsx('div', { className: 'hn-alert ok', key: 'ok', children: notice }));
      if (status === null) {
        cards.push(jsx('div', { className: 'hn-alert info', key: 'loading', children: '正在读取状态…' }));
      }

      // 1. 状态
      cards.push(jsx('div', { className: 'hn-card', key: 'status', children: [
        jsx('h3', { children: '状态', key: 't' }),
        jsx('div', { className: 'hn-rows', key: 'r', children: [
          jsx('div', { className: 'hn-row', key: 'login', children: [
            jsx('span', { className: 'hn-k', children: '登录', key: 'k' }),
            loginBadge,
            jsx('span', { className: 'hn-v', key: 'v', children: state.displayName ? '（' + state.displayName + '）' : '' }),
          ] }),
          jsx('div', { className: 'hn-row', key: 'token', children: [
            jsx('span', { className: 'hn-k', children: '令牌' }),
            jsx('span', { className: 'hn-v', key: 'v', children: state.hasToken === true ? fmtLeft(state.expiresAt) : '无' }),
          ] }),
          jsx('div', { className: 'hn-row', key: 'proxy', children: [
            jsx('span', { className: 'hn-k', children: '代理' }),
            proxyBadge,
            jsx('span', { className: 'hn-v mono', key: 'v', children: String(proxy.baseURL || endpoint.baseURL || '—') }),
          ] }),
          jsx('div', { className: 'hn-row', key: 'model', children: [
            jsx('span', { className: 'hn-k', children: '模型' }),
            jsx('span', { className: 'hn-v mono', key: 'v', children: models.length > 0 ? models.join(', ') : '未获取' }),
          ] }),
        ] }),
      ] }));

      // 2. 账号
      cards.push(jsx('div', { className: 'hn-card', key: 'account', children: [
        jsx('h3', { children: '账号', key: 't' }),
        jsx('div', { className: 'hn-form', key: 'f', children: [
          jsx('div', { className: 'hn-field', key: 'u', children: [
            jsx('label', { children: '学号 / 工号', key: 'l' }),
            jsx('input', {
              value: username,
              placeholder: '例如 20230001',
              autoComplete: 'username',
              onChange: (event) => {
                setTouchedName(true);
                setUsername(event.target.value);
              },
              key: 'i',
            }),
          ] }),
          jsx('div', { className: 'hn-field', key: 'p', children: [
            jsx('label', { children: '密码', key: 'l' }),
            jsx('input', {
              type: 'password',
              value: password,
              placeholder: state.hasPassword === true ? '已保存密码，留空表示沿用' : '统一身份认证密码',
              autoComplete: 'current-password',
              onChange: (event) => setPassword(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && busy === '') doLogin();
              },
              key: 'i',
            }),
          ] }),
          jsx('div', { className: 'hn-actions', key: 'a', children: [
            jsx('button', { className: 'hn-btn primary', disabled: busy !== '', onClick: doLogin, key: 'login',
              children: busy === 'login' ? '登录中…' : '保存并登录' }),
            jsx('button', { className: 'hn-btn', disabled: busy !== '', onClick: doSave, key: 'save',
              children: busy === 'save' ? '保存中…' : '仅保存' }),
            jsx('button', { className: 'hn-btn', disabled: busy !== '' || state.hasToken !== true, onClick: doLogout, key: 'logout',
              children: '退出登录' }),
            jsx('button', { className: 'hn-btn danger', disabled: busy !== '', onClick: doForget, key: 'forget',
              children: '清除已保存' }),
          ] }),
          jsx('div', { className: 'hn-note', key: 'note', children: state.hasPassword === true
            ? '密码已用系统密钥加密保存，只在后台登录时使用，不会回显。'
            : '密码只用于后台登录学校门户，加密保存在本机。' }),
        ] }),
      ] }));

      // 3. 代理与模型
      cards.push(jsx('div', { className: 'hn-card', key: 'proxy', children: [
        jsx('h3', { children: '代理与模型', key: 't' }),
        jsx('div', { className: 'hn-actions', key: 'a', children: [
          jsx('button', { className: 'hn-btn', disabled: busy !== '', onClick: () => doProxy(proxyMode === 'running' || proxyMode === 'adopted' ? 'stop' : 'start'), key: 'p',
            children: proxyMode === 'running' || proxyMode === 'adopted' ? '停止代理' : '启动代理' }),
          jsx('button', { className: 'hn-btn', disabled: busy !== '', onClick: () => doProxy('restart'), key: 'r', children: '重启代理' }),
          jsx('button', { className: 'hn-btn', disabled: busy !== '', onClick: doConfig, key: 'c', children: '重新应用模型配置' }),
          jsx('button', { className: 'hn-btn', disabled: busy !== '', onClick: doModels, key: 'm', children: '刷新模型' }),
        ] }),
        jsx('div', { className: 'hn-sep', key: 's' }),
        kv([
          ['baseURL', jsx('span', { className: 'mono', children: String(endpoint.baseURL || '—') })],
          ['apiKey', jsx('span', { className: 'mono', children: String(endpoint.apiKey || '—') })],
          ['provider', String(endpoint.providerId || '—')],
          ['profile', String(settings.profile || '—')],
        ]),
        jsx('div', { className: 'hn-sep', key: 's2' }),
        jsx('div', { className: 'hn-models', key: 'ml', children: models.length === 0
          ? jsx('span', { className: 'hn-note', children: '还没有拿到模型列表，登录后可点「刷新模型」' })
          : models.map((id) => jsx('span', { className: 'hn-chip' + (id === activeModel ? ' on' : ''), children: id }, id)) }),
        proxy.lastError ? jsx('div', { className: 'hn-alert err', key: 'pe', style: { marginTop: '10px' }, children: '代理错误：' + String(proxy.lastError) }) : null,
      ] }));

      // 4. 开关
      cards.push(jsx('div', { className: 'hn-card', key: 'opts', children: [
        jsx('h3', { children: '启动行为', key: 't' }),
        jsx('div', { className: 'hn-rows', key: 'r', children: [
          jsx('label', { className: 'hn-toggle', key: 'al', children: [
            jsx('input', {
              type: 'checkbox',
              checked: state.autoLogin !== false,
              disabled: busy !== '',
              onChange: (event) => doToggle('autoLogin', event.target.checked),
              key: 'i',
            }),
            jsx('span', { children: 'DSH 启动时自动登录（需要已保存密码）', key: 's' }),
          ] }),
          jsx('label', { className: 'hn-toggle', key: 'as', children: [
            jsx('input', {
              type: 'checkbox',
              checked: state.autoStart !== false,
              disabled: busy !== '',
              onChange: (event) => doToggle('autoStart', event.target.checked),
              key: 'i',
            }),
            jsx('span', { children: 'DSH 启动时自动启动本地代理', key: 's' }),
          ] }),
        ] }),
      ] }));

      // 5. 诊断
      if (state.lastError || state.configNote || settings.upstream) {
        const rows = [];
        if (settings.upstream) rows.push(['上游', jsx('span', { className: 'mono', children: String(settings.upstream) })]);
        if (state.lastLoginAt) rows.push(['上次登录', fmtTime(state.lastLoginAt)]);
        if (state.configAppliedAt) rows.push(['配置时间', fmtTime(state.configAppliedAt)]);
        if (state.configNote) rows.push(['配置结果', String(state.configNote)]);
        cards.push(jsx('div', { className: 'hn-card', key: 'diag', children: [
          jsx('h3', { children: '诊断', key: 't' }),
          rows.length > 0 ? kv(rows) : null,
          state.lastError ? jsx('div', { className: 'hn-alert err', key: 'le', style: { marginTop: '10px' }, children: String(state.lastError) }) : null,
        ] }));
      }

      return jsx('div', { className: 'hn-root', children: jsx('div', { className: 'hn-wrap', children: cards }) });
    }

    /* --------------------------------------------------------------- 插件面 */

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        if (ctx.effect !== undefined && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const tag = ensureStyle();
            return () => {
              try {
                if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
              } catch {
                /* 已经摘掉了 */
              }
            };
          }, 'dsh-hainnu: stylesheet');
        } else {
          ensureStyle();
        }
      } catch (error) {
        console.warn('[dsh-hainnu] 样式初始化失败，面板会以无样式形式渲染：', error);
      }

      try {
        if (
          ctx.locale !== undefined &&
          ctx.locale !== null &&
          typeof ctx.locale.register === 'function' &&
          typeof ctx.effect === 'function'
        ) {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hainnu: dictionaries');
        }
      } catch (error) {
        console.warn('[dsh-hainnu] 词典注册失败，回退到内置中文：', error);
      }

      try {
        if (ctx.slots === undefined || ctx.slots === null || typeof ctx.slots.register !== 'function') {
          console.warn('[dsh-hainnu] 没有 slot registry，左侧栏入口不会出现');
          return;
        }
        const registerMain = () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, HainnuPanel);
        const registerEntry = () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 0, locale: NS, label: () => zh.panel },
            HainnuIcon,
          );
        if (typeof ctx.slots.inject === 'function') {
          ctx.slots.inject('main', registerMain);
          ctx.slots.inject('sidebar.panellist', registerEntry);
        } else {
          registerMain();
          registerEntry();
        }
      } catch (error) {
        console.warn('[dsh-hainnu] 左侧栏入口注册失败：', error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试面：模块系统只读 apply / inject。
    exports.HainnuPanel = HainnuPanel;
    exports.HainnuIcon = HainnuIcon;
    exports.NS = NS;
    exports.ENDPOINT = ENDPOINT;
    exports.PANEL_ID = PANEL_ID;
    exports.CSS_TAG = CSS_TAG;
    exports.CSS = CSS;
    exports.zh = zh;
    exports.en = en;
    exports.call = call;
    return module.exports;
  },
});
