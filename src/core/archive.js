/**
 * .ferrypack 归档格式
 *
 *   tar ──gzip──▶ [AES-256-GCM] ──▶ 文件
 *
 * 内部布局：
 *   manifest.json                 清单（格式版本、统计、校验和、来源）
 *   conversations/<id>.json       每个会话一份 UCM
 *   blobs/<sha256>                图片 / 附件（内容寻址，天然去重）
 *
 * 之所以用 tar 而不是 zip：tar 可以顺序流式写，配合 gzip 与加密都很干净；
 * 用户想"拆包看看"时，7-Zip / tar 也能直接打开。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTar, parseTar } from './tar.js';
import { encryptBuffer, decryptBuffer, isEncrypted } from './crypto.js';
import { validateConversation, conversationFingerprint, UCM_SCHEMA } from './ucm.js';
import {
  VERSION,
  FerryError,
  ensureDir,
  formatBytes,
  nowIso,
  sha256,
  shortHash,
  safeName,
} from './util.js';
import { assertSafeEntryName, assertSafeHash, createBudget, formatLimit, mergeLimits } from './limits.js';

export const PACK_FORMAT = 'ferrypack/1';
export const PACK_EXT = '.ferrypack';

const CONV_PREFIX = 'conversations/';
const BLOB_PREFIX = 'blobs/';
const PROJECT_PREFIX = 'projects/';

export function isPackFile(file) {
  return /\.ferrypack$/i.test(file) || /\.ferryp$/i.test(file);
}

/* ------------------------------------------------------------------ */
/* Blob 存储                                                           */
/* ------------------------------------------------------------------ */

