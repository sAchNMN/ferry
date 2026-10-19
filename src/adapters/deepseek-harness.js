/**
 * DeepSeek Harness 本地会话适配器。
 *
 * Harness 的会话是项目目录下的 JSONL（默认也可能是 zstd 压缩的 JSONL）。
 * 这里做只读迁移：读取事件日志为 UCM，再由核心转交给其它本地 Agent。
 * DeepSeek Harness 的原生回写格式尚未作为 Ferry 的稳定契约，因此不写回。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { defineStore } from '../core/adapter.js';
import { block, createConversation, deriveTitle } from '../core/ucm.js';
import { exists, isoFrom, uid } from '../core/util.js';
import { readHead } from './_shared.js';

/**
 * 会话文件名。实测（2026-10-19 本机）是 `session.v4.jsonl.zstd`，
 * 带格式版本号；早期只认 `session.jsonl` / `session.jsonl.zstd` 导致扫描结果为 0。
 * 同时兼容未压缩、以及未来可能的 `session.v5.jsonl`。
 */
function isSessionFile(name) {
  return /^session(\.[\w-]+)*\.jsonl(\.zstd)?$/.test(name);
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
    import: false,
    resume: false,
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
    const records = parseRecords(await readLog(ref.path));
    const header = records[0];
    if (!isSessionHeader(header)) throw new Error('DeepSeek Harness 会话缺少有效 session 首行');

    const messages = [];
    const titles = [];
    const seenCalls = new Set();
    const unknown = [];
    let model;

    for (const event of records.slice(1)) {
      if (!event || typeof event.type !== 'string') continue;
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
  },
});

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
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(file, onFile);
    else if (entry.isFile()) await onFile(file);
  }
}

async function readLog(file) {
  const raw = await fsp.readFile(file);
  if (!file.endsWith('.zstd')) return raw.toString('utf8');
  if (typeof zstdDecompressSync !== 'function') throw new Error('当前 Node 不支持读取 DeepSeek Harness 的 .jsonl.zstd 会话');
  return decompressZstdFrames(raw).toString('utf8');
}

function decompressZstdFrames(raw) {
  const chunks = [];
  let offset = 0;
  while (offset < raw.length) {
    const magic = raw.readUInt32LE(offset);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      const size = raw.readUInt32LE(offset + 4);
      offset += 8 + size;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('无法识别 DeepSeek Harness 的 zstd frame');
    const end = zstdFrameEnd(raw, offset);
    chunks.push(zstdDecompressSync(raw.subarray(offset, end)));
    offset = end;
  }
  return Buffer.concat(chunks);
}

function zstdFrameEnd(raw, start) {
  let cursor = start + 4;
  const descriptor = raw[cursor++];
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
    if (blockType === 3 || cursor + blockSize > raw.length) throw new Error('DeepSeek Harness zstd block 无效');
    cursor += blockSize;
  }
  if (descriptor & 0x04) cursor += 4; // content checksum
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
    } catch {
      // A torn final line must not hide the committed prefix.
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

function appendMessage(out, raw, fallbackRole, createdAt, seenCalls) {
  const message = raw?.message && typeof raw.message === 'object' ? raw.message : raw;
  if (!message || typeof message !== 'object') return;
  let blocks = contentBlocks(message.content, seenCalls);
  if (!blocks.length && message.text) blocks.push(block.text(message.text));
  if (!blocks.length) return;
  const role = ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : fallbackRole;
  if (role === 'tool' && blocks.every((item) => item.type === 'text' || item.type === 'thinking')) {
    const callId = message.toolCallId || message.tool_use_id || message.callId || '';
    blocks = [block.toolResult(callId, blocks.map((item) => item.text).join('\n'))];
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
