/**
 * 基础工具：路径、文件、日志、错误、ID、格式化。
 * 设计约束：零第三方依赖，Node >= 22.5，Windows / macOS / Linux 行为一致。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export class FerryError extends Error {
  constructor(message, { code = 'EFERRY', hint = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FerryError';
    this.ferry = true;
    this.code = code;
    this.hint = hint;
  }
}

export function fail(message, opts) {
  throw new FerryError(message, opts);
}

/** 把一个操作包起来，失败时给出更贴近用户的说明。 */
export async function attempt(label, fn, opts = {}) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FerryError) throw err;
    throw new FerryError(`${label}失败：${err?.message || err}`, { ...opts, cause: err });
  }
}

/* ------------------------------------------------------------------ */
/* 时间 / ID                                                           */
/* ------------------------------------------------------------------ */

export function nowIso() {
  return new Date().toISOString();
}

export function isoFrom(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') {
    // 兼容秒 / 毫秒 / 微秒时间戳
    let ms = value;
    if (ms > 1e15) ms = ms / 1000; // 微秒
    if (ms < 1e11) ms = ms * 1000; // 秒
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function uid(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}${id}` : id;
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function shortHash(data, len = 12) {
  return sha256(data).slice(0, len);
}

/** 稳定排序后的 JSON 字符串，便于计算校验和。 */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

export function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 用于比较路径是否等价的归一化形式（Windows 下大小写不敏感）。 */
export function pathKey(p) {
  if (!p) return '';
  let s = path.normalize(String(p)).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') {
    s = s.toLowerCase().replace(/\//g, '\\');
    // C:\ 之类的根路径去掉尾部反斜杠会变成 C:，补回来
    if (/^[a-z]:$/.test(s)) s += '\\';
  }
  return s;
}

export function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

export function isSubPath(parent, child) {
  const p = pathKey(parent);
  const c = pathKey(child);
  if (!p || !c) return false;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 文件名安全化（保留中文与常见符号）。 */
export function safeName(name, fallback = 'untitled') {
  const s = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (s || fallback).slice(0, 80);
}

export function slugify(text) {
  return safeName(text, 'session')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

/* ------------------------------------------------------------------ */
/* 文件系统                                                            */
/* ------------------------------------------------------------------ */

export function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

export async function readText(p, fallback = NO_FALLBACK) {
  try {
    let s = await fsp.readFile(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== NO_FALLBACK) return fallback;
    throw err;
  }
}

const NO_FALLBACK = Symbol('no-fallback');

export async function readJson(p, fallback = NO_FALLBACK) {
  const text = await readText(p, null);
  if (text === null) {
    if (fallback !== NO_FALLBACK) return fallback;
    throw new FerryError(`找不到文件：${p}`, { code: 'ENOENT' });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (fallback !== NO_FALLBACK) return fallback;
    throw new FerryError(`JSON 解析失败：${p}（${err.message}）`, { code: 'EBADJSON' });
  }
}

export async function readJsonl(p) {
  const text = await readText(p, null);
  if (text === null) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 单行损坏不应让整个会话不可读：记录占位。
      out.push({ __ferryParseError: true, raw: t.slice(0, 2000) });
    }
  }
  return out;
}

export async function writeFileAtomic(p, data, { mode } = {}) {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.ferry-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data, mode ? { mode } : undefined);
  await fsp.rename(tmp, p);
  return p;
}

export async function writeJson(p, value) {
  return writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n');
}

/** 递归列出文件；默认跳过隐藏目录与 node_modules 等噪音。 */
export async function walkFiles(root, opts = {}) {
  const {
    filter = () => true,
    maxDepth = 12,
    includeDirs = false,
    skipHidden = false,
  } = opts;
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (skipHidden && ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (includeDirs) out.push({ path: full, dir: true, name: ent.name });
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (filter(full, ent.name)) out.push({ path: full, dir: false, name: ent.name });
      }
    }
  }
  return out;
}

export async function dirSize(p) {
  let total = 0;
  const files = await walkFiles(p, { maxDepth: 20 });
  for (const f of files) {
    const st = await statSafe(f.path);
    if (st) total += st.size;
  }
  return total;
}

export async function copyDir(src, dest) {
  await ensureDir(dest);
  await fsp.cp(src, dest, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function truncate(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function plural(n, one, many = one) {
  return `${n} ${n === 1 ? one : many}`;
}

/* ------------------------------------------------------------------ */
/* 日志 / 终端                                                         */
/* ------------------------------------------------------------------ */

const supportsColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const paint = (code) => (s) => (supportsColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
export const color = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

export function createLogger({ level = 'info', json = false, quiet = false } = {}) {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const threshold = order[quiet ? 'silent' : level] ?? 20;
  const emit = (lvl, msg, extra) => {
    if (order[lvl] < threshold) return;
    if (json) {
      process.stdout.write(JSON.stringify({ ts: nowIso(), level: lvl, msg, ...extra }) + '\n');
      return;
    }
    const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    const tag = { debug: color.gray('·'), info: color.cyan('›'), warn: color.yellow('!'), error: color.red('✖') }[lvl];
    stream.write(`${tag} ${msg}\n`);
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    step: (m) => emit('info', color.bold(m)),
    success: (m) => {
      if (json) return emit('info', m);
      process.stdout.write(`${color.green('✔')} ${m}\n`);
    },
    raw: (s) => process.stdout.write(s),
  };
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 极简 CLI 参数解析。
 *   --flag             => true
 *   --key value        => value
 *   --key=value        => value
 *   -o value           => value
 *   --no-x             => { x: false }
 *   剩余位置参数       => _
 * 可重复参数自动变数组（配合 repeat 列表）。
 */
export function parseArgs(argv, { repeat = [], booleans = [] } = {}) {
  const out = { _: [] };
  const repeatSet = new Set(repeat);
  const boolSet = new Set(booleans);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') {
      out._.push(arg);
      continue;
    }
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    let key;
    let value;
    let hasValue = false;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        key = body.slice(0, eq);
        value = body.slice(eq + 1);
        hasValue = true;
      } else {
        key = body;
      }
      if (key.startsWith('no-') && !hasValue) {
        out[key.slice(3)] = false;
        continue;
      }
    } else {
      key = ALIASES[arg.slice(1)] || arg.slice(1);
    }
    if (hasValue) {
      assign(key, value);
      continue;
    }
    const next = argv[i + 1];
    if (boolSet.has(key) || !next || (next.startsWith('-') && next !== '-')) {
      out[key] = true;
    } else {
      assign(key, next);
      i++;
    }
  }
  return out;

  function assign(key, value) {
    if (repeatSet.has(key)) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
}

const ALIASES = {
  o: 'out',
  t: 'to',
  a: 'agent',
  h: 'help',
  v: 'version',
  y: 'yes',
  p: 'port',
  j: 'json',
};

export function splitList(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .flatMap((v) => String(v).split(/[,;]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  const mul = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
  return Math.round(n * mul);
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 逐个处理并限制并发。 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