export function createBlobStore() {
  const map = new Map();
  return {
    map,
    /** @returns {string} sha256 */
    add(data, { mime = 'application/octet-stream', name } = {}) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const hash = sha256(buf);
      if (!map.has(hash)) map.set(hash, { data: buf, mime, name });
      else if (name && !map.get(hash).name) map.get(hash).name = name;
      return hash;
    },
    get(hash) {
      return map.get(hash);
    },
    get size() {
      return map.size;
    },
    bytes() {
      let n = 0;
      for (const b of map.values()) n += b.data.length;
      return n;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 写归档                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string} file
 * @param {object} opts
 * @param {object[]} opts.conversations
 * @param {ReturnType<typeof createBlobStore>|Map} [opts.blobs]
 * @param {{id:string,name:string,originalPath:string,files:{path:string,data:Buffer,bytes?:number,sha256?:string}[]}[]} [opts.projects]
 * @param {string} [opts.password]
 * @param {object} [opts.meta] 额外写进 manifest 的信息
 */
export async function writePack(file, opts) {
  const { conversations, password, meta = {} } = opts;
  const blobs = opts.blobs?.map instanceof Map ? opts.blobs.map : new Map();
  if (!conversations?.length) {
    throw new FerryError('没有可导出的会话', { code: 'EEMPTY' });
  }

  const entries = [];
  const manifestConvs = [];
  const usedNames = new Set();
  let totalMessages = 0;
  let totalChars = 0;

  for (const conv of conversations) {
    const { conversation, issues } = validateConversation(conv);
    if (issues.length) conversation.meta = { ...(conversation.meta || {}), _issues: issues };

    let base = safeName(conversation.id, 'conversation');
    let name = `${CONV_PREFIX}${base}.json`;
    let n = 2;
    while (usedNames.has(name)) name = `${CONV_PREFIX}${base}-${n++}.json`;
    usedNames.add(name);

    const json = Buffer.from(JSON.stringify(conversation), 'utf8');
    entries.push({ name, data: json, mtime: new Date(conversation.updatedAt || Date.now()) });

    totalMessages += conversation.stats.messages;
    totalChars += conversation.stats.chars;
    manifestConvs.push({
      id: conversation.id,
      file: name,
      title: conversation.title,
      adapter: conversation.source.adapter,
      sourceName: conversation.source.name,
      workspace: conversation.workspace?.cwd || null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.stats.messages,
      toolCalls: conversation.stats.toolCalls,
      images: conversation.stats.images,
      chars: conversation.stats.chars,
      bytes: json.length,
      sha256: sha256(json),
      fingerprint: conversationFingerprint(conversation),
      model: conversation.model?.id || null,
    });
  }

  const manifestBlobs = [];
  for (const [hash, b] of blobs) {
    entries.push({ name: `${BLOB_PREFIX}${hash}`, data: b.data, mtime: new Date() });
    manifestBlobs.push({ sha256: hash, file: `${BLOB_PREFIX}${hash}`, bytes: b.data.length, mime: b.mime, name: b.name || null });
  }

  const manifestProjects = [];
  for (const project of opts.projects || []) {
    const id = String(project.id || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new FerryError(`项目编号不安全：${id}`, { code: 'EBADPROJECT' });
    const files = [];
    for (const projectFile of project.files || []) {
      assertSafeEntryName(projectFile.path);
      const data = Buffer.isBuffer(projectFile.data) ? projectFile.data : Buffer.from(projectFile.data || '');
      const name = `${PROJECT_PREFIX}${id}/${projectFile.path}`;
      entries.push({ name, data, mtime: new Date() });
      files.push({ path: projectFile.path, file: name, bytes: data.length, sha256: sha256(data) });
    }
    manifestProjects.push({
      id,
      name: safeName(project.name, 'project'),
      originalPath: project.originalPath,
      files,
      bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    });
  }

  const sources = [...new Set(manifestConvs.map((c) => c.adapter))].map((adapter) => ({
    adapter,
    conversations: manifestConvs.filter((c) => c.adapter === adapter).length,
  }));

  const manifest = {
    format: PACK_FORMAT,
    ucm: UCM_SCHEMA,
    createdAt: nowIso(),
    generator: { name: 'ferry', version: VERSION, url: 'https://github.com/ferry/ferry' },
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: safeHostname(),
      node: process.version,
      ...(meta.host || {}),
    },
    label: meta.label || null,
    encryption: password ? { enabled: true, cipher: 'aes-256-gcm', kdf: 'scrypt' } : { enabled: false },
    stats: {
      conversations: manifestConvs.length,
      messages: totalMessages,
      chars: totalChars,
      blobs: manifestBlobs.length,
      blobBytes: manifestBlobs.reduce((a, b) => a + b.bytes, 0),
      projects: manifestProjects.length,
      projectFiles: manifestProjects.reduce((a, project) => a + project.files.length, 0),
      projectBytes: manifestProjects.reduce((a, project) => a + project.bytes, 0),
      payloadBytes: entries.reduce((a, e) => a + (e.data?.length || 0), 0),
    },
    sources,
    conversations: manifestConvs,
    blobs: manifestBlobs,
    projects: manifestProjects,
    notes: meta.notes || [],
  };

  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: new Date() });

  const tar = createTar(entries);
  const gz = zlib.gzipSync(tar, { level: 9 });
  const output = password ? encryptBuffer(gz, password) : gz;

  manifest.stats.archiveBytes = output.length;

  await ensureDir(path.dirname(path.resolve(file)));
  await fsp.writeFile(file, output);
  return { manifest, bytes: output.length, file };
}

function safeHostname() {
  try {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 读归档                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string} file
 * @param {{password?: string, verify?: boolean}} [opts]
 */
export async function readPack(file, opts = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file);
  } catch (err) {
    throw new FerryError(`读不到归档：${file}`, { code: 'ENOENT', cause: err });
  }
  return readPackBuffer(raw, { ...opts, name: path.basename(file) });
}

