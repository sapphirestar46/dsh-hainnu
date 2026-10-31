/**
 * 客户端半边的离线冒烟测试：用桩模块系统执行 client.js，
 * 断言 slot 注册形状、词典、以及面板能渲染出中文文案。
 *
 *   node test/client-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8');

/* ---------------------------------------------------------------- react 桩 */

let hookState = [];
let hookIndex = 0;
const reactStub = {
  useState(initial) {
    const slot = hookIndex++;
    if (hookState[slot] === undefined) hookState[slot] = typeof initial === 'function' ? initial() : initial;
    return [hookState[slot], (next) => { hookState[slot] = next; }];
  },
  useEffect() { hookIndex++; },
  useRef(initial) {
    const slot = hookIndex++;
    if (hookState[slot] === undefined) hookState[slot] = { current: initial };
    return hookState[slot];
  },
  useCallback(fn) { hookIndex++; return fn; },
  useMemo(fn) { hookIndex++; return fn(); },
};

function jsx(type, props) {
  return { type, props: props || {} };
}

const moduleTable = {
  react: reactStub,
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
};

/* ------------------------------------------------------- 模块系统桩 */

let loaded = null;
const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

const code = source;
const factory = new Function('window', 'require', 'console', `${code}\nreturn window.__ModuleLoader__;`);
const loader = factory(windowStub, (id) => {
  if (moduleTable[id] === undefined) throw new Error(`unexpected require: ${id}`);
  return moduleTable[id];
}, console);
assert.equal(loader.load !== undefined, true);

const definition = loaded;
assert.equal(definition.id, 'dsh-hainnu');
const mod = definition.factory((id) => {
  if (moduleTable[id] === undefined) throw new Error(`unexpected require: ${id}`);
  return moduleTable[id];
});

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(['PASS', label]);
  } catch (error) {
    results.push(['FAIL', `${label} :: ${error.message}`]);
  }
}

check('导出 apply / inject', () => {
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots', 'locale']);
});

const registrations = [];
const injected = [];
let styleApplied = 0;
let dictionaries = 0;
const ctx = {
  effect(fn, label) {
    styleApplied += 1;
    return fn();
  },
  locale: {
    register(namespace, tables) {
      dictionaries += 1;
      assert.equal(namespace, 'hainnu');
      assert.equal(typeof tables.zh.panel, 'string');
      assert.equal(typeof tables.en.panel, 'string');
    },
    bind() {
      return (key) => key;
    },
  },
  slots: {
    register(descriptor, component) {
      registrations.push([descriptor, component]);
      return () => {};
    },
    inject(name, register) {
      injected.push(name);
      register();
    },
  },
};

check('apply 不抛异常并完成注册', () => {
  mod.apply(ctx);
});

check('样式与词典都通过 ctx.effect 托管', () => {
  assert.equal(dictionaries, 1);
  assert.ok(styleApplied >= 1);
});

check('注册了 main 与 sidebar.panellist 两个 slot', () => {
  assert.deepEqual(injected, ['main', 'sidebar.panellist']);
  assert.equal(registrations.length, 2);
});

check('左侧栏入口 id 与主面板 key 一致，order=0，中文标签', () => {
  const entry = registrations.find(([descriptor]) => descriptor.name === 'sidebar.panellist');
  const main = registrations.find(([descriptor]) => descriptor.name === 'main');
  assert.ok(entry !== undefined, '没有 sidebar.panellist');
  assert.ok(main !== undefined, '没有 main');
  assert.equal(entry[0].id, mod.PANEL_ID);
  assert.equal(main[0].key, mod.PANEL_ID);
  assert.equal(entry[0].order, 0);
  assert.equal(entry[0].label(), '海师账号');
  assert.equal(typeof entry[1], 'function');
  assert.equal(typeof main[1], 'function');
});

check('侧栏图标能渲染出 svg', () => {
  const icon = mod.HainnuIcon({ size: 20 });
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.width, 20);
  assert.ok(Array.isArray(icon.props.children));
});

check('面板首次渲染（无状态）不崩溃且是中文界面', () => {
  hookState = [];
  hookIndex = 0;
  const tree = mod.HainnuPanel();
  const text = JSON.stringify(tree);
  assert.match(text, /海师账号/);
  assert.match(text, /学号/);
  assert.match(text, /保存并登录/);
  assert.match(text, /启动行为/);
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'hn-root');
});

