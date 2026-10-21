/**
 * usage.js 纯函数冒烟：累计、峰值、连续天数、序列、脏数据修复。
 */
import assert from 'node:assert/strict';
import { blankUsage, dayKey, normalizeUsage, recordUsage, streaksOf, summarizeUsage } from '../lib/usage.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
}

const DAY = 86400000;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

ok('空状态形状完整且全为 0', () => {
  const usage = blankUsage();
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.requests, 0);
  assert.equal(usage.longestMs, 0);
  assert.deepEqual(usage.days, {});
});

ok('一笔请求累加 token 并按日归档', () => {
  const usage = recordUsage(blankUsage(), {
    at: at(2026, 10, 21),
    promptTokens: 100,
    completionTokens: 50,
    durationMs: 1200,
  });
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.promptTokens, 100);
  assert.equal(usage.completionTokens, 50);
  assert.equal(usage.requests, 1);
  assert.equal(usage.days['2026-10-21'].tokens, 150);
  assert.equal(usage.longestMs, 1200);
});

ok('同日两笔合并，total 优先于分项之和', () => {
  let usage = recordUsage(blankUsage(), { at: at(2026, 10, 21), promptTokens: 10, completionTokens: 5 });
  usage = recordUsage(usage, { at: at(2026, 10, 21, 18), promptTokens: 20, completionTokens: 10, totalTokens: 99 });
  assert.equal(usage.days['2026-10-21'].tokens, 114);
  assert.equal(usage.days['2026-10-21'].requests, 2);
  assert.equal(usage.totalTokens, 114);
});

ok('峰值记录单日最高', () => {
  let usage = recordUsage(blankUsage(), { at: at(2026, 10, 20), promptTokens: 100 });
  usage = recordUsage(usage, { at: at(2026, 10, 21), promptTokens: 500 });
  assert.equal(usage.peakDayTokens, 500);
  assert.equal(usage.peakDay, '2026-10-21');
});

ok('最长用时只记最大值', () => {
  let usage = recordUsage(blankUsage(), { at: at(2026, 10, 21), promptTokens: 1, durationMs: 900 });
  usage = recordUsage(usage, { at: at(2026, 10, 21), promptTokens: 1, durationMs: 4500 });
  usage = recordUsage(usage, { at: at(2026, 10, 21), promptTokens: 1, durationMs: 300 });
  assert.equal(usage.longestMs, 4500);
});

ok('连续天数：最长 3 天、当前 2 天', () => {
  let usage = blankUsage();
  for (const day of [18, 19, 20, 21, 22]) {
    if (day === 21) continue;
    usage = recordUsage(usage, { at: at(2026, 10, day), promptTokens: 10 });
  }
  // 18/19/20 连续 3 天；22 单独一天；"今天"= 2026-10-22
  const streaks = streaksOf(usage, at(2026, 10, 22, 23));
  assert.equal(streaks.longest, 3);
  assert.equal(streaks.current, 1);
});

ok('今天没用量时，当前连续天数从昨天往回数', () => {
  let usage = blankUsage();
  for (const day of [19, 20, 21]) usage = recordUsage(usage, { at: at(2026, 10, day), promptTokens: 10 });
  assert.equal(streaksOf(usage, at(2026, 10, 22, 9)).current, 3);
});

ok('summarize 产出定长序列并汇总窗口内用量', () => {
  let usage = blankUsage();
  usage = recordUsage(usage, { at: at(2026, 10, 20), promptTokens: 100 });
  usage = recordUsage(usage, { at: at(2026, 10, 22), promptTokens: 300 });
  const view = summarizeUsage(usage, { now: at(2026, 10, 22, 20), days: 30 });
  assert.equal(view.series.length, 30);
  assert.equal(view.series[29].date, '2026-10-22');
  assert.equal(view.series[29].tokens, 300);
  assert.equal(view.windowTokens, 400);
  assert.equal(view.totalTokens, 400);
  assert.equal(view.currentStreak, 1);
});

ok('normalizeUsage 修掉脏数据', () => {
  const usage = normalizeUsage({
    totalTokens: 'abc',
    days: { '2026-10-21': { tokens: 5, requests: 'x' }, bad: { tokens: 9 }, '2026-10-22': null },
    peakDayTokens: -3,
  });
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.days['2026-10-21'].tokens, 5);
  assert.equal(usage.days['2026-10-21'].requests, 0);
  assert.equal(usage.days.bad, undefined);
  assert.equal(usage.days['2026-10-22'], undefined);
  assert.equal(usage.peakDayTokens, 0);
});

ok('dayKey 用本地时区', () => {
  assert.equal(dayKey(at(2026, 1, 2)), '2026-01-02');
});

ok('recordUsage 不改入参', () => {
  const before = blankUsage();
  const after = recordUsage(before, { at: at(2026, 10, 21), promptTokens: 10 });
  assert.equal(before.totalTokens, 0);
  assert.equal(after.totalTokens, 10);
  assert.notEqual(before, after);
});

ok('窗口外历史仍计入累计但不进序列', () => {
  const usage = recordUsage(blankUsage(), { at: Date.now() - 400 * DAY, promptTokens: 777 });
  const view = summarizeUsage(usage, { days: 365 });
  assert.equal(view.totalTokens, 777);
  assert.equal(view.windowTokens, 0);
});

console.log(`\n${passed}/${passed} 通过`);