/**
 * 带体积上限的 gunzip。
 *
 * 这是防压缩炸弹的第一道闸：gzip 的压缩比可以到 1000:1 以上，
 * 一个几十 KB 的文件解出来能塞满内存。`maxOutputLength` 让 zlib 在超限时直接抛错，
 * 不会先把几十 GB 分配出来再判断。
 */
function gunzipBounded(buf, limits) {
  try {
    return zlib.gunzipSync(buf, { maxOutputLength: limits.maxTotalBytes });
  } catch (err) {
    throw new FerryError(`归档解压失败或体积超出上限：${err.message}`, {
      code: 'ETOOLARGE',
      hint: `单次解压上限 ${formatLimit(limits.maxTotalBytes)}；确认归档可信后可调高 limits.maxTotalBytes。`,
      cause: err,
    });
  }
}

/** 从内存解析归档（Web UI 上传 / 测试都用它）。 */
export function readPackBuffer(raw, opts = {}) {
  const { password, verify = true } = opts;
  const limits = mergeLimits(opts.limits);
  let tarBuf;
  const warnings = [];

  if (isEncrypted(raw)) {
    if (!password) {
      throw new FerryError('该归档已加密，需要密码', { code: 'ENOPASS' });
    }
    const gz = decryptBuffer(raw, password);
    tarBuf = gunzipBounded(gz, limits);
  } else if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    tarBuf = gunzipBounded(raw, limits);
  } else if (raw.length > 262 && raw.toString('ascii', 257, 262) === 'ustar') {
    tarBuf = raw;
  } else {
    throw new FerryError('不是 Ferry 归档（既不是 gzip，也不是 tar）', {
      code: 'ENOTPACK',
      hint: '请确认选择的是 .ferrypack 文件。',
    });
  }

  const entries = parseTar(tarBuf);
  const budget = createBudget(limits);
  for (const e of entries) {
    assertSafeEntryName(e.name);
    budget.add(e.data.length, e.name);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) throw new FerryError('归档缺少 manifest.json', { code: 'EBADPACK' });

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (err) {
    throw new FerryError('manifest.json 解析失败', { code: 'EBADPACK', cause: err });
  }
  if (!String(manifest.format || '').startsWith('ferrypack/')) {
    throw new FerryError(`不认识的归档格式：${manifest.format}`, { code: 'EUNSUPPORTED' });
  }
  manifest.stats = { ...(manifest.stats || {}), archiveBytes: raw.length };

  const blobs = new Map();
  for (const b of manifest.blobs || []) {
    assertSafeHash(b.sha256);
    const e = byName.get(b.file);
    if (!e) {
      warnings.push(`附件缺失：${b.name || b.sha256}`);
      continue;
    }
    if (sha256(e.data) !== b.sha256) warnings.push(`附件校验失败：${b.name || b.sha256}`);
    blobs.set(b.sha256, { data: e.data, mime: b.mime, name: b.name || undefined });
  }

  const conversations = [];
  for (const c of manifest.conversations || []) {
    const e = byName.get(c.file);
    if (!e) {
      warnings.push(`会话缺失：${c.title}`);
      continue;
    }
    if (verify && c.sha256 && sha256(e.data) !== c.sha256) {
      throw new FerryError(`会话校验失败：${c.title}（归档可能损坏）`, {
        code: 'ECHECKSUM',
        hint: '可以尝试用 --no-verify 跳过校验导出可读部分。',
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(e.data.toString('utf8'));
    } catch (err) {
      warnings.push(`会话 JSON 损坏：${c.title}`);
      continue;
    }
    const { conversation, issues } = validateConversation(parsed);
    if (issues.length) warnings.push(`${c.title}: ${issues.join('；')}`);
    conversation.manifest = c;
    conversations.push(conversation);
  }

  const projects = [];
  for (const project of manifest.projects || []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(project.id || ''))) {
      throw new FerryError(`项目编号不合法：${project.id}`, { code: 'EBADPROJECT' });
    }
    const files = [];
    for (const item of project.files || []) {
      assertSafeEntryName(item.path);
      const entry = byName.get(item.file);
      if (!entry) {
        warnings.push(`项目文件缺失：${project.name || project.id}/${item.path}`);
        continue;
      }
      if (verify && item.sha256 && sha256(entry.data) !== item.sha256) {
        throw new FerryError(`项目文件校验失败：${project.name || project.id}/${item.path}`, {
          code: 'ECHECKSUM',
          hint: '归档可能损坏，请重新拷贝后再恢复。',
        });
      }
      files.push({ path: item.path, data: entry.data, bytes: entry.data.length, sha256: item.sha256 });
    }
    projects.push({ id: project.id, name: project.name, originalPath: project.originalPath, files, bytes: project.bytes || 0 });
  }

  return { manifest, conversations, blobs, projects, warnings, encrypted: isEncrypted(raw), bytes: raw.length };
}

