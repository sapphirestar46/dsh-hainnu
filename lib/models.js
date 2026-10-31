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
    '学校自部署的 DeepSeek V4.1 Flash（1017 构建）。四个模型里唯一能看图，' +
    '也是唯一走**原生 function calling** 的——不依赖文本协议，多步 agent 最稳。' +
    '代价是思考开销大：复杂创作要给足输出预算，32k 时会一直想到被截断。' +
    '网关限的是单次请求体约 1 MB（按字节），不是上下文长度。',
  notes: [
    '支持图片输入（image_url，实测能读出图里的文字）',
    '工具调用：原生 function calling（最稳）',
    '请求体上限约 1 MB（按字节，1.02 MB 通过、1.2 MB 被拒）',
    '思考开销大：绘图/长文这类任务建议 80k 输出预算',
    '同题对比（鹈鹕骑车）产出 22–36 KB，细节最丰富',
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
    // 平台默认只有 8192，但实测请求 131072 会被真正兑现（输出 108,893 字符、数完 20000 行）。
    // 上下文 1M，给 131072 仍留 87% 可用窗口。
    maxTokens: 131072,
    input: ['text'],
    // 平台声明：temperature 固定 1（temperature_editable=false），max_tokens 默认 8192。
    params: { temperature: 1, topK: 50, temperatureEditable: false },
    // 平台没有「档位」，只有开关：enable_thinking: false 能真正关掉思考（实测思考长度归零）。
    reasoningEfforts: { off: 'none', max: 'max' },
    source: '海师阿里云',
    tools: 'emulated',
    vision: false,
    summary:
      'Kimi K3，1M 上下文、偏思考的重型模型。工具调用由插件转文本协议实现' +
      '（支持 <tool_call> 与 DSH 原生 DSML 两种写法，插件都能识别）。' +
      '温度被平台锁死在 1，输出波动较大；画图/长任务的完成度一般。适合读长文、写作。',
    notes: [
      '不支持图片',
      '工具调用：插件转协议（两种格式都认）',
      '温度锁定 1，结果随机性高',
      '同题对比（鹈鹕骑车）约 10 KB，完成度中等',
    ],
  },
  {
    id: 'qwen3.8-flash',
    name: 'Qwen3.8 Flash (海师阿里云)',
    upstream: 'portal',
    platformName: 'qwen3.8-flash',
    contextWindow: 256000,
    // 256K 窗口下如果给到 131072，DSH 的压缩线会掉到 ~125K（一半窗口白扔），
    // 所以这里折中到 65536，压缩线仍在 ~190K。
    maxTokens: 65536,
    input: ['text'],
    // 平台声明：temperature 可编辑，默认 0.7；max_tokens 默认 2048（请求更大的值平台会接受）。
    params: { temperature: 0.7, topK: 50, temperatureEditable: true },
    reasoningEfforts: { off: 'none', max: 'max' },
    source: '海师阿里云',
    tools: 'emulated',
    vision: false,
    summary:
      'Qwen3.8 Flash，256K 上下文、响应快（工具调用约 3 秒）。工具调用由插件转文本协议，' +
      '温度可调（agent 场景压到 0.2）。注意它对系统提示比较敏感：只给 DSML 一种格式时它会拒答，' +
      '插件现在同时给出两种格式所以没问题。',
    notes: [
      '不支持图片',
      '工具调用：插件转协议（约 3 秒）',
      '对提示格式敏感，插件已同时提供两种调用格式',
      '同题对比（鹈鹕骑车）约 10 KB，配色和细节不错',
    ],
  },
  {
    id: 'deepseek-v4.1-flash',
    // 不标 1017 / 0910：平台不透出版本信息（SSE 无 system_fingerprint、目录无版本号），
    // 同题异构的质量对比又被输出预算强烈干扰（见 docs「同题异构对比」），证据不足。
    name: 'DeepSeek V4.1 Flash (海师阿里云)',
    upstream: 'portal',
    platformName: 'deepseek-v4.1-flash',
    contextWindow: 1000000,
    // 同 kimi：平台实测兑现 131072，1M 窗口下仍留 87% 可用。
    maxTokens: 131072,
    input: ['text'],
    params: { temperature: 0.7, topK: 50, temperatureEditable: true },
    reasoningEfforts: { off: 'none', max: 'max' },
    source: '海师阿里云',
    tools: 'emulated',
    vision: false,
    summary:
      'DeepSeek V4.1 Flash，1M 上下文、四个模型里响应最快（工具调用约 1 秒）。' +
      '工具调用由插件转文本协议；思考开销小，32k 输出预算就能完成中等复杂度创作。' +
      '同题绘图里构图和层次最好。平台未公开它的构建号，所以不标 1017。',
    notes: [
      '不支持图片',
      '工具调用：插件转协议（约 1 秒，最快）',
      '思考开销小：同等预算下完成度最高',
      '同题对比（鹈鹕骑车）约 11.6 KB，喉囊与辐条最准',
    ],
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
