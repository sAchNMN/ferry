/**
 * 适配器共用小工具。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, readText, safeName, truncate } from '../core/util.js';

/** 只读文件头部 N 字节，用于快速取标题（大会话文件不必整个读）。 */
export async function readHead(file, bytes = 64 * 1024) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** 从大文件里按块读取，逐行回调（避免一次读入 GB 级日志）。 */
export async function forEachLine(file, onLine, { maxBytes = Infinity } = {}) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  let read = 0;
  for await (const chunk of stream) {
    read += Buffer.byteLength(chunk, 'utf8');
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim()) await onLine(line);
    }
    if (read > maxBytes) break;
  }
  if (buf.trim()) await onLine(buf);
}

/** 去掉 ANSI 控制字符（很多终端 Agent 会写进日志）。 */
export function stripAnsi(s) {
  return String(s || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

export function firstLine(text, max = 80) {
  const clean = stripAnsi(String(text || '')).replace(/\s+/g, ' ').trim();
  return truncate(clean, max);
}

/** 按 cwd 找已存在的目录（大小写不敏感），找不到返回 null。 */
export async function findExistingDir(base, predicate) {
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(base, e.name);
    try {
      if (await predicate(full, e.name)) return full;
    } catch {
      // 单个目录读失败就跳过
    }
  }
  return null;
}

/** 备份单个文件（同目录 .ferry-bak），native 导入前调用。 */
export async function backupFile(file) {
  if (!(await exists(file))) return null;
  const dest = `${file}.ferry-bak-${Date.now()}`;
  await fsp.copyFile(file, dest);
  return dest;
}

export function sessionTitle(texts, fallback = '未命名会话') {
  for (const t of texts) {
    const s = firstLine(t, 100);
    if (s && s.length > 1) return s;
  }
  return fallback;
}

/** 把一段文本切成适合做文件名的片段（保留中文）。 */
export function titleSlug(title, fallback = 'session') {
  return safeName(title || fallback, fallback).slice(0, 48);
}

/** 构造一个简单的写入记录。 */
export function writeRecord(file, bytes, kind) {
  return { path: file, bytes: Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(String(bytes)), kind };
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, text, 'utf8');
}

export async function readJsonSafe(file, fallback = null) {
  try {
    const text = await readText(file, null);
    if (text == null) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
