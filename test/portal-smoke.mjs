/**
 * portal.js / models.js 冒烟：消息拍平、文本抽取、前缀散列、门户目录发现、鉴权错误映射。
 *
 * 这里起一个本地 http 桩来冒充海师大智汇，不碰真实学校服务。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { PortalClient, PortalError, flattenMessages, hashMessages, messageText } from '../lib/portal.js';
import { PORTAL_MODELS, allModels, isPortalModel, modelById } from '../lib/models.js';
import { HainnuProxy, buildToolPrompt, looksLikePlan, looksLikePlatformError, parseToolCall, wantsThinking } from '../lib/proxy.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
}

/* ------------------------------------------------------------ 纯函数部分 */

ok('messageText 认字符串与分片数组', () => {
  assert.equal(messageText('  你好  '), '你好');
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(messageText(null), '');
});

ok('flattenMessages 把 system 和上文压成一段', () => {
  const text = flattenMessages([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
  assert.match(text, /你是助手/);
  assert.match(text, /用户：第一问/);
  assert.match(text, /助手：第一答/);
  assert.match(text, /用户：第二问/);
  // 最后一条只出现一次，不能既在记录里又在结尾
  assert.equal(text.split('第二问').length - 1, 1);
});

ok('flattenMessages 单轮不带历史抬头', () => {
  const text = flattenMessages([{ role: 'user', content: '只问一句' }]);
  assert.equal(text, '用户：只问一句');
});

ok('hashMessages 稳定且对内容敏感', () => {
  const a = hashMessages([{ role: 'user', content: 'x' }]);
  const b = hashMessages([{ role: 'user', content: 'x' }]);
  const c = hashMessages([{ role: 'user', content: 'y' }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

/* -------------------------------------------------------------- 模型目录 */

ok('模型目录：四个模型，两个来源', () => {
  const list = allModels();
  assert.equal(list.length, 4);
  assert.equal(modelById('deepseek-flash').upstream, 'local');
  assert.equal(isPortalModel('kimi-k3'), true);
  assert.equal(isPortalModel('deepseek-flash'), false);
  assert.equal(isPortalModel('nope'), false);
  assert.equal(list.filter((m) => m.upstream === 'portal').length, 3);
  for (const model of PORTAL_MODELS) assert.match(model.name, /海师阿里云/);
  const local = modelById('deepseek-flash');
  assert.match(local.name, /海师自部署/);
  // 和 DSH 官方给 DeepSeek Flash 挂的 1017 发行标对齐
  assert.equal(local.build, '1017');
  assert.match(local.name, /1017/);
});

/* ------------------------------------------------------------ 代理路由 */

ok('代理模型清单合并两个上游', () => {
  const withPortal = new HainnuProxy({ portal: { fake: true } });
  withPortal.modelCache.ids = ['deepseek-flash'];
  assert.deepEqual(withPortal.mergedModelIds(), ['deepseek-flash', 'kimi-k3', 'qwen3.8-flash', 'deepseek-v4.1-flash']);
  const localOnly = new HainnuProxy({});
  assert.deepEqual(localOnly.mergedModelIds(), ['deepseek-flash']);
});

// 异步用例：ok() 是同步计数，这里单独走 await 再计分。
{
  const opened = [];
  const fakePortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async (appId) => {
      opened.push(appId);
      return 'conv-' + opened.length;
    },
  };
  const proxy = new HainnuProxy({ portal: fakePortal });
  const messages = [{ role: 'user', content: '你好' }];

  const first = await proxy.preparePortalTurn({ id: 'kimi-k3', maxTokens: 8192 }, messages, false);
  assert.equal(first.conversationId, 'conv-1');
  assert.equal(first.prompt.includes('直接给出最终答复'), false);

  const retry = await proxy.preparePortalTurn({ id: 'kimi-k3', maxTokens: 8192 }, messages, false, { fresh: true, nudge: true });
  assert.equal(retry.conversationId, 'conv-2');
  assert.match(retry.prompt, /直接给出最终答复/);

  console.log('  ok  空回复重试：fresh 换新会话并追加「直接给结论」提示');
  passed += 1;
}

// 思考开关与平台异常正文的判定
{
  assert.equal(wantsThinking({ reasoning_effort: 'none' }), false);
  assert.equal(wantsThinking({ reasoning_effort: 'max' }), true);
  assert.equal(wantsThinking({ thinking: { type: 'disabled' } }), false);
  assert.equal(wantsThinking({ enable_thinking: false }), false);
  assert.equal(wantsThinking({}), undefined);
  assert.equal(wantsThinking(null), undefined);
  assert.equal(wantsThinking({ reasoning: { effort: 'low' } }), true);

  assert.equal(looksLikePlatformError('Exception:Error code'), true);
  assert.equal(looksLikePlatformError('  Error code: 400  '), true);
  assert.equal(looksLikePlatformError('收到'), false);
  assert.equal(looksLikePlatformError(''), false);

  console.log('  ok  思考开关判定 / 平台异常正文识别');
  passed += 1;
}

// 工具协议：提示词生成 + 解析
{
  const prompt = buildToolPrompt([
    { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ]);
  assert.match(prompt, /- read：读文件/);
  assert.match(prompt, /<tool_call>/);
  assert.equal(buildToolPrompt([]), '');
  assert.equal(buildToolPrompt([{ type: 'text' }]), '');

  // DSH 实际发的是扁平形状，也要认
  const flatPrompt = buildToolPrompt([
    { name: 'run_code', description: '执行 TypeScript', parameters: { type: 'object', properties: { code: { type: 'string' } } } },
  ]);
  assert.match(flatPrompt, /- run_code：执行 TypeScript/);
  assert.match(flatPrompt, /"code"/);

  assert.deepEqual(parseToolCall('<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>'), {
    name: 'read',
    arguments: '{"path":"a"}',
  });
  // arguments 是字符串时再解一层
  assert.deepEqual(parseToolCall('<tool_call>{"name":"x","arguments":"{\\"a\\":1}"}</tool_call>').arguments, '{"a":1}');
  assert.equal(parseToolCall('普通回答，没有调用'), null);
  assert.equal(parseToolCall('<tool_call>not json</tool_call>'), null);
  assert.equal(parseToolCall('<tool_call>{"arguments":{}}</tool_call>'), null);
  // qwen 偶尔把开标记写两遍；也有模型漏掉闭标记
  assert.deepEqual(parseToolCall('<tool_call>\n<tool_call>\n{"name":"x","arguments":{}}</tool_call>'), {
    name: 'x',
    arguments: '{}',
  });
  assert.deepEqual(parseToolCall('<tool_call>{"name":"y","arguments":{"a":1}}'), { name: 'y', arguments: '{"a":1}' });

  console.log('  ok  工具提示词与 tool_call 解析');
  passed += 1;
}

// 工具结果拍平：不要伪装成用户发言
{
  const text = flattenMessages([
    { role: 'user', content: '读一下' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
  ]);
  assert.match(text, /助手：\[调用工具 read\(\{"path":"a"\}\)\]/);
  assert.match(text, /工具结果：文件内容/);

  console.log('  ok  工具结果拍平');
  passed += 1;
}

// 只说不做的「计划」判定
{
  assert.equal(looksLikePlan('我先查看一下工作区结构。'), true);
  assert.equal(looksLikePlan('好的，我来检查插件代码。'), true);
  assert.equal(looksLikePlan('让我先了解一下项目。'), true);
  assert.equal(looksLikePlan('已经改好了，文件在 lib/proxy.js。'.repeat(10)), false);
  assert.equal(looksLikePlan(''), false);
  console.log('  ok  只说不做的计划判定');
  passed += 1;
}

/* --------------------------------------------------- 桩服务：目录与鉴权 */

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const stub = await startStub((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, value) => {
    const text = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (url.pathname === '/portal/api/public/config') {
    return send(200, { code: 200, data: { id: 'portal-1', name: '海师大智汇' } });
  }
  if (url.pathname === '/portal/api/public/portal-1/app') {
    return send(200, {
      code: 200,
      data: [
        { id: 'a', application_id: 'app-plain', is_router: false },
        { id: 'b', application_id: 'app-router', is_router: true },
      ],
    });
  }
  if (url.pathname === '/portal/api/public/portal-1/model') {
    return send(200, {
      code: 200,
      data: [
        { model_name: 'kimi-k3', model_id: 'real-kimi' },
        { model_name: 'qwen3.8-flash', model_id: 'real-qwen' },
      ],
    });
  }
  if (url.pathname === '/portal/api/public/secret') {
    return send(401, { code: 401, message: '未授权' });
  }
  return send(404, { code: 404, message: 'not found' });
});

try {
  const origin = `http://127.0.0.1:${stub.port}`;
  const client = new PortalClient({ origin, getToken: async () => 'tok' });

  const catalog = await client.describe();
  assert.equal(catalog.portalId, 'portal-1');
  assert.equal(catalog.applicationId, 'app-router');
  assert.equal(catalog.platformIds['kimi-k3'], 'real-kimi');
  assert.equal(catalog.platformIds['qwen3.8-flash'], 'real-qwen');
  // 桩里没返回的模型沿用兜底 id
  assert.equal(catalog.platformIds['deepseek-v4.1-flash'], '01a0cd8c-9fd4-7e01-9dd2-267d89bd9210');

  const cached = await client.describe();
  assert.equal(cached, catalog);

  await assert.rejects(
    () => client.json('/portal/api/public/secret'),
    (error) => error instanceof PortalError && error.code === 'portal_auth',
  );

  await assert.rejects(
    () => new PortalClient({ origin, getToken: async () => '' }).describe(),
    (error) => error instanceof PortalError && error.code === 'portal_auth',
  );

  console.log('  ok  目录发现 / 缓存 / 鉴权错误映射');
  passed += 1;
} finally {
  stub.server.close();
}

console.log(`\n${passed}/${passed} 通过`);
