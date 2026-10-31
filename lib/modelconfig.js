/**
 * 把海师代理"注册"进 DSH 的模型配置。
 *
 * DSH 的 provider 只来自配置文件（ctx.llm 只能声明 provider id，不能塞模型），
 * 所以要往 profile 的 cordis.patch.yml 里 upsert `llm-pi-ai` 的 providers 段，
 * 并保证 HAINNU_API_KEY 在 ~/.dsh/.credentials.yaml 里存在。
 *
 * 编辑策略：**按行做外科手术**，不整体重写文件。
 * 原因：这个 patch 里有 570 行、四个 preset 大块、还有若干中文注释，
 * 整体 dump 会把注释和格式全丢掉（旧项目 agent_config.py 也是这么处理的）。
 *
 * 安全网：改动前 .bak-时间戳 备份 → 临时文件 + rename 原子替换 →
 * 写后按文本校验关键行 → 校验失败回滚。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dshHome } from './store.js';

export const DEFAULTS = {
  providerId: 'hainnu',
  // provider 下面现在挂 4 个模型（自部署 1 + 阿里云 3），名字不能再只写一个模型。
  displayName: '海南师范大学',
  apiKeyEnv: 'HAINNU_API_KEY',
  apiKey: 'sk-hainnu',
  modelId: 'deepseek-flash',
  modelName: 'DeepSeek V4.1 Flash (海师)',
  // 300,000 不是模型能力（deepseek-flash 本身 1M 上下文 / 384K 输出），而是本部署
  // 网关的单次请求体上限：prompt + max_tokens 必须 ≤ 300,000。写大了会被网关拒。
  contextWindow: 300000,
  // 网关默认输出上限 32,768，必须显式声明。取 80,000 是为了让压缩线落在 220,000：
  // 窗口钉死 300,000 时，压缩线 = min(240,000, 300,000 − maxTokens − headroom)，
  // maxTokens 只要 ≤ 80,000 就能到 220,000（模型实际输出上限 64k，少这 16k 不影响）。
  maxTokens: 80000,
  input: ['text', 'image'],
  // 官方《思考模式》只有 low / high / max 三档；本网关的 deepseek 适配认 off/low/max。
  reasoningEfforts: { off: 'none', low: 'low', max: 'max' },
  reasoning: 'max',
  compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  // 压缩线：DSH 默认 headroomTokens 65,536，会让这条路由在
  //   floor(min(300000×0.8, 300000−80000−65536)) = 154,464
  // 就压缩。把余量收到 0 后
  //   floor(min(240000, 300000−80000−0)) = 220,000
  // 0 = 300000 − 80000 − 220000，窗口和输出都没被这条线挤掉。
  compactionHeadroomTokens: 0,
  compactionSummaryTokens: 4000,
  compactionTolerance: 1000,
  syncCompaction: true,
  setDefaultModel: true,
  defaultReasoningEffort: 'max',
  syncModelPolicy: false,
  /** 同 provider 的附加模型；由调用方（index.js）从模型目录里填。 */
  extraModels: [],
  /** 允许被自动改写的历史显示名。 */
  legacyNames: ['DeepSeek V4.1 Flash (海师)'],
  syncModelNames: false,
};

const LLM_ENTRY_ID = 'llm-pi-ai';
const LLM_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai';
const DEFAULT_MODEL_ENTRY_ID = 'agent-default-model';
const DEFAULT_MODEL_ENTRY_NAME = '@deepseek-ai/dsh-agent-default-model';
const COMPACTION_ID = 'compaction-basic';
/** 早期版本写进 patch 的 provider 显示名，命中就地迁移。 */
const LEGACY_PROVIDER_DISPLAY = 'DeepSeek V4.1 Flash (海师)';
const DEFAULT_COMPACTION_HEADROOM = 65536;
const DEFAULT_THRESHOLD_RATIO = 0.8;

export function profileDir(profile = 'desktop') {
  return path.join(dshHome(), 'profiles', profile);
}

export function patchPathFor(profile = 'desktop') {
  return path.join(profileDir(profile), 'cordis.patch.yml');
}

export function credentialsPath() {
  return path.join(dshHome(), '.credentials.yaml');
}

/* ---------------------------------------------------------------- 文本工具 */

const sp = (n) => ' '.repeat(Math.max(0, n));

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indentOf(line) {
  const m = /^[ ]*/.exec(line);
  return m[0].length;
}

function isBlank(line) {
  return line.trim() === '';
}

/** 一个块在 indent 缩进下的结束行（不含）。 */
function blockEnd(lines, start, indent) {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}

/** 顶层 patch 条目：`- id: xxx`。 */
function findTopEntry(lines, id) {
  const re = /^-\s+id\s*:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m !== null && m[1] === id) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^-\s/.test(lines[j])) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

/** 找 `key:` 行（含内联值），返回 {index, value} 或 null。 */
function findKeyLine(lines, from, to, key, indent) {
  const re = new RegExp(`^ {${indent}}${escapeRe(key)}\\s*:(.*)$`);
  for (let i = from; i < to; i += 1) {
    const m = re.exec(lines[i]);
    if (m !== null) return { index: i, value: m[1].trim() };
  }
  return null;
}

/** 设置标量：已存在则就地改值，不存在则插在 owner 行后面。 */
function setScalar(lines, ownerIndex, to, key, value, indent) {
  const found = findKeyLine(lines, ownerIndex + 1, to, key, indent);
  const line = `${sp(indent)}${key}: ${value}`;
  if (found !== null) {
    if (found.value === String(value)) return false;
    lines[found.index] = line;
    return true;
  }
  lines.splice(ownerIndex + 1, 0, line);
  return true;
}

