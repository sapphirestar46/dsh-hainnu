/**
 * 模型策略离线测试：验证插件把本地调好的海师 deepseek 策略写进 profile。
 *
 * 覆盖：
 *   1) 压缩线公式（300,000 / 96,000 / 461 → 203,539）
 *   2) 全新 profile：补 provider、模型、压缩线按模型覆盖、默认模型
 *   3) 已有 461 全局余量：不写 modelPolicies，不产生改动（幂等，反复启动不 churn）
 *   4) contextWindow 不匹配时默认只提示不动；syncModelPolicy 才覆盖
 *   5) 默认模型指向别的 provider 时不抢
 *
 *   node test/modelconfig-smoke.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactionLine, ensureModelConfig, readModelPolicy } from '../lib/modelconfig.js';

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(['PASS', label]);
  } catch (error) {
    results.push(['FAIL', label + ' :: ' + String(error && error.message ? error.message : error)]);
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-hainnu-policy-'));
const files = [];
function fixture(name, text) {
  const file = path.join(dir, name);
  writeFileSync(file, text, 'utf8');
  files.push(file);
  return file;
}
function sync(file, extra = {}) {
  return ensureModelConfig({ patchPath: file, writeCredential: false, ...extra });
}
function text(file) {
  return readFileSync(file, 'utf8');
}

const PRESET = `- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
      - id: command-compact
        name: '@deepseek-ai/dsh-command-compact'
`;

const LLM_ENTRY = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      hainnu:
        displayName: DeepSeek V4.1 Flash (海师)
        apiKeyEnv: HAINNU_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8787/v1
        models:
          - id: deepseek-flash
            name: DeepSeek V4.1 Flash (海师)
            contextWindow: 300000
            maxTokens: 96000
            input:
              - text
              - image
            reasoningEfforts:
              off: none
              low: low
              max: max
        compat:
          thinkingFormat: deepseek
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        reasoning: max
`;

const USER_TUNED_COMPACTION = PRESET.replace(
  '        name: \'@deepseek-ai/dsh-compaction-basic\'\n',
  '        name: \'@deepseek-ai/dsh-compaction-basic\'\n        config:\n          headroomTokens: 461\n          maxTokens: 4000\n',
);

check('压缩线公式：300000/96000/461 → 203539', () => {
  assert.equal(compactionLine({ contextWindow: 300000, maxTokens: 96000, headroomTokens: 461 }), 203539);
  assert.equal(compactionLine({ contextWindow: 300000, maxTokens: 96000, headroomTokens: 65536 }), 138464);
  // W×ratio 才是瓶颈时按 80% 封顶
  assert.equal(compactionLine({ contextWindow: 500000, maxTokens: 32768, headroomTokens: 461 }), 400000);
  // 余量把预算吃穿 → 视为无效
  assert.equal(compactionLine({ contextWindow: 100000, maxTokens: 90000, headroomTokens: 20000 }), 0);
});

check('全新 profile：补 provider + 模型 + 压缩线 + 默认模型', () => {
  const file = fixture('fresh.yml', PRESET);
  const result = sync(file);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changed, true);
  const out = text(file);
  assert.match(out, /contextWindow: 300000/);
  assert.match(out, /maxTokens: 96000/);
  assert.match(out, /reasoningEfforts:/);
  assert.match(out, /thinkingFormat: deepseek/);
  assert.match(out, /- provider: hainnu\n\s+model: deepseek-flash\n\s+headroomTokens: 461\n\s+maxTokens: 4000/);
  assert.match(out, /- id: agent-default-model/);
  assert.match(out, /reasoningEffort: max/);
  // 嵌套 config 必须落在 compaction-basic 行内、且缩进正确
  const lines = out.split('\n');
  const row = lines.findIndex((line) => line.trim() === '- id: compaction-basic');
  assert.ok(row >= 0);
  assert.match(lines[row + 2], /^ {8}config:$/);
  assert.match(lines[row + 3], /^ {10}modelPolicies:$/);
  assert.match(lines[row + 4], /^ {12}- provider: hainnu$/);
  const parsed = readModelPolicy({ patchPath: file });
  assert.equal(parsed.model.contextWindow, 300000);
  assert.equal(parsed.model.maxTokens, 96000);
  assert.equal(parsed.effectiveCompactionLine, 203539);
  assert.equal(parsed.targetCompactionLine, 203539);
  assert.equal(parsed.defaultModel.provider, 'hainnu');
});

check('幂等：第二次运行不改文件', () => {
  const file = fixture('idempotent.yml', PRESET);
  sync(file);
  const first = text(file);
  const second = sync(file);
  assert.equal(second.changed, false);
  assert.equal(text(file), first);
});

const SYNCED_DEFAULT = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: hainnu
    model: deepseek-flash
    reasoningEffort: max
`;

check('已有 461 全局余量：不写按模型覆盖', () => {
  const file = fixture('tuned.yml', USER_TUNED_COMPACTION + LLM_ENTRY + SYNCED_DEFAULT);
  const before = text(file);
  const result = sync(file);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changed, false);
  assert.equal(text(file), before);
  assert.doesNotMatch(text(file), /modelPolicies/);
  assert.equal(readModelPolicy({ patchPath: file }).effectiveCompactionLine, 203539);
});

check('contextWindow 不匹配：默认只提示，syncModelPolicy 才校正', () => {
  const stale = LLM_ENTRY.replace('contextWindow: 300000', 'contextWindow: 210000');
  const file = fixture('stale.yml', PRESET + '\n' + stale);
  const first = sync(file);
  assert.equal(first.changed, true);
  assert.match(text(file), /contextWindow: 210000/);
  assert.ok(first.notes.some((note) => note.includes('syncModelPolicy')));
  // 210,000 的窗口下，461 余量只能把压缩线推到 113,539
  assert.equal(readModelPolicy({ patchPath: file }).effectiveCompactionLine, 113539);

  const second = sync(file, { syncModelPolicy: true });
  assert.equal(second.changed, true);
  assert.match(text(file), /contextWindow: 300000/);
  assert.equal(readModelPolicy({ patchPath: file }).effectiveCompactionLine, 203539);
});

check('默认模型指向别的 provider 时不抢', () => {
  const other = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: xiaoluo
    model: deepseek-v4.1-flash
`;
  const file = fixture('foreign-default.yml', PRESET + '\n' + LLM_ENTRY + '\n' + other);
  sync(file);
  const out = text(file);
  assert.match(out, /provider: xiaoluo/);
  assert.doesNotMatch(out, /provider: hainnu\n    model: deepseek-flash\n    reasoningEffort/);
});

check('没有 compaction-basic 时不报错，只记一跳过的说明', () => {
  const file = fixture('nocompact.yml', '- id: preset-standard\n  name: x\n');
  const result = sync(file);
  assert.deepEqual(result.problems, []);
  assert.ok(result.notes.some((note) => note.includes('没有 compaction-basic')));
  assert.match(text(file), /contextWindow: 300000/);
});

let failed = 0;
for (const [kind, label] of results) {
  if (kind === 'FAIL') failed += 1;
  console.log(`${kind === 'PASS' ? '  ok ' : 'FAIL '} ${label}`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
