/**
 * Continue（VS Code / JetBrains 插件）适配器
 *
 *   ~/.continue/sessions/<sessionId>.json
 *   ~/.continue/sessions.json          会话索引（可选）
 *
 * Continue 的会话记录是"轮次 + contextItems"的结构，不同版本字段略有差异，
 * 这里以 history[].message 为主，兼容 content 为字符串或块数组。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';
import { ensureDir, exists, uid } from '../core/util.js';
import { firstLine, readJsonSafe, writeRecord } from './_shared.js';

export default defineStore({
  id: 'continue',
  name: 'Continue',
  vendor: 'Continue',
  category: 'ide',
  region: 'global',
  docs: 'https://docs.continue.dev',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: false },

  async scan(env) {
    const root = path.join(env.home, '.continue', 'sessions');
    if (!(await exists(root))) return [];
    let files = [];
    try {
      files = await fsp.readdir(root);
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(root, f);
      const data = await readJsonSafe(full);
      if (!data) continue;
      const st = await fsp.stat(full).catch(() => null);
      const firstUser = (data.history || []).find((h) => h?.message?.role === 'user');
      out.push({
        id: data.sessionId || f.replace(/\.json$/, ''),
        title: data.title || (firstUser ? firstLine(textOf(firstUser.message.content), 90) : `Continue 会话 ${f.slice(0, 8)}`),
        path: full,
        createdAt: data.dateCreated ? new Date(data.dateCreated).toISOString() : st?.birthtime?.toISOString(),
        updatedAt: data.dateUpdated ? new Date(data.dateUpdated).toISOString() : st?.mtime?.toISOString(),
        bytes: st?.size,
        workspace: data.workspaceDirectory,
        messages: (data.history || []).length,
      });
    }
    return out;
  },

  async read(env, ref) {
    const data = await readJsonSafe(ref.path);
    if (!data) throw new Error('Continue 会话文件无法解析');
    const messages = [];
    for (const item of data.history || []) {
      const m = item.message || item;
      if (!m || !m.role) continue;
      const blocks = [];
      const content = m.content;
      if (typeof content === 'string') {
        if (content.trim()) blocks.push(block.text(content));
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c === 'string') blocks.push(block.text(c));
          else if (c?.type === 'text' && c.text) blocks.push(block.text(c.text));
          else if (c?.type === 'image' || c?.image) blocks.push(block.text('［图片］'));
        }
      }
      if (!blocks.length) continue;
      const role = ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role : 'user';
      messages.push({ id: m.id || uid('m_'), role, createdAt: m.timestamp, blocks });
    }

    return createConversation({
      id: ref.id,
      title: ref.title,
      createdAt: messages[0]?.createdAt || ref.createdAt,
      updatedAt: ref.updatedAt,
      source: { adapter: 'continue', name: 'Continue', vendor: 'Continue', sessionId: ref.id, path: ref.path },
      workspace: ref.workspace ? { cwd: ref.workspace } : undefined,
      model: data.model ? { id: String(data.model) } : undefined,
      messages,
    });
  },

  async import(env, conv, opts) {
    const root = path.join(env.home, '.continue');
    const dir = path.join(root, 'sessions');
    const sessionId = uid();
    const file = path.join(dir, `${sessionId}.json`);
    const history = [];
    for (const m of conv.messages) {
      if (m.role === 'system') continue;
      const content = m.blocks
        .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_call' ? `[调用 ${b.name}]` : b.type === 'tool_result' ? b.output : ''))
        .filter(Boolean)
        .join('\n');
      if (!content) continue;
      history.push({
        message: { role: m.role === 'tool' ? 'user' : m.role, content },
        contextItems: [],
      });
    }
    const data = {
      sessionId,
      title: conv.title,
      workspaceDirectory: opts.workspace || conv.workspace?.cwd || env.cwd,
      history,
      dateCreated: conv.createdAt ? new Date(conv.createdAt).getTime() : Date.now(),
      dateUpdated: Date.now(),
    };
    const content = JSON.stringify(data, null, 2);

    if (opts.dryRun) {
      return { writes: [{ path: file, bytes: Buffer.byteLength(content), kind: 'continue-session', preview: true }], notes: [] };
    }
    await ensureDir(dir);
    await fsp.writeFile(file, content, 'utf8');
    await updateIndex(root, {
      sessionId,
      title: conv.title,
      workspaceDirectory: data.workspaceDirectory,
      dateCreated: new Date(data.dateCreated).toISOString(),
      dateUpdated: new Date(data.dateUpdated).toISOString(),
    });
    return {
      writes: [writeRecord(file, content, 'continue-session')],
      notes: [],
      resume: { cwd: data.workspaceDirectory, command: '在 Continue 侧边栏的历史会话中选择' },
    };
  },

  resumeHint() {
    return '重启 IDE，在 Continue 面板的历史记录中打开该会话。';
  },
});

async function updateIndex(root, entry) {
  const file = path.join(root, 'sessions.json');
  const list = (await readJsonSafe(file)) || [];
  const arr = Array.isArray(list) ? list : [];
  arr.unshift(entry);
  await fsp.writeFile(file, JSON.stringify(arr, null, 2), 'utf8').catch(() => {});
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text || '').join(' ');
  return '';
}
