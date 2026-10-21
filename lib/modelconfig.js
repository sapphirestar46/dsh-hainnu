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
  displayName: 'DeepSeek V4.1 Flash (海师)',
  apiKeyEnv: 'HAINNU_API_KEY',
  apiKey: 'sk-hainnu',
  modelId: 'deepseek-flash',
  modelName: 'DeepSeek V4.1 Flash (海师)',
  contextWindow: 210000,
  maxTokens: 96000,
  reasoning: 'max',
};

const LLM_ENTRY_ID = 'llm-pi-ai';
const LLM_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai';

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

function modelLines(indent, cfg) {
  const i2 = indent + 2;
  return [
    `${sp(indent)}- id: ${cfg.modelId}`,
    `${sp(i2)}name: ${cfg.modelName}`,
    `${sp(i2)}contextWindow: ${cfg.contextWindow}`,
    `${sp(i2)}maxTokens: ${cfg.maxTokens}`,
    `${sp(i2)}input:`,
    `${sp(i2 + 2)}- text`,
    `${sp(i2 + 2)}- image`,
    `${sp(i2)}reasoningEfforts:`,
    `${sp(i2 + 2)}off: none`,
    `${sp(i2 + 2)}low: low`,
    `${sp(i2 + 2)}max: max`,
  ];
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
    ...modelLines(i4, cfg),
    `${sp(i2)}compat:`,
    `${sp(i4)}thinkingFormat: deepseek`,
    `${sp(i4)}supportsDeveloperRole: false`,
    `${sp(i4)}maxTokensField: max_tokens`,
    `${sp(i2)}reasoning: ${cfg.reasoning}`,
  ];
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
  if (findKeyLine(lines, provIdx + 1, blockEnd(lines, provIdx, providerIndent), 'displayName', providerIndent + 2) === null) {
    if (setScalar(lines, provIdx, blockEnd(lines, provIdx, providerIndent), 'displayName', cfg.displayName, providerIndent + 2)) {
      notes.push('已补上 displayName');
      changed = true;
    }
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

  // models 列表：只保证目标模型存在，不动用户已经调过的 contextWindow/maxTokens。
  let modelIndent = providerIndent + 2;
  let modelsIdx = findKeyLine(lines, provIdx, blockEnd(lines, provIdx, providerIndent), 'models', modelIndent);
  if (modelsIdx === null) {
    const insertAt = blockEnd(lines, provIdx, providerIndent);
    lines.splice(insertAt, 0, `${sp(modelIndent)}models:`, ...modelLines(modelIndent + 2, cfg));
    notes.push(`已为 provider「${cfg.providerId}」补上 models 段`);
    changed = true;
  } else {
    const modelsEnd = blockEnd(lines, modelsIdx.index, modelIndent);
    const modelRe = new RegExp(`^ {${modelIndent + 2}}-\\s+id\\s*:\\s*['"]?${escapeRe(cfg.modelId)}['"]?\\s*$`);
    let found = false;
    for (let i = modelsIdx.index + 1; i < modelsEnd; i += 1) {
      if (modelRe.test(lines[i])) {
        found = true;
        break;
      }
    }
    if (!found) {
      lines.splice(modelsEnd, 0, ...modelLines(modelIndent + 2, cfg));
      notes.push(`已为 provider「${cfg.providerId}」新增模型 ${cfg.modelId}`);
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
    const modelRe = new RegExp(`^ {10}-\\s+id\\s*:\\s*['"]?${escapeRe(cfg.modelId)}['"]?\\s*$`);
    let found = false;
    for (let i = models.index + 1; i < blockEnd(lines, models.index, 8); i += 1) {
      if (modelRe.test(lines[i])) {
        found = true;
        break;
      }
    }
    if (!found) problems.push(`模型 ${cfg.modelId} 缺失`);
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
