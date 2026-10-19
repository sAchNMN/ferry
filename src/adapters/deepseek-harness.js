/**
 * DeepSeek Harness 本地会话适配器。
 *
 * 读：Harness 的会话是项目目录下的事件日志（当前是 `session.v4.jsonl.zstd`，
 * 早期版本是未压缩的 `session*.jsonl`）。事件溯源结构先归一化成 UCM，再交给核心。
 *
 * 写：v4 的格式契约（header、turn/step 生命周期、工具调用的预告/结算配对、
 * zstd 帧布局）在 `deepseek-harness-write.js` 里实现；生成的事件流可以再被本适配器
 * 读回，也用 Harness 自己的 v4 解码器离线校验过。系统提示词与思考过程不迁移。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as zlib from 'node:zlib';

import { defineStore } from '../core/adapter.js';
import { block, createConversation, deriveTitle } from '../core/ucm.js';
import { exists, existsSync, FerryError, isoFrom, uid } from '../core/util.js';
import { readHead } from './_shared.js';
import {
  attachSessionToWorkspace,
  buildSessionLog,
  encodeSessionFile,
  serializeWorkspaceIndex,
  sessionLogPath,
} from './deepseek-harness-write.js';

/**
 * 会话文件名。实测（2026-10-19 本机）是 `session.v4.jsonl.zstd`，
 * 带格式版本号；早期只认 `session.jsonl` / `session.jsonl.zstd` 导致扫描结果为 0。
 * 只选择规范文件名；v3 / v4 可读，更高版本可扫描但读取时显式拒绝。
 * 同一目录残留多个版本时只认最新的一个（旧版本常是没有内容的空壳）。
 */
function isSessionFile(name) {
  return /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name);
}

export default defineStore({
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  vendor: 'DeepSeek',
  category: 'framework',
  region: 'global',
  docs: 'https://github.com/deepseek-ai/deepseek-harness',
  capabilities: {
    scan: true,
    export: true,
    import: true,
    resume: true,
    attachments: false,
    tools: true,
  },

  async scan(env) {
    const out = [];
    for (const root of rootsFor(env)) {
      if (!(await exists(root))) continue;
      await walk(root, async (file) => {
        const name = path.basename(file);
        if (!isSessionFile(name)) return;
        const header = await readHeader(file);
        if (!header) return;
        const st = await fsp.stat(file).catch(() => null);
        const title = await readTitle(file, header);
        out.push({
          id: header.id,
          title,
          path: file,
          createdAt: isoFrom(header.createdAt),
          updatedAt: st?.mtime?.toISOString(),
          bytes: st?.size,
          workspace: header.cwd,
          preview: title,
          meta: {
            root,
            compressed: name.endsWith('.zstd'),
            version: header.version,
          },
        });
      });
    }
    return dedupeRefs(out);
  },

  async read(env, ref) {
    try {
      return await readConversation(ref);
    } catch (cause) {
      throw new FerryError(`读取 DeepSeek Harness 会话失败：${ref.path}`, {
        code: 'EREAD',
        hint: cause.message,
        cause,
      });
    }
  },

  /** 写入一条 v4 会话；`opts.dryRun` 时只计算路径与字节数，零写盘。 */
  async import(env, conv, opts = {}) {
    return writeConversation(env, conv, opts);
  },

  /** 与 import 共用同一份计划逻辑，契约要求预演与实际写入完全一致。 */
  async planImport(env, conv, opts = {}) {
    return writeConversation(env, conv, { ...opts, dryRun: true });
  },

  /**
   * 导入会改写 `storages/workspace.json`（侧栏的 workspace 记账）。
   * 文件不存在时返回空数组，避免回滚去删一个这次根本没改的文件。
   */
  backupScope(env) {
    const file = workspaceIndexPath(env);
    return existsSync(file) ? [file] : [];
  },

  resumeHint() {
    return RESUME_HINT;
  },
});

const RESUME_HINT =
  '先退出 DeepSeek Harness，再重新打开：会在左侧历史列表里看到该会话，点开即可继续发消息。（正在运行的应用不会自动发现磁盘上的新会话。）';

