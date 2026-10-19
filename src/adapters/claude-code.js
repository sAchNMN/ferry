/**
 * Claude Code（Anthropic）适配器
 *
 * 存储位置：
 *   ~/.claude/projects/<slug>/<sessionId>.jsonl
 *   slug = cwd 中所有非字母数字字符替换为 '-'
 *
 * 每条 JSONL 是一条事件；user / assistant 消息带 uuid + parentUuid 组成链，
 * tool_result 以 user 消息的形式出现。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { block, createConversation, msg } from '../core/ucm.js';
import { ensureDir, exists, shortHash, uid } from '../core/util.js';
import { firstLine, forEachLine, readHead, writeRecord } from './_shared.js';

const SYSTEM_TYPES = new Set(['file-history-snapshot', 'queue-operation', 'summary', 'system']);

export function projectSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

export default defineStore({
  id: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  category: 'cli',
  region: 'global',
  docs: 'https://docs.claude.com/en/docs/claude-code',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: true, tools: true },

  async scan(env) {
    const root = path.join(env.home, '.claude', 'projects');
    if (!(await exists(root))) return [];
    const out = [];
    let projects;
    try {
      projects = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(root, p.name);
      let files;
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        const head = await readHead(full, 96 * 1024);
        const meta = parseMeta(head);
        out.push({
          id: f.replace(/\.jsonl$/, ''),
          title: meta.summary || meta.firstUser || `Claude Code ${f.replace(/\.jsonl$/, '').slice(0, 8)}`,
          path: full,
          createdAt: st.birthtime?.toISOString?.() || meta.timestamp,
          updatedAt: st.mtime.toISOString(),
          bytes: st.size,
          workspace: meta.cwd,
          preview: meta.firstUser,
          meta: { projectDir: dir, projectSlug: p.name },
        });
      }
    }
    return out;
  },

  async read(env, ref, ctx) {
    const entries = [];
    await forEachLine(ref.path, (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      entries.push(e);
    });

    const messages = [];
    let cwd = ref.workspace;
    let gitBranch;
    let version;
    let summary;
    let model;

    for (const e of entries) {
      if (e.cwd) cwd = e.cwd;
      if (e.gitBranch) gitBranch = e.gitBranch;
      if (e.version) version = e.version;
      if (e.type === 'summary' && e.summary) summary = e.summary;
      if (SYSTEM_TYPES.has(e.type)) {
        if (e.type === 'system' && e.subtype === 'compact_boundary') {
          messages.push(
            msg.system([block.text('（上下文已被 Claude Code 压缩 / compact）')], {
              internal: true,
              timestamp: e.timestamp,
            }),
          );
        }
        continue;
      }
      const m = e.message;
      if (!m || (e.type !== 'user' && e.type !== 'assistant')) continue;
      if (e.isMeta) continue;
      if (m.model) model = m.model;

      const blocks = [];
      const rawContent = m.content;
      if (typeof rawContent === 'string') {
        if (rawContent.trim()) blocks.push(block.text(rawContent));
      } else if (Array.isArray(rawContent)) {
        for (const c of rawContent) {
          if (!c || typeof c !== 'object') continue;
          switch (c.type) {
            case 'text':
              if (c.text) blocks.push(block.text(c.text));
              break;
            case 'thinking':
              if (c.thinking) blocks.push(block.thinking(c.thinking));
              break;
            case 'tool_use':
              blocks.push(block.toolCall(c.name, c.input, c.id));
              break;
            case 'tool_result': {
              const { text, images } = toolResultContent(c.content);
              blocks.push(block.toolResult(c.tool_use_id, text, { isError: Boolean(c.is_error) }));
              for (const img of images) blocks.push(img);
              break;
            }
            case 'image': {
              const b = await imageBlock(ctx, c);
              if (b) blocks.push(b);
              break;
            }
            case 'document': {
              if (c.source?.type === 'text' && c.source.data) blocks.push(block.text(c.source.data));
              break;
            }
            default:
              if (c.text) blocks.push(block.text(c.text));
              break;
          }
        }
      }
      if (!blocks.length) continue;

      const isToolOnly = blocks.every((b) => b.type === 'tool_result' || b.type === 'image');
      const role = isToolOnly && blocks.some((b) => b.type === 'tool_result') ? 'tool' : e.type;
      const textOnly = blocks.every((b) => b.type === 'text');
      const synthetic =
        role === 'user' && textOnly && /^<system-reminder>[\s\S]*<\/system-reminder>$/.test(blocks.map((b) => b.text).join('\n').trim());
      const message = {
        id: e.uuid || uid('m_'),
        role,
        createdAt: e.timestamp,
        blocks,
        ...(e.isSidechain ? { meta: { sidechain: true } } : {}),
        ...(synthetic ? { meta: { internal: true, synthetic: true } } : {}),
        ...(e.type === 'assistant' && m.model ? { model: m.model } : {}),
      };
      messages.push(message);
    }

    return createConversation({
      id: ref.id,
      title: summary || firstLine(ref.title, 90) || 'Claude Code 会话',
      createdAt: messages[0]?.createdAt || ref.createdAt,
      updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
      source: {
        adapter: 'claude-code',
        name: 'Claude Code',
        vendor: 'Anthropic',
        version,
        sessionId: ref.id,
        path: ref.path,
      },
      workspace: { cwd, git: gitBranch ? { branch: gitBranch } : undefined },
      model: model ? { id: model, provider: 'anthropic' } : undefined,
      messages,
    });
  },

  async import(env, conv, opts) {
    const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
    const projectDir =
      (await findProjectDir(env, cwd)) || path.join(env.home, '.claude', 'projects', projectSlug(cwd));
    const sessionId = uid();
    const file = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [];
    let parentUuid = null;
    let lastUuid = null;
    let gitBranch = conv.workspace?.git?.branch || '';
    let model = conv.model?.id || 'claude-sonnet-4-5';

    const emit = (obj) => {
      lines.push(JSON.stringify(obj));
    };

    for (const m of conv.messages) {
      if (m.role === 'system' || m.meta?.internal || m.meta?.sidechain) continue;
      const uuid = uid();
      const content = await toClaudeContent(m, opts);
      if (!content.length) continue;
      const isAssistant = m.role === 'assistant';
      const entry = {
        parentUuid,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version: '2.0.0',
        gitBranch,
        type: isAssistant ? 'assistant' : 'user',
        message: isAssistant
          ? {
              id: `msg_${shortHash(uuid, 20)}`,
              type: 'message',
              role: 'assistant',
              model,
              content,
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            }
          : { role: 'user', content },
        uuid,
        timestamp: m.createdAt || new Date().toISOString(),
      };
      emit(entry);
      parentUuid = uuid;
      lastUuid = uuid;
    }

    if (!lines.length) {
      opts.log?.warn?.('该会话没有可导入的消息，已跳过');
      return { writes: [], notes: ['没有可导入的消息'] };
    }

    emit({ type: 'summary', summary: conv.title, leafUuid: lastUuid });

    const data = lines.join('\n') + '\n';
    if (opts.dryRun) {
      return { writes: [{ path: file, bytes: Buffer.byteLength(data), kind: 'claude-session', preview: true }], notes: [] };
    }
    await ensureDir(projectDir);
    await fsp.writeFile(file, data, 'utf8');
    return {
      writes: [writeRecord(file, data, 'claude-session')],
      notes: [`会话 ID：${sessionId}`],
      resume: { cwd, command: `claude --resume ${sessionId}`, sessionId },
    };
  },

  resumeHint(conv, opts) {
    return opts?.sessionId ? '也可以直接在该项目目录运行 claude --resume，从列表里选择。' : '在项目目录运行 claude --resume 选择该会话。';
  },
});

/* ------------------------------------------------------------------ */

