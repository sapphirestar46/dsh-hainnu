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
  name: 'DeepSeek V4.1 Flash (海师自部署)',
  upstream: 'local',
  contextWindow: 300000,
  maxTokens: 80000,
  input: ['text', 'image'],
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
    params: { temperature: 1, topK: 50 },
    // 平台没有「档位」，只有开关：enable_thinking: false 能真正关掉思考（实测思考长度归零）。
    reasoningEfforts: { off: 'none', max: 'max' },
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
    params: { temperature: 0.7, topK: 50 },
    reasoningEfforts: { off: 'none', max: 'max' },
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash (海师阿里云)',
    upstream: 'portal',
    platformName: 'deepseek-v4.1-flash',
    contextWindow: 1000000,
    maxTokens: 8192,
    input: ['text'],
    params: { temperature: 0.7, topK: 50 },
    reasoningEfforts: { off: 'none', max: 'max' },
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