/**
 * 选择导入后的项目目录：显式 --workspace 优先，其次源会话工作区，最后当前目录。
 * Harness 的 header.cwd 必须是绝对路径，否则它自己的 header 校验会拒收。
 */
function importCwd(env, conv, opts) {
  for (const candidate of [opts.workspace, conv?.workspace?.cwd, env.cwd]) {
    if (typeof candidate === 'string' && candidate && path.isAbsolute(candidate)) return candidate;
  }
  return path.resolve(env.cwd || '.');
}

/** Harness 的会话根目录（写回固定用当前版本的 ~/.dsh，不猜历史目录）。 */
function sessionRoot(env) {
  return path.join(dshHome(env), 'sessions');
}

function dshHome(env) {
  return env.dshHome || path.join(env.home, '.dsh');
}

function workspaceIndexPath(env) {
  return path.join(dshHome(env), 'storages', 'workspace.json');
}

/** Harness 用 fs.realpath 作为 workspace 路径的唯一规范；目录不存在时退回归一化路径。 */
async function canonicalPath(value) {
  try {
    return await fsp.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function writeConversation(env, conv, opts = {}) {
  const requested = importCwd(env, conv, opts);
  const canonical = await canonicalPath(requested);
  const sessionId = uid('session-');
  const indexFile = workspaceIndexPath(env);

  let index = null;
  try {
    index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  } catch {
    index = null;
  }

  let attached = null;
  if (index) {
    try {
      attached = attachSessionToWorkspace(index, {
        sessionId,
        cwd: canonical,
        createdAt: conv.createdAt,
        platform: env.platform,
      });
    } catch (cause) {
      throw new FerryError('DeepSeek Harness 的 workspace 索引无法识别，已中止导入以免破坏它', {
        code: 'EIMPORT',
        hint: `${cause.message}；请先退出 Harness，备份或删除 ${indexFile} 后重试`,
        cause,
      });
    }
  }

  const cwd = attached?.workspacePath || canonical;
  const session = buildSessionLog(conv, { cwd, sessionId, createdAt: conv.createdAt });
  const isConversation = session.events.some((event) => event.type === 'user/message' || event.type === 'assistant/message');
  if (!isConversation) {
    throw new FerryError('这条会话没有可写入的对话内容', {
      code: 'EIMPORT',
      hint: '只有系统消息、空消息或无法配对的工具调用；换一条会话再试',
    });
  }

  let buffer;
  try {
    buffer = encodeSessionFile(session);
  } catch (cause) {
    throw new FerryError('无法生成 DeepSeek Harness 会话文件', {
      code: 'EWRITE',
      hint: cause.message,
      cause,
    });
  }

  const root = sessionRoot(env);
  const file = sessionLogPath(root, cwd, session.sessionId);
  const writes = [{ path: file, kind: 'deepseek-harness-session', bytes: buffer.length }];
  const indexBytes = attached ? Buffer.from(serializeWorkspaceIndex(attached.index), 'utf8') : null;
  if (indexBytes) writes.push({ path: indexFile, kind: 'deepseek-harness-workspace-index', bytes: indexBytes.length });

  const notes = [];
  if (!index) {
    notes.push('没有找到 workspace 索引：Harness 首次启动时会按会话目录自动归组');
  } else if (!attached) {
    notes.push(
      index.global?.initialized === true
        ? '会话已经登记在 workspace 索引里，无需重复写入'
        : 'workspace 索引尚未初始化：Harness 首次启动时会按会话目录自动归组',
    );
  } else if (attached.created) {
    notes.push(`已在 workspace 索引里新建项目「${path.basename(attached.workspacePath)}」`);
  } else {
    notes.push('已把会话登记到现有项目的 workspace 索引');
  }
  notes.push('导入前请退出 Harness；运行中的应用会用自己的内存状态覆盖 workspace 索引');
  for (const loss of session.losses) notes.push(loss.detail);
  if (!existsSync(cwd)) {
    notes.push(`目标目录在本机不存在：${cwd}；Harness 会过滤掉这个会话，先创建目录再重启`);
  }

  if (!opts.dryRun) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await fsp.writeFile(file, buffer, { flag: 'wx' });
    } catch (cause) {
      throw new FerryError(`写入 DeepSeek Harness 会话失败：${file}`, {
        code: 'EWRITE',
        hint: cause.code === 'EEXIST' ? '同名会话已经存在；换一个会话或先删除旧文件' : cause.message,
        cause,
      });
    }

    if (indexBytes) {
      try {
        await writeFileAtomic(indexFile, indexBytes);
      } catch (cause) {
        await fsp.rm(file, { force: true }).catch(() => {});
        throw new FerryError(`更新 DeepSeek Harness workspace 索引失败：${indexFile}`, {
          code: 'EWRITE',
          hint: `${cause.message}；请先退出 Harness 再重试（会话文件已回滚）`,
          cause,
        });
      }
    }
  } else {
    notes.push('预演：只计算会话文件与 workspace 索引的写入清单，不创建目录、不写文件');
  }

  return {
    writes,
    sessionId: session.sessionId,
    losses: session.losses,
    notes,
    resume: { sessionId: session.sessionId, cwd },
  };
}