function unquote(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function numberOr(value, fallback) {
  const n = Number(unquote(value));
  // 0 是合法值（headroomTokens 就是「不留余量」），别当成「没写」。
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 同一个 provider 下要维护的所有模型。
 *
 * 主模型沿用顶层字段（modelId / modelName / contextWindow / …），
 * 其余模型放在 cfg.extraModels 里，每个都是同样的形状。
 * 这样旧的单模型调用点和测试都不用改。
 */
export function modelEntries(cfg) {
  const primary = {
    id: cfg.modelId,
    name: cfg.modelName,
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    input: cfg.input,
    reasoningEfforts: cfg.reasoningEfforts,
  };
  const extras = Array.isArray(cfg.extraModels) ? cfg.extraModels : [];
  const list = [primary];
  for (const item of extras) {
    if (item === null || typeof item !== 'object') continue;
    const id = String(item.id || '');
    if (id === '' || list.some((m) => m.id === id)) continue;
    list.push({
      id,
      name: String(item.name || id),
      contextWindow: Number(item.contextWindow) || primary.contextWindow,
      maxTokens: Number(item.maxTokens) || primary.maxTokens,
      input: Array.isArray(item.input) && item.input.length > 0 ? item.input.map(String) : primary.input,
      reasoningEfforts:
        item.reasoningEfforts !== null && typeof item.reasoningEfforts === 'object'
          ? item.reasoningEfforts
          : primary.reasoningEfforts,
    });
  }
  return list;
}

/** 把某个模型条目铺回 cfg 形状，供只认识单模型的函数复用。 */
function forModel(cfg, model) {
  return {
    ...cfg,
    modelId: model.id,
    modelName: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    reasoningEfforts: model.reasoningEfforts,
  };
}

function modelLines(indent, cfg, model) {
  const target = model === undefined ? forModel(cfg, modelEntries(cfg)[0]) : model;
  const i2 = indent + 2;
  const lines = [
    `${sp(indent)}- id: ${target.id}`,
    `${sp(i2)}name: ${target.name}`,
    `${sp(i2)}contextWindow: ${target.contextWindow}`,
    `${sp(i2)}maxTokens: ${target.maxTokens}`,
    `${sp(i2)}input:`,
  ];
  for (const modality of target.input) lines.push(`${sp(i2 + 2)}- ${modality}`);
  lines.push(`${sp(i2)}reasoningEfforts:`);
  for (const [level, wire] of Object.entries(target.reasoningEfforts)) {
    lines.push(`${sp(i2 + 2)}${level}: ${wire}`);
  }
  return lines;
}

function providerLines(indent, cfg) {
  const i2 = indent + 2;
  const i4 = indent + 4;
  return [
    `${sp(indent)}${cfg.providerId}:`,
    `${sp(i2)}displayName: ${cfg.displayName}`,
    `${sp(i2)}apiKeyEnv: ${cfg.apiKeyEnv}`,
    `${sp(i2)}api: openai-completions`,
    `${sp(i2)}baseURL: ${cfg.baseURL}`,
    `${sp(i2)}models:`,
    ...modelEntries(cfg).flatMap((model) => modelLines(i4, cfg, model)),
    `${sp(i2)}compat:`,
    ...Object.entries(cfg.compat).map(([key, value]) => `${sp(i4)}${key}: ${value}`),
    `${sp(i2)}reasoning: ${cfg.reasoning}`,
  ];
}

function findRowById(lines, from, to, id, indent) {
  const re = new RegExp(`^ {${indent}}-\\s+id\\s*:\\s*['"]?${escapeRe(id)}['"]?\\s*$`);
  for (let i = from; i < to; i += 1) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/** 补齐 / 校正单个 models 条目里的字段。 */
function ensureModelFields(lines, modelIdx, cfg, notes) {
  let changed = false;
  const indent = indentOf(lines[modelIdx]);
  const keyIndent = indent + 2;
  const end = () => blockEnd(lines, modelIdx, indent);

  const nameLine = findKeyLine(lines, modelIdx + 1, end(), 'name', keyIndent);
  if (nameLine === null) {
    if (setScalar(lines, modelIdx, end(), 'name', cfg.modelName, keyIndent)) {
      notes.push(`已补上模型 ${cfg.modelId} 的 name`);
      changed = true;
    }
  } else {
    const current = unquote(nameLine.value);
    const legacy = Array.isArray(cfg.legacyNames) ? cfg.legacyNames : [];
    if (current !== cfg.modelName && (cfg.syncModelNames === true || legacy.includes(current))) {
      lines[nameLine.index] = `${sp(keyIndent)}name: ${cfg.modelName}`;
      notes.push(`已把模型 ${cfg.modelId} 的显示名从「${current}」改为「${cfg.modelName}」`);
      changed = true;
    }
  }

  // contextWindow / maxTokens 直接决定压缩线与请求准入：缺了必须补，
  // 值不对时只有显式开启 syncModelPolicy 才覆盖，避免抹掉用户自己调过的值。
  for (const [key, value] of [
    ['contextWindow', cfg.contextWindow],
    ['maxTokens', cfg.maxTokens],
  ]) {
    const found = findKeyLine(lines, modelIdx + 1, end(), key, keyIndent);
    if (found === null) {
      if (setScalar(lines, modelIdx, end(), key, value, keyIndent)) {
        notes.push(`已补上模型 ${cfg.modelId} 的 ${key}: ${value}`);
        changed = true;
      }
      continue;
    }
    if (numberOr(found.value, 0) === Number(value)) continue;
    if (cfg.syncModelPolicy === true) {
      setScalar(lines, modelIdx, end(), key, value, keyIndent);
      notes.push(`已把模型 ${cfg.modelId} 的 ${key} 从 ${unquote(found.value)} 校正为 ${value}`);
      changed = true;
    } else {
      notes.push(
        `注意：模型 ${cfg.modelId} 的 ${key} 是 ${unquote(found.value)}，插件策略是 ${value}` +
          '（压缩线按前者算；要自动校正请开 syncModelPolicy）',
      );
    }
  }

  if (findKeyLine(lines, modelIdx + 1, end(), 'input', keyIndent) === null) {
    lines.splice(
      end(),
      0,
      `${sp(keyIndent)}input:`,
      ...cfg.input.map((modality) => `${sp(keyIndent + 2)}- ${modality}`),
    );
    notes.push(`已补上模型 ${cfg.modelId} 的 input`);
    changed = true;
  }

  if (findKeyLine(lines, modelIdx + 1, end(), 'reasoningEfforts', keyIndent) === null) {
    lines.splice(
      end(),
      0,
      `${sp(keyIndent)}reasoningEfforts:`,
      ...Object.entries(cfg.reasoningEfforts).map(([level, wire]) => `${sp(keyIndent + 2)}${level}: ${wire}`),
    );
    notes.push(`已补上模型 ${cfg.modelId} 的 reasoningEfforts`);
    changed = true;
  }

  return changed;
}

/* ------------------------------------------------------------ provider 段 */

function ensureProviderInEntry(lines, entry, cfg, notes) {
  let changed = false;
  const configLine = findKeyLine(lines, entry.start, entry.end, 'config', 2);
  if (configLine === null) {
    lines.splice(entry.start + 1, 0, '  config:');
    notes.push('llm-pi-ai 缺少 config 段，已补上');
    changed = true;
  }
  const configIdx = findKeyLine(lines, entry.start, entry.end, 'config', 2).index;
  const entryEnd = blockEnd(lines, configIdx, 2);

  let providersLine = findKeyLine(lines, configIdx, entryEnd, 'providers', 4);
  if (providersLine === null) {
    lines.splice(configIdx + 1, 0, '    providers:');
    notes.push('llm-pi-ai 缺少 providers 段，已补上');
    changed = true;
    providersLine = { index: configIdx + 1, value: '' };
  }
  const providersIdx = providersLine.index;
  if (/^[{[]/.test(providersLine.value) || providersLine.value === 'null' || providersLine.value === '~') {
    lines[providersIdx] = '    providers:';
    notes.push('providers 原本是内联空值，已改为映射写法');
    changed = true;
  }

  const providerIndent = 6;
  const providersEnd = blockEnd(lines, providersIdx, 4);
  const existing = findKeyLine(lines, providersIdx + 1, providersEnd, cfg.providerId, providerIndent);

  if (existing === null) {
    lines.splice(providersIdx + 1, 0, ...providerLines(providerIndent, cfg));
    notes.push(`已新增 provider「${cfg.providerId}」（${cfg.baseURL}，模型 ${cfg.modelId}）`);
    return true;
  }

  const provIdx = existing.index;
  const provEnd = blockEnd(lines, provIdx, providerIndent);

  // baseURL 是最关键的一项：端口可能从 8787 漂到 8788。
  if (setScalar(lines, provIdx, provEnd, 'baseURL', cfg.baseURL, providerIndent + 2)) {
    notes.push(`已把 provider「${cfg.providerId}」的 baseURL 校正为 ${cfg.baseURL}`);
    changed = true;
  }
  const displayLine = findKeyLine(lines, provIdx + 1, blockEnd(lines, provIdx, providerIndent), 'displayName', providerIndent + 2);
  if (displayLine === null) {
    if (setScalar(lines, provIdx, blockEnd(lines, provIdx, providerIndent), 'displayName', cfg.displayName, providerIndent + 2)) {
      notes.push('已补上 displayName');
      changed = true;
    }
  } else if (unquote(displayLine.value) === LEGACY_PROVIDER_DISPLAY && cfg.displayName !== LEGACY_PROVIDER_DISPLAY) {
    // 旧版本把 provider 名写成了单个模型名；现在它下面有四个模型，迁过来。
    lines[displayLine.index] = `${sp(providerIndent + 2)}displayName: ${cfg.displayName}`;
    notes.push(`已把 provider 显示名从「${LEGACY_PROVIDER_DISPLAY}」改为「${cfg.displayName}」`);
    changed = true;
  }
  if (findKeyLine(lines, provIdx + 1, blockEnd(lines, provIdx, providerIndent), 'api', providerIndent + 2) === null) {
    if (setScalar(lines, provIdx, blockEnd(lines, provIdx, providerIndent), 'api', 'openai-completions', providerIndent + 2)) {
      notes.push('已补上 api: openai-completions');
      changed = true;
    }
  }
  if (findKeyLine(lines, provIdx + 1, blockEnd(lines, provIdx, providerIndent), 'apiKeyEnv', providerIndent + 2) === null) {
    if (setScalar(lines, provIdx, blockEnd(lines, provIdx, providerIndent), 'apiKeyEnv', cfg.apiKeyEnv, providerIndent + 2)) {
      notes.push(`已补上 apiKeyEnv: ${cfg.apiKeyEnv}`);
      changed = true;
    }
  }

  // models 列表：保证目标模型存在；已存在时补齐字段，容量只在 syncModelPolicy 时覆盖。
  const modelIndent = providerIndent + 2;
  const modelsIdx = findKeyLine(lines, provIdx, blockEnd(lines, provIdx, providerIndent), 'models', modelIndent);
  if (modelsIdx === null) {
    const insertAt = blockEnd(lines, provIdx, providerIndent);
    lines.splice(insertAt, 0, `${sp(modelIndent)}models:`, ...modelEntries(cfg).flatMap((model) => modelLines(modelIndent + 2, cfg, model)));
    notes.push(`已为 provider「${cfg.providerId}」补上 models 段`);
    changed = true;
  } else {
    // 逐个模型处理：模型是追加的，插入只会影响其后的行号，按 id 重新查找即可。
    for (const model of modelEntries(cfg)) {
      const merged = forModel(cfg, model);
      const rowIndent = modelIndent + 2;
      const modelsEnd = blockEnd(lines, modelsIdx.index, modelIndent);
      const modelIdx = findRowById(lines, modelsIdx.index + 1, modelsEnd, model.id, rowIndent);
      if (modelIdx < 0) {
        lines.splice(modelsEnd, 0, ...modelLines(rowIndent, cfg, model));
        notes.push(`已为 provider「${cfg.providerId}」新增模型 ${model.id}`);
        changed = true;
      } else {
        changed = ensureModelFields(lines, modelIdx, merged, notes) || changed;
      }
    }
  }
  return changed;
}

/* ---------------------------------------------------- 压缩线与默认模型 */

/**
 * DSH 的压缩触发线：floor(min(W × thresholdRatio, W − O − headroomTokens))。
 * W = 模型 contextWindow，O = 模型 maxTokens（输出上限）。
 */
export function compactionLine({ contextWindow, maxTokens, headroomTokens, thresholdRatio = DEFAULT_THRESHOLD_RATIO }) {
  const window = Number(contextWindow);
  const output = Number(maxTokens);
  const headroom = Number(headroomTokens);
  const ratio = Number(thresholdRatio);
  if (!(window > 0) || !(output > 0) || !(headroom >= 0) || !(ratio > 0)) return 0;
  const byBudget = window - output - headroom;
  if (byBudget <= 0) return 0;
  return Math.min(Math.floor(window * ratio), byBudget);
}

/** 任意缩进下匹配 `- id: <id>` 的行（preset 里的插件行也在这个文件里）。 */
function findRowsById(lines, id) {
  const re = new RegExp(`^(\\s*)-\\s+id\\s*:\\s*['"]?${escapeRe(id)}['"]?\\s*$`);
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = re.exec(lines[i]);
    if (match !== null) rows.push({ index: i, indent: match[1].length });
  }
  return rows;
}

function readCompactionConfig(lines, row) {
  const rowEnd = blockEnd(lines, row.index, row.indent);
  const config = findKeyLine(lines, row.index + 1, rowEnd, 'config', row.indent + 2);
  if (config === null) return { configIndex: -1, indent: row.indent + 4, end: rowEnd, headroom: null, ratio: null, policies: null };
  const indent = indentOf(lines[config.index]);
  const end = blockEnd(lines, config.index, indent);
  const headroom = findKeyLine(lines, config.index + 1, end, 'headroomTokens', indent + 2);
  const ratio = findKeyLine(lines, config.index + 1, end, 'thresholdRatio', indent + 2);
  const policies = findKeyLine(lines, config.index + 1, end, 'modelPolicies', indent + 2);
  return {
    configIndex: config.index,
    configValue: config.value,
    indent,
    end,
    headroom: headroom === null ? null : numberOr(headroom.value, null),
    ratio: ratio === null ? null : numberOr(ratio.value, null),
    policies: policies === null ? null : policies.index,
  };
}

/** modelPolicies 里是否已经有 provider+model 这条覆盖。 */
function hasPolicyEntry(lines, policiesIdx, providerId, modelId) {
  if (policiesIdx === null) return false;
  const indent = indentOf(lines[policiesIdx]);
  const end = blockEnd(lines, policiesIdx, indent);
  let provider = null;
  for (let i = policiesIdx + 1; i < end; i += 1) {
    const item = /^(\s*)-\s+provider\s*:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i]);
    if (item !== null) {
      provider = { value: item[2], indent: item[1].length };
      continue;
    }
    if (provider === null) continue;
    const model = new RegExp(`^ {${provider.indent + 2}}model\\s*:\\s*['"]?([^'"\\s]+)['"]?\\s*$`).exec(lines[i]);
    if (model !== null && provider.value === providerId && model[1] === modelId) return true;
  }
  return false;
}

function policyEntryLines(indent, cfg) {
  return [
    `${sp(indent)}- provider: ${cfg.providerId}`,
    `${sp(indent + 2)}model: ${cfg.modelId}`,
    `${sp(indent + 2)}headroomTokens: ${cfg.compactionHeadroomTokens}`,
    `${sp(indent + 2)}maxTokens: ${cfg.compactionSummaryTokens}`,
  ];
}

/**
 * 把压缩线同步到每个含 compaction-basic 的 preset。
 *
 * 只写**按模型**的 modelPolicies 覆盖（provider+model 精确匹配），不碰全局
 * headroomTokens —— 全局值同时影响所有 provider，插件不该替别人做主。
 * 已经够高（≥ 策略线 − 容差）或已有本模型覆盖时不动，保证反复启动不产生 churn。
 */
function ensureCompactionPolicy(lines, cfg, capacity, notes) {
  let changed = false;
  let missingPreset = false;
  let tooSmall = '';
  for (const model of modelEntries(cfg)) {
    const merged = forModel(cfg, model);
    // 每轮都重新定位：插入会改变行号。
    const rows = findRowsById(lines, COMPACTION_ID);
    if (rows.length === 0) {
      missingPreset = true;
      break;
    }
    const isPrimary = model.id === cfg.modelId;
    const window = (isPrimary ? Number(capacity && capacity.contextWindow) : 0) || model.contextWindow;
    const output = (isPrimary ? Number(capacity && capacity.maxTokens) : 0) || model.maxTokens;
    const target = compactionLine({
      contextWindow: window,
      maxTokens: output,
      headroomTokens: cfg.compactionHeadroomTokens,
      thresholdRatio: DEFAULT_THRESHOLD_RATIO,
    });
    if (target <= 0) {
      tooSmall = `${merged.modelId}（${window} − ${output}）`;
      continue;
    }
    // 倒序处理：插入只会改变其后的行号，这样前面未处理的 preset 索引不会失效。
    for (let r = rows.length - 1; r >= 0; r -= 1) {
      const row = rows[r];
      const info = readCompactionConfig(lines, row);
      if (hasPolicyEntry(lines, info.policies, cfg.providerId, merged.modelId)) continue;
      const ratio = info.ratio === null ? DEFAULT_THRESHOLD_RATIO : info.ratio;
      const headroom = info.headroom === null ? DEFAULT_COMPACTION_HEADROOM : info.headroom;
      const current = compactionLine({ contextWindow: window, maxTokens: output, headroomTokens: headroom, thresholdRatio: ratio });
      if (current > 0 && current >= target - cfg.compactionTolerance) continue;
      if (cfg.syncCompaction !== true) {
        notes.push(`压缩线：当前 ${current || '无效'}，策略 ${target}（syncCompaction 未开启，未改动）`);
        continue;
      }
      if (info.configIndex < 0) {
        const base = row.indent + 2;
        let rowEnd = blockEnd(lines, row.index, row.indent);
        while (rowEnd > row.index + 1 && isBlank(lines[rowEnd - 1])) rowEnd -= 1;
        lines.splice(rowEnd, 0, `${sp(base)}config:`, `${sp(base + 2)}modelPolicies:`, ...policyEntryLines(base + 4, merged));
      } else if (/^[{[]/.test(info.configValue) || info.configValue === 'null' || info.configValue === '~') {
        lines[info.configIndex] = `${sp(info.indent)}config:`;
        lines.splice(info.configIndex + 1, 0, `${sp(info.indent + 2)}modelPolicies:`, ...policyEntryLines(info.indent + 4, merged));
      } else if (info.policies === null) {
        lines.splice(info.end, 0, `${sp(info.indent + 2)}modelPolicies:`, ...policyEntryLines(info.indent + 4, merged));
      } else {
        const policiesIndent = indentOf(lines[info.policies]);
        const policiesEnd = blockEnd(lines, info.policies, policiesIndent);
        lines.splice(policiesEnd, 0, ...policyEntryLines(policiesIndent + 2, merged));
      }
      notes.push(`压缩线：${current || '未设置'} → ${target}（已写入 modelPolicies，仅对 ${cfg.providerId}/${merged.modelId} 生效）`);
      changed = true;
    }
  }
  if (missingPreset) notes.push('压缩线：profile 里没有 compaction-basic（可能还没装 preset），跳过');
  if (tooSmall !== '') notes.push(`压缩线：${tooSmall} 已经不足以留出余量，跳过（检查 contextWindow / maxTokens）`);
  return changed;
}

/** 默认模型（新会话用哪个）：只在没人接管时写，绝不抢别的 provider。 */
function ensureDefaultModel(lines, cfg, notes) {
  if (cfg.setDefaultModel !== true) return false;
  const wanted = { provider: cfg.providerId, model: cfg.modelId, reasoningEffort: cfg.defaultReasoningEffort };
  const entry = findTopEntry(lines, DEFAULT_MODEL_ENTRY_ID);
  if (entry === null) {
    lines.push(
      '',
      `- id: ${DEFAULT_MODEL_ENTRY_ID}`,
      `  name: "${DEFAULT_MODEL_ENTRY_NAME}"`,
      '  config:',
      `    provider: ${wanted.provider}`,
      `    model: ${wanted.model}`,
      `    reasoningEffort: ${wanted.reasoningEffort}`,
    );
    notes.push(`默认模型：已新增 ${wanted.provider}/${wanted.model}`);
    return true;
  }

  const configLine = findKeyLine(lines, entry.start, entry.end, 'config', 2);
  if (configLine === null) {
    lines.splice(
      entry.start + 1,
      0,
      '  config:',
      `    provider: ${wanted.provider}`,
      `    model: ${wanted.model}`,
      `    reasoningEffort: ${wanted.reasoningEffort}`,
    );
    notes.push(`默认模型：已补上 config（${wanted.provider}/${wanted.model}）`);
    return true;
  }

  const configIndent = indentOf(lines[configLine.index]);
  const configEnd = () => blockEnd(lines, configLine.index, configIndent);
  const providerLine = findKeyLine(lines, configLine.index + 1, configEnd(), 'provider', configIndent + 2);
  const currentProvider = providerLine === null ? '' : unquote(providerLine.value);
  if (currentProvider !== '' && currentProvider !== wanted.provider && currentProvider !== 'deepseek-official') {
    notes.push(`默认模型：当前指向 ${currentProvider}，未改动`);
    return false;
  }

  let changed = false;
  for (const [key, value] of [
    ['provider', wanted.provider],
    ['model', wanted.model],
    ['reasoningEffort', wanted.reasoningEffort],
  ]) {
    if (setScalar(lines, configLine.index, configEnd(), key, value, configIndent + 2)) {
      notes.push(`默认模型：${key} → ${value}`);
      changed = true;
    }
  }
  return changed;
}

function buildEntry(cfg) {
  return [
    `- id: ${LLM_ENTRY_ID}`,
    `  name: "${LLM_ENTRY_NAME}"`,
    '  config:',
    '    providers:',
    ...providerLines(6, cfg),
  ];
}

/* ------------------------------------------------------------- 凭据文件 */

function readTextOr(file, fallback) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function backup(file) {
  if (!existsSync(file)) return '';
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const target = `${file}.bak-${stamp}`;
  try {
    copyFileSync(file, target);
    return target;
  } catch {
    return '';
  }
}

/** 读 .credentials.yaml 里某个 ref 的明文（找不到返回空串）。 */
export function readCredential(envName) {
  const text = readTextOr(credentialsPath(), '');
  if (text === '') return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const refs = findKeyLine(lines, 0, lines.length, 'refs', 0);
  if (refs === null) return '';
  const end = blockEnd(lines, refs.index, 0);
  const found = findKeyLine(lines, refs.index + 1, end, envName, 2);
  if (found === null) return '';
  let value = found.value;
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * 确保 .credentials.yaml 里存在 apiKeyEnv 对应的密钥。
 * 已存在就**不覆盖**（用户可能自己改过，而且已有值要能和代理的接受列表对上）。
 */
export function ensureCredential(envName, value, options = {}) {
  const file = options.credentialsPath || credentialsPath();
  const existing = readCredential(envName);
  if (existing !== '') return { changed: false, note: `${envName} 已存在，保持原值` };

  const text = readTextOr(file, '');
  const lines = text === '' ? ['version: 1', 'refs:'] : text.replace(/\r\n/g, '\n').split('\n');
  if (text === '') {
    lines.push(`  ${envName}: ${value}`);
  } else {
    const refs = findKeyLine(lines, 0, lines.length, 'refs', 0);
    if (refs === null) {
      lines.push('refs:', `  ${envName}: ${value}`);
    } else {
      const end = blockEnd(lines, refs.index, 0);
      let insertAt = refs.index + 1;
      for (let i = refs.index + 1; i < end; i += 1) {
        if (!isBlank(lines[i]) && indentOf(lines[i]) === 2) insertAt = i + 1;
      }
      lines.splice(insertAt, 0, `  ${envName}: ${value}`);
    }
  }
  if (options.dryRun === true) return { changed: true, note: `将写入 ${envName}（dry-run）`, preview: lines.join('\n') };
  const saved = backup(file);
  writeAtomic(file, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  return { changed: true, note: `已写入凭据 ${envName}`, backup: saved };
}

/* ---------------------------------------------------------------- 入口 */

function verifyPatch(text, cfg) {
  const problems = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entry = findTopEntry(lines, LLM_ENTRY_ID);
  if (entry === null) {
    problems.push(`找不到 - id: ${LLM_ENTRY_ID}`);
    return problems;
  }
  const provider = findKeyLine(lines, entry.start, entry.end, cfg.providerId, 6);
  if (provider === null) {
    problems.push(`provider「${cfg.providerId}」不存在`);
    return problems;
  }
  const provEnd = blockEnd(lines, provider.index, 6);
  const baseURL = findKeyLine(lines, provider.index + 1, provEnd, 'baseURL', 8);
  if (baseURL === null || baseURL.value !== cfg.baseURL) {
    problems.push(`baseURL 不是 ${cfg.baseURL}（实际 ${baseURL === null ? '缺失' : baseURL.value}）`);
  }
  const models = findKeyLine(lines, provider.index, provEnd, 'models', 8);
  if (models === null) {
    problems.push('models 段缺失');
  } else {
    const modelsEnd = blockEnd(lines, models.index, 8);
    for (const model of modelEntries(cfg)) {
      const modelRe = new RegExp(`^ {10}-\\s+id\\s*:\\s*['"]?${escapeRe(model.id)}['"]?\\s*$`);
      let found = false;
      for (let i = models.index + 1; i < modelsEnd; i += 1) {
        if (modelRe.test(lines[i])) {
          found = true;
          break;
        }
      }
      if (!found) problems.push(`模型 ${model.id} 缺失`);
    }
  }
  return problems;
}

/**
 * 确保 profile 的 cordis.patch.yml 里存在指向本地代理的 hainnu provider。
 *
 * @returns {{changed:boolean, notes:string[], backup:string, patchPath:string, problems:string[]}}
 */
export function ensureModelConfig(options = {}) {
  const cfg = {
    providerId: options.providerId || DEFAULTS.providerId,
    displayName: options.displayName || DEFAULTS.displayName,
    apiKeyEnv: options.apiKeyEnv || DEFAULTS.apiKeyEnv,
    apiKey: options.apiKey || DEFAULTS.apiKey,
    modelId: options.modelId || DEFAULTS.modelId,
    modelName: options.modelName || DEFAULTS.modelName,
    contextWindow: Number(options.contextWindow) || DEFAULTS.contextWindow,
    maxTokens: Number(options.maxTokens) || DEFAULTS.maxTokens,
    reasoning: options.reasoning || DEFAULTS.reasoning,
    baseURL: String(options.baseURL || 'http://127.0.0.1:8787/v1').replace(/\/+$/, ''),
    input: Array.isArray(options.input) && options.input.length > 0 ? options.input.map(String) : DEFAULTS.input,
    reasoningEfforts:
      options.reasoningEfforts !== null && typeof options.reasoningEfforts === 'object'
        ? options.reasoningEfforts
        : DEFAULTS.reasoningEfforts,
    compat:
      options.compat !== null && typeof options.compat === 'object'
        ? { ...DEFAULTS.compat, ...options.compat }
        : DEFAULTS.compat,
    compactionHeadroomTokens: Number(options.compactionHeadroomTokens) || DEFAULTS.compactionHeadroomTokens,
    compactionSummaryTokens: Number(options.compactionSummaryTokens) || DEFAULTS.compactionSummaryTokens,
    compactionTolerance: Number(options.compactionTolerance) || DEFAULTS.compactionTolerance,
    syncCompaction: options.syncCompaction !== false,
    setDefaultModel: options.setDefaultModel !== false,
    defaultReasoningEffort: options.defaultReasoningEffort || DEFAULTS.defaultReasoningEffort,
    syncModelPolicy: options.syncModelPolicy === true,
    // 同一个 provider 下的其它模型（海师大智汇那三个）。
    extraModels: Array.isArray(options.extraModels) ? options.extraModels : DEFAULTS.extraModels,
    // 显示名迁移：历史版本写过的名字，命中就换成新标注。
    legacyNames: Array.isArray(options.legacyNames) ? options.legacyNames : DEFAULTS.legacyNames,
    syncModelNames: options.syncModelNames === true,
  };
  const patchPath = options.patchPath || patchPathFor(options.profile || 'desktop');
  const result = { changed: false, notes: [], backup: '', patchPath, problems: [], dryRun: options.dryRun === true };

  if (!existsSync(path.dirname(patchPath))) {
    result.problems.push(`profile 目录不存在：${path.dirname(patchPath)}`);
    return result;
  }

  const original = readTextOr(patchPath, null);
  if (original === null) {
    result.problems.push(`读不到配置文件：${patchPath}`);
    return result;
  }
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let changed = false;
  const entry = findTopEntry(lines, LLM_ENTRY_ID);
  if (entry === null) {
    lines.push('', ...buildEntry(cfg));
    result.notes.push(`配置里没有 ${LLM_ENTRY_ID}，已追加整段 provider 配置`);
    changed = true;
  } else {
    changed = ensureProviderInEntry(lines, entry, cfg, result.notes) || changed;
  }

  // 压缩线（preset 内的 compaction-basic）与默认模型（agent-default-model）：
  // 都属于同一条模型策略，缺了会让 300,000 的窗口只用得上 154,464。
  const before = parseModelPolicy(lines, cfg);
  const capacity = {
    contextWindow: (before && before.model && before.model.contextWindow) || cfg.contextWindow,
    maxTokens: (before && before.model && before.model.maxTokens) || cfg.maxTokens,
  };
  changed = ensureCompactionPolicy(lines, cfg, capacity, result.notes) || changed;
  changed = ensureDefaultModel(lines, cfg, result.notes) || changed;
  const policy = parseModelPolicy(lines, cfg);
  result.policy = policy;
  if (policy !== null) {
    const target = compactionLine({
      contextWindow: capacity.contextWindow,
      maxTokens: capacity.maxTokens,
      headroomTokens: cfg.compactionHeadroomTokens,
    });
    if (policy.effectiveCompactionLine > 0 && policy.effectiveCompactionLine < target - cfg.compactionTolerance) {
      result.notes.push(
        `注意：实际压缩线 ${policy.effectiveCompactionLine} 低于可达的 ${target}` +
          '（preset 里 compaction-basic 的全局 headroomTokens 较大；插件只写按模型覆盖，不改全局值）',
      );
    }
  }

  result.changed = changed;
  if (!changed) {
    result.notes.push('模型配置已是最新，无需改动');
  } else if (result.dryRun) {
    result.notes.push('dry-run：未写入磁盘');
  } else {
    const next = `${lines.join(eol)}${eol}`;
    const problems = verifyPatch(next, cfg);
    if (problems.length > 0) {
      result.problems = problems;
      result.notes.push('自检未通过，已放弃写入');
      return result;
    }
    const saved = backup(patchPath);
    try {
      writeAtomic(patchPath, next);
      result.backup = saved;
      result.notes.push('已写入 cordis.patch.yml（原文件已备份）');
    } catch (error) {
      result.problems.push(`写入失败：${error.message}`);
      return result;
    }
  }

  if (options.writeCredential !== false) {
    try {
      const cred = ensureCredential(cfg.apiKeyEnv, cfg.apiKey, {
        credentialsPath: options.credentialsPath,
        dryRun: result.dryRun,
      });
      if (cred.changed) result.notes.push(cred.note);
    } catch (error) {
      result.problems.push(`凭据写入失败：${error.message}`);
    }
  }

  return result;
}

/** 供诊断用：把当前 provider 段落原样读出来。 */
export function readProviderSnapshot(options = {}) {
  const patchPath = options.patchPath || patchPathFor(options.profile || 'desktop');
  const text = readTextOr(patchPath, '');
  if (text === '') return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entry = findTopEntry(lines, LLM_ENTRY_ID);
  if (entry === null) return null;
  const provider = findKeyLine(lines, entry.start, entry.end, options.providerId || DEFAULTS.providerId, 6);
  if (provider === null) return null;
  const end = blockEnd(lines, provider.index, 6);
  return lines.slice(provider.index, end).join('\n');
}

/** 从已解析的行里读出模型策略（provider / model / 压缩线 / 默认模型）。 */
function parseModelPolicy(lines, cfg) {
  const entry = findTopEntry(lines, LLM_ENTRY_ID);
  if (entry === null) return null;
  const provider = findKeyLine(lines, entry.start, entry.end, cfg.providerId, 6);
  if (provider === null) return null;
  const providerEnd = blockEnd(lines, provider.index, 6);
  const pick = (key, indent, from, to) => {
    const found = findKeyLine(lines, from, to, key, indent);
    return found === null ? '' : unquote(found.value);
  };

  const providerInfo = {
    id: cfg.providerId,
    baseURL: pick('baseURL', 8, provider.index + 1, providerEnd),
    reasoning: pick('reasoning', 8, provider.index + 1, providerEnd),
    compat: {},
  };
  const compat = findKeyLine(lines, provider.index + 1, providerEnd, 'compat', 8);
  if (compat !== null) {
    const compatEnd = blockEnd(lines, compat.index, 8);
    for (const key of ['thinkingFormat', 'supportsDeveloperRole', 'maxTokensField', 'supportsReasoningEffort']) {
      const value = pick(key, 10, compat.index + 1, compatEnd);
      if (value !== '') providerInfo.compat[key] = value;
    }
  }

  const modelInfo = { id: cfg.modelId };
  const models = findKeyLine(lines, provider.index, providerEnd, 'models', 8);
  if (models !== null) {
    const modelsEnd = blockEnd(lines, models.index, 8);
    const modelIdx = findRowById(lines, models.index + 1, modelsEnd, cfg.modelId, 10);
    if (modelIdx >= 0) {
      const modelEnd = blockEnd(lines, modelIdx, 10);
      modelInfo.contextWindow = numberOr(pick('contextWindow', 12, modelIdx + 1, modelEnd), 0) || 0;
      modelInfo.maxTokens = numberOr(pick('maxTokens', 12, modelIdx + 1, modelEnd), 0) || 0;
      modelInfo.name = pick('name', 12, modelIdx + 1, modelEnd);
      const inputIdx = findKeyLine(lines, modelIdx + 1, modelEnd, 'input', 12);
      modelInfo.input = inputIdx === null ? [] : itemsOf(lines, inputIdx.index, 12);
      const effortsIdx = findKeyLine(lines, modelIdx + 1, modelEnd, 'reasoningEfforts', 12);
      if (effortsIdx !== null) {
        const effortsEnd = blockEnd(lines, effortsIdx.index, 12);
        modelInfo.reasoningEfforts = [];
        for (let i = effortsIdx.index + 1; i < effortsEnd; i += 1) {
          const key = /^\s*([A-Za-z][\w-]*)\s*:/.exec(lines[i]);
          if (key !== null) modelInfo.reasoningEfforts.push(key[1]);
        }
      } else {
        modelInfo.reasoningEfforts = [];
      }
    }
  }

  const compaction = [];
  for (const row of findRowsById(lines, COMPACTION_ID)) {
    const info = readCompactionConfig(lines, row);
    const scoped = hasPolicyEntry(lines, info.policies, cfg.providerId, cfg.modelId);
    const scopedHeadroom = scoped ? readPolicyNumber(lines, info.policies, cfg, 'headroomTokens') : null;
    const scopedRatio = scoped ? readPolicyNumber(lines, info.policies, cfg, 'thresholdRatio') : null;
    const scopedMax = scoped ? readPolicyNumber(lines, info.policies, cfg, 'maxTokens') : null;
    const headroomTokens =
      scopedHeadroom !== null ? scopedHeadroom : info.headroom === null ? DEFAULT_COMPACTION_HEADROOM : info.headroom;
    const thresholdRatio =
      scopedRatio !== null ? scopedRatio : info.ratio === null ? DEFAULT_THRESHOLD_RATIO : info.ratio;
    const summaryMaxTokens = scopedMax === null ? 0 : scopedMax;
    compaction.push({
      headroomTokens,
      thresholdRatio,
      summaryMaxTokens,
      scoped,
      line: compactionLine({
        contextWindow: modelInfo.contextWindow,
        maxTokens: modelInfo.maxTokens,
        headroomTokens,
        thresholdRatio,
      }),
    });
  }

  let defaultModel = null;
  const defaultEntry = findTopEntry(lines, DEFAULT_MODEL_ENTRY_ID);
  if (defaultEntry !== null) {
    const configLine = findKeyLine(lines, defaultEntry.start, defaultEntry.end, 'config', 2);
    if (configLine !== null) {
      const indent = indentOf(lines[configLine.index]);
      const end = blockEnd(lines, configLine.index, indent);
      defaultModel = {
        provider: pick('provider', indent + 2, configLine.index + 1, end),
        model: pick('model', indent + 2, configLine.index + 1, end),
        reasoningEffort: pick('reasoningEffort', indent + 2, configLine.index + 1, end),
      };
    }
  }

  const linesOk = compaction.filter((item) => item.line > 0).map((item) => item.line);
  const targetCompactionLine = compactionLine({
    contextWindow: modelInfo.contextWindow,
    maxTokens: modelInfo.maxTokens,
    headroomTokens: Number(cfg.headroomTokens) || DEFAULTS.compactionHeadroomTokens,
  });
  return {
    targetCompactionLine,
    provider: providerInfo,
    model: modelInfo,
    compaction,
    effectiveCompactionLine: linesOk.length > 0 ? Math.min(...linesOk) : 0,
    defaultModel,
  };
}

function itemsOf(lines, keyIdx, keyIndent) {
  const end = blockEnd(lines, keyIdx, keyIndent);
  const items = [];
  for (let i = keyIdx + 1; i < end; i += 1) {
    const match = /^\s*-\s+(.+?)\s*$/.exec(lines[i]);
    if (match !== null) items.push(unquote(match[1]));
  }
  return items;
}

function readPolicyNumber(lines, policiesIdx, cfg, key) {
  if (policiesIdx === null) return null;
  const indent = indentOf(lines[policiesIdx]);
  const end = blockEnd(lines, policiesIdx, indent);
  let item = null;
  let matched = null;
  for (let i = policiesIdx + 1; i < end; i += 1) {
    const start = /^(\s*)-\s+provider\s*:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i]);
    if (start !== null) {
      item = { provider: start[2], indent: start[1].length, model: null, values: {} };
      continue;
    }
    if (item === null) continue;
    const lead = indentOf(lines[i]);
    const trimmed = lines[i].trim();
    const colon = trimmed.indexOf(':');
    if (lead !== item.indent + 2 || colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    item.values[name] = value;
    if (name === 'model') item.model = unquote(value);
    if (item.provider === cfg.providerId && item.model === cfg.modelId && item.values[key] !== undefined) {
      matched = numberOr(item.values[key], 0);
    }
  }
  return matched;
}

/** 读当前 profile 的模型策略（面板与 /status 用）。 */
export function readModelPolicy(options = {}) {
  const patchPath = options.patchPath || patchPathFor(options.profile || 'desktop');
  const text = readTextOr(patchPath, '');
  if (text === '') return null;
  return parseModelPolicy(text.replace(/\r\n/g, '\n').split('\n'), {
    providerId: options.providerId || DEFAULTS.providerId,
    modelId: options.modelId || DEFAULTS.modelId,
    headroomTokens: options.headroomTokens,
  });
}
