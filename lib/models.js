/**
 * 插件对外暴露的模型目录。
 *
 * 上游有两条：
 *   - local   chat.hainnu.edu.cn（学校自部署的 Open WebUI，只有 deepseek-flash）
 *   - portal  hsaixy.hainnu.edu.cn（海师大智汇，底层阿里云百炼，三个模型）
 *
 * 两条上游都挂在同一个本地代理上，所以对 DSH 来说只有一个 provider，
 * 靠 model 名区分走向。名字里的「海师自部署」「海师阿里云」是给用户看的来源标注。
 *
 * contextWindow / maxTokens 说明：
 *   - deepseek-flash 沿用原有取值（本部署网关 300,000 请求体上限），不要改；
 *   - portal 三个模型按平台声明的 context_length 取（1M / 256K / 1M）。
 *
 * 平台模型参数（2026-10-31 实测，见 docs/技术细节.md「平台三个模型的参数」）：
 *   - temperature：kimi 固定 1 且不可改（传别的值会让平台回 "Exception:Error code"）；
 *     qwen / deepseek 默认 0.7，可改；
 *   - max_tokens：平台声明 8192 / 2048 / 2048，实际请求更大的值也被接受；
 *   - 思考：平台没有档位，只有 enable_thinking 开关（false 时思考长度归零）。
 */

export const LOCAL_MODEL_ID = 'deepseek-flash';

/** 自部署那一个。取值与旧版 DEFAULTS 完全一致，避免动到已有的压缩线。 */
export const LOCAL_MODEL = {
  id: LOCAL_MODEL_ID,
  // 与 DSH 官方给 DeepSeek Flash 挂的「1017」发行标保持一致：
  // 学校自部署的这个上游就是 V4.1-Flash-1017 构建。
  name: 'DeepSeek V4.1 Flash 1017 (海师自部署)',
  build: '1017',
  upstream: 'local',
  contextWindow: 300000,
  maxTokens: 80000,
  input: ['text', 'image'],
  source: '海师自部署',
  // 上游是原生 OpenAI 接口：工具调用走 function calling，图片走 image_url。
  tools: 'native',
  vision: true,
  // 网关限制的是**单次请求体字节数**，不是模型上下文：
  // 实测 1.02 MB 通过、1.2 MB 被 413 拒（同一个 400k 字符，英文 400KB 过、中文 1.2MB 拒）。
  requestLimitBytes: 1024 * 1024,
  requestLimitLabel: '1 MB',
  summary:
    '学校自部署的 DeepSeek V4.1 Flash。四个模型里唯一能看图（直接读图里的文字/图表），' +
    '工具调用走上游原生 function calling，最稳。注意网关限制的是单次请求体约 1 MB（按字节），' +
    '不是上下文长度；DSH 里按 300,000 预算压缩正是为了不撞这条线。',
  notes: [
    '支持图片输入（image_url）',
    '工具调用：原生 function calling',
    '请求体上限约 1 MB（按字节，1.02 MB 通过、1.2 MB 被拒）',
    '最稳，适合多步 agent',
  ],
};

/** 平台模型：id 是本地对外的名字，platformName 用于和平台返回的 model_name 对齐。 */
export const PORTAL_MODELS = [
  {
    id: 'kimi-k3',
    name: 'Kimi K3 (海师阿里云)',
    upstream: 'portal',
    platformName: 'kimi-k3',
    contextWindow: 1000000,
    maxTokens: 8192,
    input: ['text'],
    // 平台声明：temperature 固定 1（temperature_editable=false），max_tokens 默认 8192。
    params: { temperature: 1, topK: 50, temperatureEditable: false },
    // 平台没有「档位」，只有开关：enable_thinking: false 能真正关掉思考（实测思考长度归零）。
    reasoningEfforts: { off: 'none', max: 'max' },
    source: '海师阿里云',
    tools: 'emulated',
    vision: false,
    summary:
      'Kimi K3，1M 上下文、偏思考的重型模型。工具调用由插件用文本协议模拟；' +
      '温度被平台锁死在 1，偶尔会「只说不做」，插件会自动换会话重试兜底。适合读长文、写作，不适合长时间多步 agent。',
    notes: ['不支持图片', '工具调用：插件模拟（温度锁定 1，偶有波动）', '上下文 1M，适合长文阅读'],
  },
  {
    id: 'qwen3.8-flash',
    name: 'Qwen3.8 Flash (海师阿里云)',
    upstream: 'portal',
    platformName: 'qwen3.8-flash',
    contextWindow: 256000,
    maxTokens: 8192,
    input: ['text'],
    // 平台声明：temperature 可编辑，默认 0.7；max_tokens 默认 2048（请求更大的值平台会接受）。
    params: { temperature: 0.7, topK: 50, temperatureEditable: true },
    reasoningEfforts: { off: 'none', max: 'max' },
    source: '海师阿里云',
    tools: 'emulated',
    vision: false,
    summary:
      'Qwen3.8 Flash，256K 上下文、响应快。工具调用由插件模拟，温度可调（agent 场景压到 0.2），' +
      '实测稳定。性价比高，适合日常编码与工具链任务。',
    notes: ['不支持图片', '工具调用：插件模拟（稳定）', '响应约 3 秒'],
  },
  {
    id: 'deepseek-v4.1-flash',
    // 与自部署那个是同一构建：6 道确定性题目里 5 题逐字一致（剩下 1 题只是平台额外套了
    // 「📋/🎯」的智能体包装）。平台不透出 system_fingerprint，所以这是行为指纹的结论。
    name: 'DeepSeek V4.1 Flash 1017 (海师阿里云)',
    build: '1017',
    upstream: 'portal',
    platformName: 'deepseek-v4.1-flash',
    contextWindow: 1000000,
    maxTokens: 8192,
    input: ['text'],
    params: { temperature: 0.7, topK: 50, temperatureEditable: true },
    reasoningEfforts: { off: 'none', max: 'max' },
    source: '海师阿里云',
    tools: 'emulated',
    vision: false,
    summary:
      'DeepSeek V4.1 Flash，1M 上下文、最快最便宜。工具调用由插件模拟，实测 1 秒内就能给出工具调用，' +
      '是跑 agent 的首选。',
    notes: ['不支持图片', '工具调用：插件模拟（快且稳）', '上下文 1M，优先选它跑 agent'],
  },
];

/** 平台 model_id 的兜底（接口拿不到时用）。值来自 2026-10-31 的实测。 */
export const PLATFORM_FALLBACK_IDS = {
  'kimi-k3': '01a0615a-c849-76b1-a49a-6039917d1d03',
  'qwen3.8-flash': '01a0cd3d-e37f-77d0-945f-065d94ef3ed7',
  'deepseek-v4.1-flash': '01a0cd8c-9fd4-7e01-9dd2-267d89bd9210',
};

export function allModels() {
  return [LOCAL_MODEL, ...PORTAL_MODELS];
}

export function modelById(id) {
  const key = String(id || '');
  return allModels().find((m) => m.id === key) || null;
}

export function isPortalModel(id) {
  const found = modelById(id);
  return found !== null && found.upstream === 'portal';
}

/** 平台上的 model_name -> 本地 id，用于把接口返回的目录翻译过来。 */
export function localIdForPlatformName(name) {
  const key = String(name || '');
  const found = PORTAL_MODELS.find((m) => m.platformName === key);
  return found === undefined ? '' : found.id;
}