function parseMeta(head) {
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
    if (e.timestamp && !meta.timestamp) meta.timestamp = e.timestamp;
    if (e.type === 'summary' && e.summary) meta.summary = e.summary;
    if (e.type === 'user' && !meta.firstUser) {
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
      if (text && !text.startsWith('<')) meta.firstUser = firstLine(text, 100);
    }
    if (meta.cwd && meta.firstUser) break;
  }
  return meta;
}

function toolResultContent(content) {
  const images = [];
  if (typeof content === 'string') return { text: content, images };
  if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images };
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') images.push(c);
    else if (c.type === 'tool_reference') parts.push(`[引用工具 ${c.tool_name}]`);
    else if (c.text) parts.push(c.text);
  }
  return { text: parts.join('\n'), images };
}

async function imageBlock(ctx, c) {
  const src = c.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    const data = Buffer.from(src.data, 'base64');
    const sha = ctx.blobs.add(data, { mime: src.media_type || 'image/png' });
    return block.image(sha, src.media_type || 'image/png');
  }
  if (src.type === 'url' && src.url) return block.text(`![image](${src.url})`);
  return null;
}

async function findProjectDir(env, cwd) {
  const root = path.join(env.home, '.claude', 'projects');
  let dirs = [];
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const files = await fsp.readdir(dir).catch(() => []);
    const jsonl = files.find((f) => f.endsWith('.jsonl'));
    if (!jsonl) continue;
    const head = await readHead(path.join(dir, jsonl), 8192);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (!m) continue;
    let recorded;
    try {
      recorded = JSON.parse(`"${m[1]}"`);
    } catch {
      recorded = m[1];
    }
    if (norm(recorded) === norm(cwd)) return dir;
  }
  return null;
}

async function toClaudeContent(m, opts) {
  const out = [];
  const blobs = opts.blobs;
  for (const b of m.blocks) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.text, signature: '' });
    else if (b.type === 'tool_call') out.push({ type: 'tool_use', id: b.id || uid('toolu_'), name: b.name, input: b.input ?? {} });
    else if (b.type === 'tool_result') {
      out.push({ type: 'tool_result', tool_use_id: b.callId || '', content: b.output || '', ...(b.isError ? { is_error: true } : {}) });
    } else if (b.type === 'image' && blobs?.get(b.blob)) {
      const blob = blobs.get(b.blob);
      out.push({
        type: 'image',
        source: { type: 'base64', media_type: blob.mime || 'image/png', data: blob.data.toString('base64') },
      });
    } else if (b.type === 'image') {
      out.push({ type: 'text', text: `［图片：${b.name || b.blob}］` });
    }
  }
  return out;
}