check('样式表只用主题 token，不含写死颜色', () => {
  const css = mod.CSS || '';
  assert.match(css, /\.hn-root/);
  assert.match(css, /--dsw-alias-label-primary/);
  assert.match(css, /--dsw-alias-settings-card-fill/);
  // 规则：颜色只能来自主题 token（图标等 artwork 例外，不在这段 CSS 里）
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(css), false, '出现了写死的十六进制颜色');
  assert.equal(/rgba?\(/.test(css), false, '出现了写死的 rgb() 颜色');
});

check('热力图：固定窗口、无横向滚动、绿色刻度', () => {
  const css = mod.CSS || '';
  // 不再有可横向滚动的容器
  assert.equal(/hn-heat-scroll/.test(css), false, '仍然存在横向滚动容器');
  assert.match(css, /\.hn-heat-wrap \{[^}]*overflow: hidden/);
  // 列数由容器宽度算出，最新一天贴右
  assert.match(css, /grid-template-columns: repeat\(var\(--cols/);
  assert.match(css, /\.hn-heat \{[^}]*justify-content: end/);
  // 热度用绿色，不是品牌蓝/灰度
  for (const level of ['l1', 'l2', 'l3', 'l4']) {
    // 小格与每周柱子共用同一档：.hn-cell.lN, .hn-bar.lN { ... }
    const rule = new RegExp('\\.hn-cell\\.' + level + '[^{]*\\{([^}]*)\\}');
    const match = css.match(rule);
    assert.ok(match !== null, '缺少 ' + level + ' 规则');
    assert.match(match[1], /state-success-primary/, level + ' 不是绿色');
  }
});

check('ENDPOINT 指向宿主挂载前缀', () => {
  assert.equal(mod.ENDPOINT, '/dsh-hainnu');
});


/* 可用模型卡片：桩 fetch + 真实 effect，验证宿主的 models 字段能渲染出简介与能力标签 */
{
  const payload = {
    ok: true,
    state: { hasToken: true, hasPassword: true, username: '20230001', models: ['deepseek-flash'] },
    endpoint: { baseURL: 'http://127.0.0.1:8787/v1', modelId: 'deepseek-flash' },
    proxy: { mode: 'running', baseURL: 'http://127.0.0.1:8787/v1', models: ['deepseek-flash', 'kimi-k3'], portal: { enabled: true, threads: 0 } },
    portal: { enabled: true, loggedIn: true, models: [] },
    settings: { profile: 'desktop', upstream: 'https://chat.hainnu.edu.cn', apiKeyEnv: 'HAINNU_API_KEY' },
    security: { allowRemote: false, allowAnonymous: false, apiAuth: 'keys', loginGuard: {}, originGuard: true },
    usage: null,
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash (海师自部署)', source: '海师自部署', contextWindow: 300000, maxTokens: 80000, requestLimitBytes: 1048576, requestLimitLabel: '1 MB', tools: 'native', vision: true, summary: '唯一能看图的模型', notes: ['支持图片输入'] },
      { id: 'kimi-k3', name: 'Kimi K3 (海师阿里云)', source: '海师阿里云', contextWindow: 1000000, maxTokens: 8192, tools: 'emulated', vision: false, summary: '偏思考的重型模型', notes: ['不支持图片'] },
    ],
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });

  const originalEffect = reactStub.useEffect;
  reactStub.useEffect = (fn) => {
    hookIndex += 1;
    try { fn(); } catch { /* 计时器/清理函数失败不影响断言 */ }
  };
  hookState = [];
  hookIndex = 0;
  mod.HainnuPanel();
  await new Promise((resolve) => setTimeout(resolve, 30));
  hookIndex = 0;
  const tree = mod.HainnuPanel();
  reactStub.useEffect = originalEffect;

  const text = JSON.stringify(tree);
  assert.match(text, /可用模型/);
  assert.match(text, /唯一能看图的模型/);
  assert.match(text, /支持图片/);
  assert.match(text, /原生工具调用/);
  assert.match(text, /模拟工具调用/);
  // 自部署那个要标「请求体上限 1 MB」，不能写成上下文
  assert.match(text, /请求体上限 1 MB/);
  assert.equal(/上下文 300,000/.test(text), false, '自部署模型不该显示成上下文上限');
  results.push(['PASS', '可用模型卡片渲染出简介与能力标签']);
}

let failed = 0;
for (const [kind, label] of results) {
  if (kind === 'FAIL') failed += 1;
  console.log(`${kind === 'PASS' ? '  ok ' : 'FAIL '} ${label}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