/** 先写临时文件再改名，避免 Harness 读到写了一半的 workspace.json。 */
async function writeFileAtomic(file, buffer) {
  const tmp = `${file}.ferry-${process.pid}-${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, file);
  } catch (cause) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
}

async function readConversation(ref) {
  const records = parseRecords(await readLog(ref.path));
  const header = records[0];
  if (!isSessionHeader(header)) throw new Error('DeepSeek Harness 会话缺少有效 session 首行');
  assertSupportedVersion(header.version);

  const messages = [];
  const titles = [];
  const seenCalls = new Set();
  const unknown = [];
  let model;

  for (const event of records.slice(1)) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.surfaceOp && event.surfaceOp !== 'append') {
      throw new Error('暂不支持含 surface 替换的 Harness 会话，请先通过 Harness 导出当前对话');
    }
    const time = isoFrom(event.time);
    const data = event.data;

    if (event.type === 'session/title') {
      const title = data?.title || data?.name;
      if (title) titles.push(String(title));
      continue;
    }
    if (event.type === 'request/context') {
      if (data?.model) model = { id: String(data.model), provider: data.provider };
      continue;
    }
    if (event.type === 'request/header') {
      const config = data?.header?.config;
      if (config?.model) model = { id: String(config.model), provider: config.provider };
      continue;
    }

    if (event.type === 'user/message') {
      appendMessage(messages, data, 'user', time, seenCalls);
    } else if (event.type === 'system/message') {
      appendMessage(messages, data?.message || data, 'system', time, seenCalls);
    } else if (event.type === 'developer/message') {
      appendMessage(messages, data?.message || data, 'system', time, seenCalls);
    } else if (event.type === 'assistant/message') {
      const message = data?.message || data;
      const sourceModel = message?.source?.model || message?.model;
      if (sourceModel) model = { id: String(sourceModel), provider: message.source?.provider };
      appendMessage(messages, message, 'assistant', time, seenCalls);
    } else if (event.type === 'tool/result') {
      appendMessage(messages, data?.message || data, 'tool', time, seenCalls);
    } else if (event.type === 'tool/call') {
      const callId = String(data?.callId || data?.id || '');
      if (callId && seenCalls.has(callId)) continue;
      const input = parseArguments(data?.arguments ?? data?.input);
      if (data?.name) {
        messages.push({
          id: uid('m_'),
          role: 'assistant',
          createdAt: time,
          blocks: [block.toolCall(String(data.name), input, callId || undefined)],
        });
        if (callId) seenCalls.add(callId);
      }
    } else if (event.type.startsWith('plugin:') && event.ignorable) {
      continue;
    } else if (!['turn/start', 'turn/end', 'step/start', 'step/end', 'session/end-seed', 'sandbox/mode', 'approval/policy', 'permission/preset'].includes(event.type)) {
      unknown.push(event.type);
    }
  }

  const title = titles.at(-1) || ref.title || deriveTitle({ messages });
  const conv = createConversation({
    id: header.id,
    title,
    createdAt: isoFrom(header.createdAt) || messages[0]?.createdAt,
    updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
    source: {
      adapter: 'deepseek-harness',
      name: 'DeepSeek Harness',
      vendor: 'DeepSeek',
      sessionId: header.id,
      path: ref.path,
      officialUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    },
    workspace: header.cwd ? { cwd: header.cwd } : undefined,
    model,
    messages,
    meta: {
      formatVersion: header.version,
      isSeeded: Boolean(header.isSeeded),
      delegationDepth: header.delegationDepth || 0,
      ...(unknown.length ? { unknownEvents: [...new Set(unknown)] } : {}),
    },
  });
  return conv;
}

function rootsFor(env) {
  return unique([
    env.dshHome && path.join(env.dshHome, 'sessions'),
    path.join(env.home, '.dsh', 'sessions'),
    path.join(env.home, '.deepseek-harness', 'sessions'),
    path.join(env.home, '.config', 'deepseek-harness', 'sessions'),
    path.join(env.appData, 'DeepSeek', 'sessions'),
    path.join(env.localAppData, 'DeepSeek', 'sessions'),
  ]);
}

async function walk(root, onFile) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const latest = entries
    .filter((entry) => entry.isFile() && isSessionFile(entry.name))
    .sort((a, b) => generation(b.name) - generation(a.name))[0];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(file, onFile);
    else if (entry === latest) await onFile(file);
  }
}

function generation(name) {
  return Number(/\.v(\d+)\./.exec(name)?.[1] || 0);
}

async function readLog(file) {
  const raw = await fsp.readFile(file);
  if (!file.endsWith('.zstd')) return raw.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('当前 Node 不支持读取 DeepSeek Harness 的 .jsonl.zstd 会话，请升级 Node');
  return decompressZstdFrames(raw).toString('utf8');
}

function decompressZstdFrames(raw) {
  const chunks = [];
  let offset = 0;
  while (offset < raw.length) {
    if (offset + 4 > raw.length) throw new Error('DeepSeek Harness zstd frame 不完整');
    const magic = raw.readUInt32LE(offset);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      if (offset + 8 > raw.length) throw new Error('DeepSeek Harness zstd frame 不完整');
      const size = raw.readUInt32LE(offset + 4);
      if (offset + 8 + size > raw.length) throw new Error('DeepSeek Harness zstd frame 不完整');
      offset += 8 + size;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('无法识别 DeepSeek Harness 的 zstd frame');
    const end = zstdFrameEnd(raw, offset);
    chunks.push(zlib.zstdDecompressSync(raw.subarray(offset, end)));
    offset = end;
  }
  return Buffer.concat(chunks);
}

function zstdFrameEnd(raw, start) {
  let cursor = start + 4;
  if (cursor >= raw.length) throw new Error('DeepSeek Harness zstd frame 不完整');
  const descriptor = raw[cursor++];
  if (descriptor & 0x18) throw new Error('DeepSeek Harness zstd frame 标记无效');
  const singleSegment = Boolean(descriptor & 0x20);
  const fcsFlag = descriptor >>> 6;
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03];
  if (!singleSegment) cursor += 1; // window descriptor
  cursor += dictionaryBytes;
  cursor += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;

  let last = false;
  while (!last) {
    if (cursor + 3 > raw.length) throw new Error('DeepSeek Harness zstd frame 不完整');
    const header = raw[cursor] | (raw[cursor + 1] << 8) | (raw[cursor + 2] << 16);
    cursor += 3;
    last = Boolean(header & 1);
    const blockType = (header >>> 1) & 0x03;
    const blockSize = header >>> 3;
    const storedSize = blockType === 1 ? 1 : blockSize;
    if (blockType === 3 || cursor + storedSize > raw.length) throw new Error('DeepSeek Harness zstd block 无效');
    cursor += storedSize;
  }
  if (descriptor & 0x04) cursor += 4; // content checksum
  if (cursor > raw.length) throw new Error('DeepSeek Harness zstd checksum 不完整');
  return cursor;
}

async function readHeader(file) {
  try {
    const text = file.endsWith('.zstd') ? await readLog(file) : await readHead(file, 64 * 1024);
    const first = text.split(/\r?\n/, 1)[0];
    const header = JSON.parse(first);
    return isSessionHeader(header) ? header : null;
  } catch {
    return null;
  }
}

async function readTitle(file, header) {
  try {
    const text = file.endsWith('.zstd') ? await readLog(file) : await readHead(file, 128 * 1024);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'session/title' && (event.data?.title || event.data?.name)) return String(event.data.title || event.data.name);
    }
  } catch {
    /* malformed tails are handled by read() */
  }
  return header.id ? `DeepSeek 会话 ${String(header.id).slice(0, 8)}` : 'DeepSeek 会话';
}

function parseRecords(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (cause) {
      throw new Error(`DeepSeek Harness JSONL 损坏：第 ${out.length + 1} 行`, { cause });
    }
  }
  return out;
}

function isSessionHeader(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.type === 'session' &&
      typeof value.id === 'string' &&
      Number.isFinite(value.createdAt),
  );
}

/**
 * 支持哪些会话格式版本。
 *
 * 本机实测（2026-10-19）同时存在 v3 与 v4：v4 共 28 个，v3 共 3 个（其中 1 个是 0 消息的空壳）。
 * v3 的事件结构可以被现有解析器正确读出（实测 21 条 / 201 条消息），所以 v3 必须保留支持 ——
 * 早先的「只支持 v4」会把 2 个真实会话直接拒掉。
 * 更高版本（v5+）结构未知，显式拒绝好过静默读出一个半截会话。
 * 无 version 字段的老格式按 v3 之前的形态处理，放行。
 */
const SUPPORTED_VERSIONS = new Set([3, 4]);

function assertSupportedVersion(version) {
  if (version == null) return;
  if (SUPPORTED_VERSIONS.has(Number(version))) return;
  throw new Error(`不支持的 Harness 会话版本：v${version}（支持 v3 / v4）。请先用 DeepSeek Harness 导出当前对话再迁移`);
}

function appendMessage(out, raw, fallbackRole, createdAt, seenCalls) {
  const message = raw?.message && typeof raw.message === 'object' ? raw.message : raw;
  if (!message || typeof message !== 'object') return;
  let blocks = contentBlocks(message.content, seenCalls);
  if (!blocks.length && message.text) blocks.push(block.text(message.text));
  if (!blocks.length) return;
  const role = ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : fallbackRole;
  if (role === 'tool' && blocks.every((item) => item.type === 'text' || item.type === 'thinking')) {
    const callId = message.toolCallId || message.tool_use_id || message.callId || '';
    blocks = [block.toolResult(callId, blocks.map((item) => item.text).join('\n'), { isError: message.isError })];
  }
  out.push({
    id: message.id || uid('m_'),
    role,
    createdAt,
    blocks,
    ...(message.source?.model ? { model: message.source.model } : {}),
  });
}

function contentBlocks(content, seenCalls) {
  if (typeof content === 'string') return content.trim() ? [block.text(content)] : [];
  const parts = Array.isArray(content) ? content : Array.isArray(content?.parts) ? content.parts : content ? [content] : [];
  const blocks = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part) blocks.push(block.text(part));
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const type = String(part.type || '').toLowerCase();
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (part.text) blocks.push(block.text(part.text));
    } else if (type === 'reasoning' || type === 'thinking') {
      if (part.text || part.thinking) blocks.push(block.thinking(part.text || part.thinking));
    } else if (type === 'tool-call' || type === 'tool_call' || type === 'tool_use') {
      const id = String(part.id || part.callId || '');
      blocks.push(block.toolCall(part.name || part.tool || 'unknown', parseArguments(part.arguments ?? part.input), id || undefined));
      if (id) seenCalls.add(id);
    } else if (type === 'tool-result' || type === 'tool_result') {
      blocks.push(block.toolResult(part.toolCallId || part.tool_use_id || part.callId || '', textOf(part.content ?? part.output ?? part.result), { isError: Boolean(part.isError) }));
    } else if (type === 'image' || type === 'image_url' || type === 'file') {
      blocks.push(block.text(`［${type === 'file' ? '文件' : '图片'}：${part.name || part.filename || '未命名'}］`));
    } else if (part.text) {
      blocks.push(block.text(part.text));
    }
  }
  return blocks;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return value.text || value.content || JSON.stringify(value);
  return value == null ? '' : String(value);
}

function parseArguments(value) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.id}:${ref.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
