/**
 * Gemini CLI 家族（Gemini CLI / Qwen Code / iFlow CLI）
 *
 * 三者都源自同一个上游实现，存储布局一致：
 *   <root>/tmp/<projectHash>/chats/session-*.json
 *   <root>/projects.json        { "<项目路径>": "<hash>" }
 *
 * 一条消息可以是 user / gemini / info / error；工具调用挂在 gemini 消息的 toolCalls 上。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';
import { ensureDir, exists, sha256, uid } from '../core/util.js';
import { firstLine, readJsonSafe, writeRecord } from './_shared.js';

const FAMILY = [
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    dir: '.gemini',
    command: 'gemini',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    vendor: '阿里巴巴',
    dir: '.qwen',
    command: 'qwen',
    docs: 'https://github.com/QwenLM/qwen-code',
  },
  {
    id: 'iflow',
    name: 'iFlow CLI',
    vendor: '心流 AI',
    dir: '.iflow',
    command: 'iflow',
    docs: 'https://github.com/iflow-ai/iflow-cli',
  },
];

export function makeGeminiFamilyStore(spec) {
  return defineStore({
    id: spec.id,
    name: spec.name,
    vendor: spec.vendor,
    category: 'cli',
    region: spec.id === 'gemini-cli' ? 'global' : 'cn',
    docs: spec.docs,
    capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },

    async scan(env) {
      const root = path.join(env.home, spec.dir);
      if (!(await exists(root))) return [];
      const projects = await readProjects(root);
      const tmp = path.join(root, 'tmp');
      let dirs = [];
      try {
        dirs = await fsp.readdir(tmp, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const chats = path.join(tmp, d.name, 'chats');
        let files = [];
        try {
          files = await fsp.readdir(chats);
        } catch {
          continue;
        }
        const projectPath = projects.byHash.get(d.name) || (await readProjectRoot(path.join(tmp, d.name)));
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          const full = path.join(chats, f);
          const st = await fsp.stat(full).catch(() => null);
          if (!st) continue;
          const data = await readJsonSafe(full);
          if (!data) continue;
          const firstUser = (data.messages || []).find((m) => m.type === 'user');
          out.push({
            id: data.sessionId || f.replace(/\.json$/, ''),
            title: firstUser ? firstText(firstUser.content) || `${spec.name} 会话` : `${spec.name} 会话`,
            path: full,
            createdAt: data.startTime,
            updatedAt: data.lastUpdated || (st.mtime ? st.mtime.toISOString() : undefined),
            bytes: st.size,
            workspace: projectPath,
            preview: firstUser ? firstLine(firstText(firstUser.content), 90) : '',
            messages: (data.messages || []).length,
            meta: { projectHash: d.name, root },
          });
        }
      }
      return out;
    },

    async read(env, ref) {
      const data = await readJsonSafe(ref.path);
      if (!data) throw new Error('会话文件无法解析');
      const messages = [];
      let model;
      for (const m of data.messages || []) {
        const ts = m.timestamp;
        if (m.type === 'user') {
          const text = firstText(m.content);
          if (text) messages.push({ id: m.id || uid('m_'), role: 'user', createdAt: ts, blocks: [block.text(text)] });
        } else if (m.type === 'gemini') {
          if (m.model) model = m.model;
          const bs = [];
          for (const t of m.thoughts || []) {
            const text = [t.subject, t.description].filter(Boolean).join('\n');
            if (text) bs.push(block.thinking(text));
          }
          const text = firstText(m.content);
          if (text) bs.push(block.text(text));
          for (const tc of m.toolCalls || []) {
            bs.push(block.toolCall(tc.name, tc.args ?? {}, tc.id));
            const output = toolOutput(tc);
            if (output) bs.push(block.toolResult(tc.id, output, { name: tc.name, isError: tc.status === 'error' }));
          }
          if (bs.length) messages.push({ id: m.id || uid('m_'), role: 'assistant', createdAt: ts, blocks: bs });
        } else if (m.type === 'info' || m.type === 'error') {
          const text = firstText(m.content);
          if (text) messages.push({ id: m.id || uid('m_'), role: 'system', createdAt: ts, blocks: [block.text(text)], meta: { internal: true } });
        }
      }

      return createConversation({
        id: data.sessionId || ref.id,
        title: ref.title,
        createdAt: data.startTime || messages[0]?.createdAt,
        updatedAt: data.lastUpdated || messages.at(-1)?.createdAt,
        source: {
          adapter: spec.id,
          name: spec.name,
          vendor: spec.vendor,
          sessionId: data.sessionId || ref.id,
          path: ref.path,
        },
        workspace: ref.workspace ? { cwd: ref.workspace } : undefined,
        model: model ? { id: model } : undefined,
        messages,
      });
    },

    async import(env, conv, opts) {
      const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
      const root = path.join(env.home, spec.dir);
      const projectHash = sha256(cwd);
      const dir = path.join(root, 'tmp', projectHash, 'chats');
      const sessionId = uid();
      const start = conv.createdAt || new Date().toISOString();
      const stamp = start.replace(/[:.]/g, '-');
      const file = path.join(dir, `session-${stamp}-${sessionId}.json`);

      const messages = [];
      for (const m of conv.messages) {
        if (m.role === 'system') continue;
        const ts = m.createdAt || start;
        if (m.role === 'user') {
          const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (text) messages.push({ id: m.id, timestamp: ts, type: 'user', content: text });
        } else if (m.role === 'assistant' || m.role === 'tool') {
          const toolCalls = m.blocks
            .filter((b) => b.type === 'tool_call')
            .map((b) => ({ id: b.id, name: b.name, args: b.input, status: 'success', timestamp: ts, result: [] }));
          const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          const thoughts = m.blocks
            .filter((b) => b.type === 'thinking')
            .map((b) => ({ subject: '', description: b.text }));
          if (text || toolCalls.length) {
            messages.push({
              id: m.id,
              timestamp: ts,
              type: 'gemini',
              content: text,
              model: conv.model?.id || 'gemini-2.5-pro',
              ...(thoughts.length ? { thoughts } : {}),
              ...(toolCalls.length ? { toolCalls } : {}),
            });
          }
        }
      }

      const data = {
        sessionId,
        projectHash,
        startTime: start,
        lastUpdated: new Date().toISOString(),
        messages,
      };
      const content = JSON.stringify(data, null, 2);

      if (opts.dryRun) {
        return { writes: [{ path: file, bytes: Buffer.byteLength(content), kind: `${spec.id}-chat`, preview: true }], notes: ['模拟模式：未写入'] };
      }

      await ensureDir(dir);
      await fsp.writeFile(file, content, 'utf8');
      await fsp.writeFile(path.join(root, 'tmp', projectHash, '.project_root'), cwd, 'utf8').catch(() => {});
      await updateProjects(root, cwd, projectHash);
      return {
        writes: [writeRecord(file, content, `${spec.id}-chat`)],
        notes: [`项目哈希：${projectHash.slice(0, 12)}…`],
        resume: { cwd, command: `${spec.command} --resume ${sessionId}`, sessionId },
      };
    },

    resumeHint(conv, opts) {
      if (opts?.sessionId) return `旧版本也可以直接运行 ${spec.command} --resume，从列表中选择会话。`;
      return `运行 ${spec.command} --resume 选择会话。`;
    },
  });
}

export const geminiCli = makeGeminiFamilyStore(FAMILY[0]);
export const qwenCode = makeGeminiFamilyStore(FAMILY[1]);
export const iflowCli = makeGeminiFamilyStore(FAMILY[2]);

function firstText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text || c?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return content.text || content.content || '';
  return '';
}

function toolOutput(tc) {
  const parts = [];
  for (const r of tc.result || []) {
    const resp = r.functionResponse?.response || r;
    if (typeof resp === 'string') parts.push(resp);
    else if (resp?.output) parts.push(typeof resp.output === 'string' ? resp.output : JSON.stringify(resp.output));
    else if (resp?.error) parts.push(String(resp.error));
  }
  return parts.join('\n');
}

async function readProjects(root) {
  const byHash = new Map();
  const raw = (await readJsonSafe(path.join(root, 'projects.json'))) || {};
  const table = raw.projects || raw;
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === 'string') byHash.set(v, k);
    else if (v && typeof v === 'object' && v.path) byHash.set(v.hash || v.id, v.path);
  }
  return { byHash, raw };
}

async function readProjectRoot(dir) {
  try {
    const t = await fsp.readFile(path.join(dir, '.project_root'), 'utf8');
    return t.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function updateProjects(root, cwd, hash) {
  const file = path.join(root, 'projects.json');
  const raw = (await readJsonSafe(file)) || {};
  if (raw.projects && typeof raw.projects === 'object') raw.projects[cwd] = hash;
  else raw[cwd] = hash;
  await ensureDir(root);
  await fsp.writeFile(file, JSON.stringify(raw, null, 2), 'utf8').catch(() => {});
}
