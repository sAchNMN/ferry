/**
 * 其它本地 Agent：
 *   Goose       Block 开源的本地 Agent，会话为 JSONL
 *   OpenCode    SST 的终端 Agent，会话/消息/片段三级 JSON 存储
 *   Aider       以 Markdown 记录对话（只读导出）
 *
 * 这三个产品的存储格式仍在演进，适配器采用"多候选目录 + 容错解析"策略。
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';
import { ensureDir, exists, isoFrom, uid } from '../core/util.js';
import { firstLine, forEachLine, readJsonSafe, writeRecord } from './_shared.js';

/* ================================================================== */
/* Goose                                                              */
/* ================================================================== */

export const goose = defineStore({
  id: 'goose',
  name: 'Goose',
  vendor: 'Block',
  category: 'cli',
  region: 'global',
  docs: 'https://block.github.io/goose/',
  capabilities: { scan: true, export: true, import: false, resume: false, attachments: false, tools: true },

  async scan(env) {
    const roots = [
      path.join(env.xdgData, 'goose', 'sessions'),
      path.join(env.home, '.local', 'share', 'goose', 'sessions'),
      path.join(env.appData, 'goose', 'sessions'),
      path.join(env.appData, 'Block', 'goose', 'sessions'),
    ];
    const out = [];
    for (const root of roots) {
      if (!(await exists(root))) continue;
      let files = [];
      try {
        files = await fsp.readdir(root);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(root, f);
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        const head = await readHeadText(full, 32 * 1024);
        const first = head
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .find(Boolean);
        const text = messageText(first);
        out.push({
          id: f.replace(/\.jsonl$/, ''),
          title: firstLine(text, 90) || `Goose 会话 ${f.slice(0, 8)}`,
          path: full,
          createdAt: first?.created || st.birthtime?.toISOString(),
          updatedAt: st.mtime?.toISOString(),
          bytes: st.size,
          workspace: first?.metadata?.working_dir,
          preview: firstLine(text, 90),
        });
      }
    }
    return out;
  },

  async read(env, ref) {
    const messages = [];
    await forEachLine(ref.path, (line) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (!rec || !rec.role) return;
      const blocks = [];
      for (const c of Array.isArray(rec.content) ? rec.content : []) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text' && c.text) blocks.push(block.text(c.text));
        else if (c.type === 'toolRequest' && c.toolCall) {
          blocks.push(block.toolCall(c.toolCall.name || c.toolCall.toolName, c.toolCall.arguments ?? c.toolCall.input ?? {}));
        } else if (c.type === 'toolResponse' && c.toolResult) {
          const r = c.toolResult;
          const output = r.value?.content?.map?.((x) => x.text).join('\n') || r.output || JSON.stringify(r);
          blocks.push(block.toolResult(r.id || '', output, { isError: Boolean(r.isError) }));
        } else if (c.type === 'thinking' && c.thinking) blocks.push(block.thinking(c.thinking));
      }
      if (!blocks.length) return;
      const role = rec.role === 'assistant' ? 'assistant' : rec.role === 'tool' ? 'tool' : 'user';
      messages.push({ id: rec.id || uid('m_'), role, createdAt: rec.created, blocks });
    });
    return createConversation({
      id: ref.id,
      title: ref.title,
      createdAt: messages[0]?.createdAt || ref.createdAt,
      updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
      source: { adapter: 'goose', name: 'Goose', vendor: 'Block', sessionId: ref.id, path: ref.path },
      workspace: ref.workspace ? { cwd: ref.workspace } : undefined,
      messages,
    });
  },
});

/* ================================================================== */
/* OpenCode                                                           */
/* ================================================================== */

