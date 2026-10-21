/**
 * 代理用量统计：只统计经过本插件代理、且上游回报了 usage 的对话请求。
 *
 * 数据形状（存进 state.json 的 usage 字段）：
 *   { version, requests, promptTokens, completionTokens, totalTokens,
 *     longestMs, longestAt, peakDayTokens, peakDay, days: { 'YYYY-MM-DD': {...} }, updatedAt }
 *
 * 这里只做纯函数，不碰磁盘——持久化交给 store.js / index.js。
 */

const DAY = 86400000;

/** 本地时区的日期键 YYYY-MM-DD。 */
export function dayKey(at) {
  const date = new Date(Number(at) || 0);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function blankUsage() {
  return {
    version: 1,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    longestMs: 0,
    longestAt: 0,
    peakDayTokens: 0,
    peakDay: '',
    days: {},
    updatedAt: 0,
  };
}

function emptyDay() {
  return { tokens: 0, requests: 0, longestMs: 0 };
}

/** 把磁盘上可能残缺的旧数据补齐成合法形状。 */
export function normalizeUsage(raw) {
  const base = blankUsage();
  if (raw === null || typeof raw !== 'object') return base;
  const days = {};
  const source = raw.days !== null && typeof raw.days === 'object' ? raw.days : {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const tokens = count(value?.tokens);
    const requests = count(value?.requests);
    const longestMs = count(value?.longestMs);
    if (tokens === 0 && requests === 0) continue;
    days[key] = { tokens, requests, longestMs };
  }
  return {
    version: 1,
    requests: count(raw.requests),
    promptTokens: count(raw.promptTokens),
    completionTokens: count(raw.completionTokens),
    totalTokens: count(raw.totalTokens),
    longestMs: count(raw.longestMs),
    longestAt: count(raw.longestAt),
    peakDayTokens: count(raw.peakDayTokens),
    peakDay: typeof raw.peakDay === 'string' ? raw.peakDay : '',
    days,
    updatedAt: count(raw.updatedAt),
  };
}

/**
 * 记一笔成功请求。
 * sample: { at, promptTokens, completionTokens, totalTokens, durationMs }
 * 返回新对象（不修改入参），方便测试与并发安全。
 */
export function recordUsage(usage, sample) {
  const base = normalizeUsage(usage);
  const at = count(sample?.at) || Date.now();
  const promptTokens = count(sample?.promptTokens);
  const completionTokens = count(sample?.completionTokens);
  const reported = count(sample?.totalTokens);
  const totalTokens = reported > 0 ? reported : promptTokens + completionTokens;
  const durationMs = count(sample?.durationMs);
  const key = dayKey(at);

  const next = {
    ...base,
    requests: base.requests + 1,
    promptTokens: base.promptTokens + promptTokens,
    completionTokens: base.completionTokens + completionTokens,
    totalTokens: base.totalTokens + totalTokens,
    days: { ...base.days },
    updatedAt: at,
  };

  const day = { ...emptyDay(), ...(base.days[key] || {}) };
  day.tokens += totalTokens;
  day.requests += 1;
  if (durationMs > day.longestMs) day.longestMs = durationMs;
  next.days[key] = day;

  if (durationMs > base.longestMs) {
    next.longestMs = durationMs;
    next.longestAt = at;
  }
  if (day.tokens >= next.peakDayTokens) {
    next.peakDayTokens = day.tokens;
    next.peakDay = key;
  }
  return next;
}

function daysBefore(at, span) {
  return at - (span - 1) * DAY;
}

/** 连续天数：longest 全部历史，current 截止今天（今天还没用量则从昨天算）。 */
export function streaksOf(usage, now) {
  const days = usage?.days !== null && typeof usage?.days === 'object' ? usage.days : {};
  const keys = Object.keys(days)
    .filter((key) => count(days[key]?.tokens) > 0)
    .sort();
  let longest = 0;
  let run = 0;
  let prev = '';
  for (const key of keys) {
    run = prev !== '' && Date.parse(`${key}T00:00:00`) - Date.parse(`${prev}T00:00:00`) === DAY ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = key;
  }
  const has = (key) => keys.includes(key);
  let cursor = count(now) || Date.now();
  if (!has(dayKey(cursor))) cursor -= DAY;
  let current = 0;
  while (has(dayKey(cursor))) {
    current += 1;
    cursor -= DAY;
  }
  return { longest, current };
}

/**
 * 给客户端渲染用。
 * options: { now, days } —— days 是热力图回看的自然日数（默认 365）。
 */
export function summarizeUsage(usage, options = {}) {
  const base = normalizeUsage(usage);
  const now = count(options.now) || Date.now();
  const span = Math.max(1, count(options.days) || 365);
  const series = [];
  const from = daysBefore(now, span);
  for (let i = 0; i < span; i += 1) {
    const key = dayKey(from + i * DAY);
    const day = base.days[key];
    series.push({ date: key, tokens: count(day?.tokens), requests: count(day?.requests) });
  }
  const anyTokens = series.reduce((sum, item) => sum + item.tokens, 0);
  const streaks = streaksOf({ ...base, days: base.days }, now);
  return {
    requests: base.requests,
    totalTokens: base.totalTokens,
    promptTokens: base.promptTokens,
    completionTokens: base.completionTokens,
    peakDayTokens: base.peakDayTokens,
    peakDay: base.peakDay,
    longestMs: base.longestMs,
    longestAt: base.longestAt,
    longestStreak: streaks.longest,
    currentStreak: streaks.current,
    windowTokens: anyTokens,
    series,
    updatedAt: base.updatedAt,
  };
}