/* ------------------------------------------------------------------ */
/* 概览 / 校验                                                         */
/* ------------------------------------------------------------------ */

export async function inspectPack(file, opts = {}) {
  const { manifest, warnings, bytes } = await readPack(file, { ...opts, verify: false });
  return { manifest, warnings, bytes };
}

/** 只解包到目录，便于人工检查 / 交给其他工具。 */
export async function unpackTo(file, dir, opts = {}) {
  const pack = await readPack(file, opts);
  await ensureDir(path.join(dir, 'conversations'));
  await ensureDir(path.join(dir, 'blobs'));
  await ensureDir(path.join(dir, 'projects'));
  for (const conv of pack.conversations) {
    await fsp.writeFile(
      path.join(dir, 'conversations', `${safeName(conv.id)}.json`),
      JSON.stringify(conv, null, 2),
      'utf8',
    );
  }
  for (const [hash, b] of pack.blobs) {
    assertSafeHash(hash);
    await fsp.writeFile(path.join(dir, 'blobs', hash), b.data);
  }
  for (const project of pack.projects || []) {
    const target = path.join(dir, 'projects', `${project.id}-${safeName(project.name, 'project')}`);
    for (const file of project.files || []) {
      assertSafeEntryName(file.path);
      const destination = path.join(target, ...file.path.split('/'));
      await ensureDir(path.dirname(destination));
      await fsp.writeFile(destination, file.data);
    }
  }
  const { manifest, ...rest } = pack;
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ manifest, warnings: rest.warnings }, null, 2), 'utf8');
  return { dir, conversations: pack.conversations.length, blobs: pack.blobs.size, projects: pack.projects?.length || 0 };
}

export function summarizeManifest(manifest) {
  const lines = [];
  lines.push(`格式      ${manifest.format}`);
  lines.push(`生成时间  ${manifest.createdAt}`);
  lines.push(`会话      ${manifest.stats.conversations} 个 / ${manifest.stats.messages} 条消息`);
  lines.push(`体积      ${formatBytes(manifest.stats.archiveBytes || manifest.stats.payloadBytes || 0)}（附件 ${formatBytes(manifest.stats.blobBytes || 0)}）`);
  if (manifest.stats.projects) lines.push(`项目      ${manifest.stats.projects} 个 / ${manifest.stats.projectFiles || 0} 个文件`);
  if (manifest.encryption?.enabled) lines.push(`加密      ${manifest.encryption.cipher}`);
  lines.push(`来源      ${(manifest.sources || []).map((s) => `${s.adapter}(${s.conversations})`).join(', ')}`);
  return lines.join('\n');
}

/** 校验文件是否为完整、未损坏的归档（不落盘）。 */
export async function verifyPack(file, opts = {}) {
  const pack = await readPack(file, { ...opts, verify: true });
  return {
    ok: true,
    conversations: pack.conversations.length,
    blobs: pack.blobs.size,
    warnings: pack.warnings,
    fingerprint: shortHash(JSON.stringify(pack.manifest.conversations.map((c) => c.sha256))),
  };
}