export const opencode = defineStore({
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'SST',
  category: 'cli',
  region: 'global',
  docs: 'https://opencode.ai/docs/',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },

  async scan(env) {
    const roots = [
      path.join(env.xdgData, 'opencode', 'storage'),
      path.join(env.home, '.local', 'share', 'opencode', 'storage'),
      path.join(env.appData, 'opencode', 'storage'),
    ];
    const out = [];
    for (const root of roots) {
      const sessionDir = path.join(root, 'session');
      if (!(await exists(sessionDir))) continue;
      const projects = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const dir = path.join(sessionDir, p.name);
        const files = await fsp.readdir(dir).catch(() => []);
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          const full = path.join(dir, f);
          const data = await readJsonSafe(full);
          if (!data) continue;
          const st = await fsp.stat(full).catch(() => null);
          out.push({
            id: data.id || f.replace(/\.json$/, ''),
            title: data.title || `OpenCode 会话 ${String(data.id || f).slice(0, 8)}`,
            path: full,
            createdAt: isoFrom(data.time?.created),
            updatedAt: isoFrom(data.time?.updated) || st?.mtime?.toISOString(),
            workspace: data.directory,
            bytes: st?.size,
            meta: { storage: root, projectID: p.name },
          });
        }
      }
    }
    return out;
  },

  async read(env, ref) {
    const storage = ref.meta?.storage;
    const sessionId = ref.id;
    const messages = [];
    if (storage) {
      const msgDir = path.join(storage, 'message', sessionId);
      const files = await fsp.readdir(msgDir).catch(() => []);
      files.sort();
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const msg = await readJsonSafe(path.join(msgDir, f));
        if (!msg) continue;
        const blocks = [];
        const partDir = path.join(storage, 'part', msg.id || f.replace(/\.json$/, ''));
        const partFiles = await fsp.readdir(partDir).catch(() => []);
        partFiles.sort();
        for (const pf of partFiles) {
          const part = await readJsonSafe(path.join(partDir, pf));
          if (!part) continue;
          if (part.type === 'text' && part.text) blocks.push(block.text(part.text));
          else if (part.type === 'reasoning' && part.text) blocks.push(block.thinking(part.text));
          else if (part.type === 'tool' && part.tool) {
            blocks.push(block.toolCall(part.tool, part.state?.input ?? part.input ?? {}, part.callID || part.id));
            if (part.state?.output) blocks.push(block.toolResult(part.callID || '', part.state.output, { isError: part.state.status === 'error' }));
          } else if (part.type === 'file' && part.filename) blocks.push(block.text(`［文件：${part.filename}］`));
        }
        if (!blocks.length) continue;
        messages.push({
          id: msg.id,
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          createdAt: isoFrom(msg.time?.created),
          blocks,
          ...(msg.modelID ? { model: msg.modelID } : {}),
        });
      }
    }
    return createConversation({
      id: sessionId,
      title: ref.title,
      createdAt: messages[0]?.createdAt || ref.createdAt,
      updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
      source: { adapter: 'opencode', name: 'OpenCode', vendor: 'SST', sessionId, path: ref.path },
      workspace: ref.workspace ? { cwd: ref.workspace } : undefined,
      messages,
    });
  },

  async import(env, conv, opts) {
    const root = path.join(env.xdgData, 'opencode', 'storage');
    const storage = (await exists(path.join(root, 'session'))) ? root : path.join(env.home, '.local', 'share', 'opencode', 'storage');
    const projectID = 'global';
    const sessionId = uid().replace(/-/g, '').slice(0, 26);
    const now = Date.now();
    const files = [];

    const sessionFile = path.join(storage, 'session', projectID, `${sessionId}.json`);
    files.push([
      sessionFile,
      {
        id: sessionId,
        projectID,
        directory: opts.workspace || conv.workspace?.cwd || env.cwd,
        title: conv.title,
        version: '1.0.0',
        time: { created: conv.createdAt ? new Date(conv.createdAt).getTime() : now, updated: now },
      },
    ]);

    let i = 0;
    for (const m of conv.messages) {
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
      const msgId = `msg_${String(i).padStart(4, '0')}_${uid().slice(0, 8)}`;
      const parts = [];
      let p = 0;
      for (const b of m.blocks) {
        const pid = `prt_${String(p++).padStart(4, '0')}_${uid().slice(0, 6)}`;
        if (b.type === 'text') {
          parts.push([path.join(storage, 'part', msgId, `${pid}.json`), { id: pid, messageID: msgId, sessionID: sessionId, type: 'text', text: b.text }]);
        } else if (b.type === 'thinking') {
          parts.push([path.join(storage, 'part', msgId, `${pid}.json`), { id: pid, messageID: msgId, sessionID: sessionId, type: 'reasoning', text: b.text }]);
        } else if (b.type === 'tool_call') {
          parts.push([
            path.join(storage, 'part', msgId, `${pid}.json`),
            {
              id: pid,
              messageID: msgId,
              sessionID: sessionId,
              type: 'tool',
              tool: b.name,
              callID: b.id,
              state: { status: 'completed', input: b.input ?? {}, output: '' },
            },
          ]);
        }
      }
      if (!parts.length) continue;
      files.push([
        path.join(storage, 'message', sessionId, `${msgId}.json`),
        {
          id: msgId,
          sessionID: sessionId,
          role: m.role === 'assistant' ? 'assistant' : 'user',
          time: { created: m.createdAt ? new Date(m.createdAt).getTime() : now + i },
          ...(conv.model?.id ? { modelID: conv.model.id, providerID: 'ferry' } : {}),
        },
      ]);
      files.push(...parts);
      i++;
    }

    if (opts.dryRun) {
      return { writes: files.map(([f]) => ({ path: f, bytes: 0, kind: 'opencode', preview: true })), notes: ['模拟模式：未写入'] };
    }
    const writes = [];
    for (const [file, data] of files) {
      await ensureDir(path.dirname(file));
      const content = JSON.stringify(data, null, 2);
      await fsp.writeFile(file, content, 'utf8');
      writes.push(writeRecord(file, content, 'opencode'));
    }
    return {
      writes,
      notes: [],
      resume: { cwd: opts.workspace || env.cwd, command: `opencode --session ${sessionId}` },
    };
  },

  resumeHint(conv, opts) {
    return opts?.sessionId ? '也可以直接运行 opencode，从会话列表中选择。' : '运行 opencode 后选择该会话。';
  },
});

