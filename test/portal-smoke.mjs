/**
 * portal.js / models.js 冒烟：消息拍平、文本抽取、前缀散列、门户目录发现、鉴权错误映射。
 *
 * 这里起一个本地 http 桩来冒充海师大智汇，不碰真实学校服务。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  PortalClient,
  PortalError,
  classifyUpstream,
  flattenMessages,
  hashMessages,
  messageText,
  upstreamDetail,
  upstreamFailure,
} from '../lib/portal.js';
import { PORTAL_MODELS, allModels, isPortalModel, modelById } from '../lib/models.js';
import {
  HainnuProxy,
  RESCUE_NUDGE,
  buildToolPrompt,
  lastSentence,
  looksLikeIntentTail,
  looksLikePlan,
  looksLikePlatformError,
  parseDsmlCalls,
  parseToolCall,
  recentToolActivity,
  wantsThinking,
} from '../lib/proxy.js';

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
  // 阿里云那个拿不到版本依据，不标 1017
  const portalDs = modelById('deepseek-v4.1-flash');
  assert.equal(portalDs.build, undefined);
  assert.equal(/1017/.test(portalDs.name), false);
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
  // 「好的 / Sure」只是附和：后面没有动手意图时不能当成计划句
  assert.equal(looksLikePlan('好的，我已完成修改，文件在 lib/proxy.js。'), false);
  assert.equal(looksLikePlan('Sure, done.'), false);
  assert.equal(looksLikePlan('好的，我先看看 README 再改。'), true);
  assert.equal(looksLikePlan('已经改好了，文件在 lib/proxy.js。'.repeat(10)), false);
  assert.equal(looksLikePlan(''), false);
  console.log('  ok  只说不做的计划判定');
  passed += 1;
}

// DSH 原生 DSML 工具调用：模型在 DSH 系统提示下会写这套格式
{
  const one = [
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="run_code">',
    '<｜DSML｜ parameter name="description" string="true">写个文件</｜DSML｜ parameter>',
    '<｜DSML｜ parameter name="code" string="true">const html = "x";</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('\n');
  const calls = parseDsmlCalls(one);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'run_code');
  const args = JSON.parse(calls[0].arguments);
  assert.equal(args.description, '写个文件');
  assert.equal(args.code, 'const html = "x";');

  // 半角竖线也认
  const ascii = '<|DSML| invoke name="read">\n<|DSML| parameter name="path" string="true">a.txt</|DSML| parameter>\n</|DSML| invoke>';
  assert.equal(parseDsmlCalls(ascii)[0].name, 'read');
  assert.equal(JSON.parse(parseDsmlCalls(ascii)[0].arguments).path, 'a.txt');

  // 非字符串参数按 JSON 解析
  const num = '<|DSML| invoke name="f">\n<|DSML| parameter name="n" string="false">42</|DSML| parameter>\n</|DSML| invoke>';
  assert.equal(JSON.parse(parseDsmlCalls(num)[0].arguments).n, 42);

  // 漏了闭标记也能抽（截断场景）
  const broken = '<|DSML| invoke name="run_code">\n<|DSML| parameter name="code" string="true">console.log(1)';
  const brokenCalls = parseDsmlCalls(broken);
  assert.equal(brokenCalls.length, 1);
  assert.equal(brokenCalls[0].name, 'run_code');

  // parseToolCall 两种协议都能抽
  assert.equal(parseToolCall(one).name, 'run_code');
  assert.equal(parseToolCall('<tool_call>{"name":"read","arguments":{}}</tool_call>').name, 'read');
  assert.equal(parseToolCall('普通回答'), null);

  console.log('  ok  DSML 工具调用解析');
  passed += 1;
}

// 端到端：平台模型吐 DSML 文本 → 代理转成标准 tool_calls
{
  const fakePortal = {
    token: async () => 't',
    describe: async () => ({ applicationId: 'app', platformIds: { 'kimi-k3': 'p' } }),
    openConversation: async () => 'conv',
    streamChat: async (options) => {
      options.onDelta({ content: '<|DSML| invoke name="read">\n<|DSML| parameter name="path" string="true">a.txt</|DSML| parameter>\n</|DSML| invoke>', reasoning: '' });
      return { content: '', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
    },
  };
  const proxy = new HainnuProxy({ port: 0, acceptKeys: () => ['k'], getToken: () => '', portal: fakePortal });
  proxy.modelCache.ids = ['deepseek-flash'];
  const port = 18000 + Math.floor(Math.random() * 1500);
  proxy.config.port = port;
  await proxy.listen(port);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({
      model: 'kimi-k3', stream: true,
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [{ role: 'user', content: '读一下 a.txt' }],
    }),
  });
  const text = await res.text();
  let calls = [];
  let finish = null;
  for (const raw of text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6))) {
    if (raw === '[DONE]') continue;
    let f; try { f = JSON.parse(raw); } catch { continue; }
    const c = f.choices && f.choices[0];
    if (!c) continue;
    if (c.delta && Array.isArray(c.delta.tool_calls)) calls = calls.concat(c.delta.tool_calls);
    if (c.finish_reason) finish = c.finish_reason;
  }
  // 关掉 keep-alive 连接，否则 server.close 会一直等
  const server = proxy.server;
  if (server !== null && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await proxy.stop().catch(() => {});
  assert.equal(finish, 'tool_calls', 'DSML 没被转成 tool_calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read');
  assert.equal(JSON.parse(calls[0].function.arguments).path, 'a.txt');

  console.log('  ok  端到端：DSML → tool_calls');
  passed += 1;
}

// 提前收尾判定（参考社区项目 kimi-for-dsh 的规则）
{
  assert.equal(lastSentence('先看目录。\n让我运行一下 ls'), '让我运行一下 ls');
  assert.equal(lastSentence('Let me check the files. I will run it now.'), 'I will run it now.');
  assert.equal(lastSentence('   '), '');

  assert.equal(looksLikeIntentTail('Let me run the tests'), true);
  assert.equal(looksLikeIntentTail('接下来我去改一下配置'), true);
  assert.equal(looksLikeIntentTail('已全部完成，以上就是本次改动'), false);
  assert.equal(looksLikeIntentTail('Let me know if you need anything'), false);
  assert.equal(looksLikeIntentTail('如果你需要我可以继续'), false);
  assert.equal(looksLikeIntentTail('好的'), false);

  assert.equal(recentToolActivity([{ role: 'user', content: 'hi' }]), false);
  assert.equal(recentToolActivity([{ role: 'user', content: 'hi' }, { role: 'tool', content: 'ok' }]), true);
  assert.equal(recentToolActivity([{ role: 'assistant', tool_calls: [{ id: 'c' }] }]), true);
  assert.match(RESCUE_NUDGE, /auto-continue/);

  console.log('  ok  提前收尾判定（尾句意图 / 完结语气 / 工具活动）');
  passed += 1;
}

// 续接轮的自救：在同一条平台会话里追加续接指令，不重开会话
{
  const opened = [];
  const fakePortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async () => { opened.push(1); return 'conv-' + opened.length; },
  };
  const proxy = new HainnuProxy({ portal: fakePortal });
  const messages = [{ role: 'user', content: '改一下 README' }];
  const key = proxy.threadKeyFor('kimi-k3', messages);
  proxy.portalThreads.set(key, { conversationId: 'conv-existing', length: messages.length, hash: hashMessages(messages) });

  const appended = await proxy.preparePortalTurn({ id: 'kimi-k3', maxTokens: 8192 }, messages, false, { append: true });
  assert.equal(appended.conversationId, 'conv-existing');
  assert.equal(appended.prompt, RESCUE_NUDGE);
  assert.equal(appended.mode, 'continue');
  assert.equal(opened.length, 0, '续接不应新开会话');

  console.log('  ok  续接自救：同会话追加续接指令');
  passed += 1;
}
// 端到端：续接轮「只说不做」→ 同一会话追加续接指令 → 拿到工具调用
{
  const calls = [];
  let round = 0;
  const fakePortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async () => 'conv-e2e',
    streamChat: async (options) => {
      round += 1;
      calls.push({ prompt: options.message, conversationId: options.conversationId });
      if (round === 1) {
        // 第一轮：正常回答（建立会话线程）
        options.onDelta({ content: '好的，我已完成。', reasoning: '' });
        return { content: '好的，我已完成。', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
      }
      if (round === 2) {
        // 第二轮（续接）：只说了计划就停 —— 早收尾
        options.onDelta({ content: '我先查看一下仓库结构。', reasoning: '' });
        return { content: '我先查看一下仓库结构。', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
      }
      // 第三轮（自救续接）：按指令调工具
      options.onDelta({ content: '<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>', reasoning: '' });
      return { content: '', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
    },
  };
  const proxy = new HainnuProxy({ port: 0, acceptKeys: () => ['k'], getToken: () => '', portal: fakePortal });
  proxy.modelCache.ids = ['deepseek-flash'];
  const port = 18200 + Math.floor(Math.random() * 900);
  proxy.config.port = port;
  await proxy.listen(port);
  const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const post = async (messages) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'kimi-k3', stream: true, tools: TOOLS, messages }),
    });
    const text = await res.text();
    let got = [];
    let finish = null;
    for (const raw of text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6))) {
      if (raw === '[DONE]') continue;
      let f; try { f = JSON.parse(raw); } catch { continue; }
      const c = f.choices && f.choices[0];
      if (!c) continue;
      if (c.delta && Array.isArray(c.delta.tool_calls)) got = got.concat(c.delta.tool_calls);
      if (c.finish_reason) finish = c.finish_reason;
    }
    return { finish, calls: got };
  };

  const first = await post([{ role: 'user', content: '你好' }]);
  assert.equal(first.finish, 'stop');
  const second = await post([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '好的，我已完成。' },
    { role: 'user', content: '改一下 README' },
  ]);
  const server = proxy.server;
  if (server !== null && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await proxy.stop().catch(() => {});

  assert.equal(second.finish, 'tool_calls', '早收尾没有被救回来');
  assert.equal(second.calls.length, 1);
  assert.equal(calls.length, 3, '应该发生一次续接调用');
  assert.equal(calls[2].conversationId, 'conv-e2e', '续接必须在同一会话');
  assert.ok(calls[2].prompt.startsWith(RESCUE_NUDGE), '续接应发送续接指令而不是重发历史');
  assert.match(calls[2].prompt, /必须.*调用工具/, '续接末尾要再压一遍「必须动手」');

  console.log('  ok  端到端：续接轮早收尾 → 同会话追加续接 → tool_calls');
  passed += 1;
}

// 上游报错分类：把百炼/平台的文本翻成 DSH 认得的语义（上下文溢出 / 配额 / 限流）
{
  assert.equal(classifyUpstream('Range of input length should be [1, 1000000]').kind, 'context_overflow');
  assert.equal(classifyUpstream('Your request exceeded model token limit: 262144').kind, 'context_overflow');
  assert.equal(classifyUpstream("You've reached your usage limit for this period").kind, 'quota');
  assert.equal(classifyUpstream('The engine is currently overloaded').kind, 'overloaded');
  assert.equal(classifyUpstream('Too many requests, please slow down').kind, 'rate_limit');
  assert.equal(classifyUpstream('something else entirely').kind, 'upstream');

  assert.equal(upstreamDetail('{"code":400,"message":"Range of input length should be [1, 1000000]"}'), 'Range of input length should be [1, 1000000]');
  assert.equal(upstreamDetail('<html><body>bad gateway</body></html>'), 'bad gateway');

  const overflow = upstreamFailure(400, '{"code":"InvalidParameter","message":"Range of input length should be [1, 1000000]"}');
  assert.equal(overflow.kind, 'context_overflow');
  assert.equal(overflow.status, 400);
  assert.match(overflow.message, /context length exceeded/);
  assert.match(overflow.message, /Range of input length/);
  assert.match(overflow.message, /1000000/);

  const quota = upstreamFailure(429, "{\"message\":\"You've reached your usage limit for this period\"}");
  assert.equal(quota.kind, 'quota');
  assert.match(quota.message, /insufficient quota/);

  console.log('  ok  上游报错分类（上下文溢出 / 配额 / 限流）');
  passed += 1;
}

// 端到端：上游报错 → HTTP 状态与错误码跟着语义走（DSH 靠这些决定压缩还是终止）
{
  const state = { error: null };
  const fakePortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async () => 'conv-err',
    streamChat: async () => { throw state.error; },
  };
  const proxy = new HainnuProxy({ port: 0, acceptKeys: () => ['k'], getToken: () => '', portal: fakePortal });
  proxy.modelCache.ids = ['deepseek-flash'];
  const port = 19100 + Math.floor(Math.random() * 400);
  proxy.config.port = port;
  await proxy.listen(port);
  const call = async (options) => {
    const body = { model: 'kimi-k3', stream: options.stream === true, messages: [{ role: 'user', content: 'hi' }] };
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: res.status, text, json: parsed };
  };

  state.error = upstreamFailure(400, '{"code":"InvalidParameter","message":"Range of input length should be [1, 1000000]"}');
  const overflow = await call({});
  assert.equal(overflow.status, 400, '上下文溢出应当是 400，DSH 才会去压缩');
  assert.equal(overflow.json.error.code, 'context_window_exceeded');
  assert.match(overflow.json.error.message, /context length exceeded/);

  state.error = upstreamFailure(429, "{\"message\":\"You've reached your usage limit for this period\"}");
  const quota = await call({});
  assert.equal(quota.status, 429);
  assert.equal(quota.json.error.code, 'insufficient_quota');

  // 已经开始推流后才报错：状态码改不了，但必须发错误帧，不能静默 end()
  state.error = null;
  let thrown = false;
  const midPortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async () => 'conv-mid',
    streamChat: async (options) => {
      if (thrown) return { content: '', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
      thrown = true;
      // 要足够长，越过「可能是工具标记前缀」的保留尾巴，才会真的推一帧出去
      options.onDelta({ content: '我先看一下项目结构，然后再决定接下来怎么改。', reasoning: '' });
      throw upstreamFailure(429, "{\"message\":\"You've reached your usage limit for this period\"}");
    },
  };
  proxy.portal = midPortal;
  const mid = await call({ stream: true });
  assert.equal(mid.status, 200);
  assert.match(mid.text, /"error"/);
  assert.match(mid.text, /insufficient quota/);

  const server = proxy.server;
  if (server !== null && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await proxy.stop().catch(() => {});

  console.log('  ok  端到端：上游报错 → 400 / 429 / 流内错误帧');
  passed += 1;
}

// 计划句判定的精度/召回：21 条带标签样本（正例 = 只说不做，负例 = 已交付）
// 规则改动必须保持 precision / recall ≥ 0.9，否则自救会变成「多跑一轮」或「该救不救」。
{
  const samples = [
    { text: '我先看一下仓库结构。', tool: true, want: 1 },
    { text: '好的，我来检查插件代码。', tool: true, want: 1 },
    { text: '让我先了解一下项目。', tool: true, want: 1 },
    { text: 'Let me first locate the config file.', tool: true, want: 1 },
    { text: '接下来我去改一下 README。', tool: true, want: 1 },
    { text: '我先跑一遍测试，然后再改。', tool: true, want: 1 },
    { text: '现在先看看 package.json 里有没有 scripts。', tool: true, want: 1 },
    { text: '先检查一下依赖，再继续。', tool: true, want: 1 },
    { text: '我先看一下仓库结构。', tool: false, want: 1 },
    { text: '让我先了解一下项目。', tool: false, want: 1 },
    { text: '好的，我已完成修改，文件在 lib/proxy.js。', tool: true, want: 0 },
    { text: 'OK, done. The config was updated in cordis.patch.yml.', tool: true, want: 0 },
    { text: '以上就是本次改动的说明。', tool: true, want: 0 },
    { text: 'KV cache 是自回归生成时缓存 K/V 向量，避免重复计算，从而把每步注意力从 O(n^2) 降到 O(n)。', tool: false, want: 0 },
    { text: '我先说明一下：这个方案不行，因为平台不支持。', tool: true, want: 0 },
    { text: "Sure, I'll take a look tomorrow — but the short answer is no.", tool: true, want: 0 },
    { text: '让我总结一下：三个结论。', tool: true, want: 0 },
    { text: 'Let me know if you need anything.', tool: true, want: 0 },
    { text: '需要的话我继续。', tool: true, want: 0 },
    { text: '已全部完成，以上就是本次改动。', tool: true, want: 0 },
    { text: '先回答你的问题：这个报错是因为请求体超过 1 MB。', tool: false, want: 0 },
  ];
  let tp = 0; let fp = 0; let fn = 0;
  for (const sample of samples) {
    const got = looksLikePlan(sample.text) ? 1 : 0;
    if (got === 1 && sample.want === 1) tp += 1;
    else if (got === 1 && sample.want === 0) fp += 1;
    else if (got === 0 && sample.want === 1) fn += 1;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  assert.ok(recall >= 0.9, `召回太低 ${recall.toFixed(2)}：只说不做会被漏掉`);
  assert.ok(precision >= 0.9, `精度太低 ${precision.toFixed(2)}：正常收尾会被多跑一轮`);
  console.log(`  ok  计划句判定 ${samples.length} 条样本：precision ${precision.toFixed(2)} / recall ${recall.toFixed(2)}`);
  passed += 1;
}

// 首轮自救：用显式 conversationId 追加，不重发历史
{
  const opened = [];
  const fakePortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async () => { opened.push(1); return 'conv-new-' + opened.length; },
  };
  const proxy = new HainnuProxy({ portal: fakePortal });
  const messages = [{ role: 'user', content: '改一下 README' }];
  const turn = await proxy.preparePortalTurn({ id: 'kimi-k3', maxTokens: 8192 }, messages, false, { append: true, continueFrom: 'conv-first' });
  assert.equal(turn.conversationId, 'conv-first');
  assert.equal(turn.prompt, RESCUE_NUDGE);
  assert.equal(turn.mode, 'continue');
  assert.equal(opened.length, 0, '首轮自救不应新开会话');

  console.log('  ok  首轮自救：同会话追加（4739 vs 287 字符，不重发历史）');
  passed += 1;
}

// 端到端：首轮早收尾 → 第二轮追加到同一条会话（不是新会话重发）
{
  const calls = [];
  let round = 0;
  const fakePortal = {
    token: async () => 'tok',
    describe: async () => ({ applicationId: 'app-1', platformIds: { 'kimi-k3': 'p-kimi' } }),
    openConversation: async () => 'conv-first',
    streamChat: async (options) => {
      round += 1;
      calls.push({ prompt: options.message, conversationId: options.conversationId });
      if (round === 1) {
        options.onDelta({ content: '我先看一下仓库结构。', reasoning: '' });
        return { content: '我先看一下仓库结构。', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
      }
      options.onDelta({ content: '<tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>', reasoning: '' });
      return { content: '', reasoning: '', usage: null, nodeStatus: 'SUCCESS' };
    },
  };
  const proxy = new HainnuProxy({ port: 0, acceptKeys: () => ['k'], getToken: () => '', portal: fakePortal });
  proxy.modelCache.ids = ['deepseek-flash'];
  const port = 19600 + Math.floor(Math.random() * 300);
  proxy.config.port = port;
  await proxy.listen(port);
  const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: 'kimi-k3', stream: true, tools: TOOLS, messages: [{ role: 'user', content: '改一下 README' }] }),
  });
  const text = await res.text();
  let finish = null;
  for (const raw of text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6))) {
    if (raw === '[DONE]') continue;
    let f; try { f = JSON.parse(raw); } catch { continue; }
    const c = f.choices && f.choices[0];
    if (c && c.finish_reason) finish = c.finish_reason;
  }
  const server = proxy.server;
  if (server !== null && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await proxy.stop().catch(() => {});

  assert.equal(finish, 'tool_calls');
  assert.equal(calls.length, 2, '首轮自救应该只多打一轮');
  assert.equal(calls[0].conversationId, 'conv-first');
  assert.equal(calls[1].conversationId, 'conv-first', '自救必须接在同一条会话上');
  assert.ok(calls[1].prompt.startsWith(RESCUE_NUDGE), '自救应只发续接指令，不重发历史');
  assert.match(calls[1].prompt, /必须.*调用工具/, '自救末尾要再压一遍「必须动手」');

  console.log('  ok  端到端：首轮早收尾 → 同会话追加 → tool_calls');
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
// 端到端用例里起过监听端口，fetch 的 keep-alive 连接会把事件循环吊住，必须显式退出。
// 但不能立刻 exit：此时 libuv 正在关闭 http 监听句柄，Windows 上会和 process.exit 撞车
// 报 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 并把退出码变成 127。
await new Promise((resolve) => setTimeout(resolve, 300));
process.exit(0);
