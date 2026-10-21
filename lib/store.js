/**
 * 状态与密钥持久化。
 *
 * 布局（在 $DSH_HOME/hainnu/ 下）：
 *   state.json  账号名、令牌密文、开关、上次错误等非明文信息
 *
 * 密码/令牌一律加密后再落盘：
 *   - Electron 主进程里优先用 safeStorage（Windows 上就是 DPAPI，和旧项目一致）；
 *   - 拿不到 safeStorage 时退回 AES-256-GCM + 本机派生密钥（只防"顺手看到"，不等于强保护）。
 * 任何情况下都不把明文写进日志、也不通过 HTTP 接口回传。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireHere = createRequire(import.meta.url);

/** $DSH_HOME（DSH 的数据目录）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(homedir(), '.dsh');
}

export function dataDir() {
  return path.join(dshHome(), 'hainnu');
}

export function statePath() {
  return path.join(dataDir(), 'state.json');
}

function safeStorage() {
  try {
    const electron = requireHere('electron');
    const storage = electron?.safeStorage;
    if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable()) {
      return storage;
    }
  } catch {
    /* 不在 Electron 主进程里，走 GCM */
  }
  return null;
}

function fallbackKey() {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = 'unknown';
  }
  return createHash('sha256').update(`dsh-hainnu|${hostname()}|${user}|v1`).digest();
}

/** 加密一个字符串，返回可落盘的密文标记。 */
export function seal(plain) {
  const text = String(plain === undefined || plain === null ? '' : plain);
  if (text === '') return '';
  const storage = safeStorage();
  if (storage !== null) {
    try {
      return `ss1:${storage.encryptString(text).toString('base64')}`;
    } catch {
      /* 继续退回 GCM */
    }
  }
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', fallbackKey(), iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `gcm1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  } catch {
    return '';
  }
}

/** 解密 seal() 的结果；失败返回空串。 */
export function unseal(blob) {
  const text = String(blob === undefined || blob === null ? '' : blob);
  if (text === '') return '';
  try {
    if (text.startsWith('ss1:')) {
      const storage = safeStorage();
      if (storage === null) return '';
      return storage.decryptString(Buffer.from(text.slice(4), 'base64'));
    }
    if (text.startsWith('gcm1:')) {
      const raw = Buffer.from(text.slice(5), 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const body = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', fallbackKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

function blankState() {
  return {
    version: 1,
    username: '',
    displayName: '',
    secret: '',
    token: '',
    tokenAt: 0,
    expiresAt: 0,
    autoLogin: true,
    autoStart: true,
    lastLoginAt: 0,
    lastError: '',
    models: [],
    configAppliedAt: 0,
    configNote: '',
  };
}

export function loadState() {
  const file = statePath();
  if (!existsSync(file)) return blankState();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return blankState();
    return { ...blankState(), ...parsed, version: 1 };
  } catch {
    return blankState();
  }
}

/** 原子写 state.json（先写 .tmp 再 rename）。 */
export function saveState(state) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = statePath();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function readPassword(state) {
  return unseal(state.secret || '');
}

export function readToken(state) {
  return unseal(state.token || '');
}

/** 令牌剩余有效毫秒（未知返回 0）。 */
export function tokenRemaining(state) {
  const expiresAt = Number(state.expiresAt) || 0;
  if (expiresAt <= 0) return 0;
  return Math.max(0, expiresAt - Date.now());
}

/** 解析 JWT 的 exp（毫秒）；解析不出返回 0。 */
export function jwtExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return 0;
    return exp * 1000;
  } catch {
    return 0;
  }
}

/** 给前端看的状态：绝不含密码/令牌明文。 */
export function publicState(state) {
  return {
    username: state.username || '',
    displayName: state.displayName || '',
    hasPassword: (state.secret || '') !== '',
    hasToken: (state.token || '') !== '',
    tokenAt: Number(state.tokenAt) || 0,
    expiresAt: Number(state.expiresAt) || 0,
    autoLogin: state.autoLogin !== false,
    autoStart: state.autoStart !== false,
    lastLoginAt: Number(state.lastLoginAt) || 0,
    lastError: state.lastError || '',
    models: Array.isArray(state.models) ? state.models : [],
    configAppliedAt: Number(state.configAppliedAt) || 0,
    configNote: state.configNote || '',
  };
}