/* ================================================================== */
/* Aider                                                              */
/* ================================================================== */

export const aider = defineStore({
  id: 'aider',
  name: 'Aider',
  vendor: 'Aider',
  category: 'cli',
  region: 'global',
  docs: 'https://aider.chat/docs/',
  capabilities: { scan: true, export: true, import: false, resume: false, attachments: false, tools: true },

  async scan(env) {
    const candidates = [path.join(env.home, '.aider.chat.history.md')];
    // 项目级：浅层扫描用户目录（跳过常见大目录）
    const skip = new Set(['node_modules', '.git', 'AppData', 'Library', 'Windows', 'Program Files', '.cache', 'venv', '.venv']);
    const stack = [{ dir: env.home, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      if (depth > 3) continue;
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (skip.has(e.name) || e.name.startsWith('.')) continue;
          stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        } else if (e.name === '.aider.chat.history.md') {
          candidates.push(path.join(dir, e.name));
        }
      }
    }
    const out = [];
    for (const file of candidates) {
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      const headText = await readHeadText(file, 16 * 1024);
      const title = (/# aider chat started at .*\n+#### (.*)/.exec(headText)?.[1] || path.basename(path.dirname(file)));
      out.push({
        id: `aider:${file}`,
        title: firstLine(title, 90),
        path: file,
        createdAt: st.birthtime?.toISOString(),
        updatedAt: st.mtime?.toISOString(),
        bytes: st.size,
        workspace: path.dirname(file),
      });
    }
    return out;
  },

  async read(env, ref) {
    const text = await fsp.readFile(ref.path, 'utf8');
    const messages = [];
    let role = null;
    let buf = [];
    const flush = () => {
      const content = buf.join('\n').trim();
      if (role && content) messages.push({ id: uid('m_'), role, blocks: [block.text(content)] });
      buf = [];
    };
    for (const line of text.split(/\r?\n/)) {
      if (/^####\s?/.test(line)) {
        flush();
        role = 'user';
        buf.push(line.replace(/^####\s?/, ''));
      } else if (/^#{1,2}\s+aider chat started/.test(line)) {
        flush();
        role = null;
      } else if (role === 'user' && /^#\s+/.test(line) && !/^# aider/.test(line)) {
        // aider 的回复通常以 "# " 级别标题分隔
        flush();
        role = 'assistant';
        buf.push(line.replace(/^#\s+/, ''));
      } else if (role) {
        buf.push(line);
      }
    }
    flush();
    return createConversation({
      id: ref.id,
      title: ref.title,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      source: { adapter: 'aider', name: 'Aider', vendor: 'Aider', sessionId: ref.id, path: ref.path },
      workspace: ref.workspace ? { cwd: ref.workspace } : undefined,
      messages,
    });
  },
});

/* ------------------------------------------------------------------ */

async function readHeadText(file, bytes) {
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

function messageText(rec) {
  if (!rec || !Array.isArray(rec.content)) return '';
  return rec.content.map((c) => c?.text || '').join(' ');
}
