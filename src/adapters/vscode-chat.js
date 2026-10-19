/**
 * VS Code 系 AI 聊天（Trae / Windsurf / Kiro / VSCodium）
 *
 * 这些 IDE 都是 VS Code 的分支，聊天面板沿用同一套 `chatSessions` 存储：
 *   <User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
 *   <User>/globalStorage/emptyWindowChatSessions/*.jsonl
 *
 * 与 Copilot Chat 的区别在于扩展与数据库不同，所以这里只处理 chatSessions，
 * 解析/写入复用 vscode-copilot.js 里的实现（同一份格式）。
 *
 * 说明：不同分支可能裁剪或改写该格式，扫描失败会自动跳过，不影响其它适配器。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { ensureDir, exists, existsSync, uid } from '../core/util.js';
import {
  buildSessionState,
  findTemplateState,
  readFromJsonl,
  resolveWorkspaceDir,
  scanChatDir,
} from './vscode-copilot.js';
import { writeRecord } from './_shared.js';

function makeStore({ id, name, vendor, region, hosts, note }) {
  return defineStore({
    id,
    name,
    vendor,
    category: 'ide',
    region,
    docs: 'https://code.visualstudio.com/docs/copilot/chat/chat-overview',
    experimental: true,
    capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },

    async scan(env) {
      const out = [];
      for (const h of hosts) {
        const userDir = env.codeUser(h.dir);
        if (!(await exists(userDir))) continue;
        const wsRoot = path.join(userDir, 'workspaceStorage');
        let dirs = [];
        try {
          dirs = await fsp.readdir(wsRoot, { withFileTypes: true });
        } catch {
          dirs = [];
        }
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const dir = path.join(wsRoot, d.name);
          const wsJson = await readJson(path.join(dir, 'workspace.json'));
          const folder = decodeFileUri(wsJson?.folder || wsJson?.workspace || '') || undefined;
          const sessions = await scanChatDir(path.join(dir, 'chatSessions'), {
            host: h.dir,
            hostLabel: h.label,
            folder,
            workspaceHash: d.name,
          });
          out.push(...sessions.map((s) => ({ ...s, meta: { ...s.meta, hostLabel: h.label } })));
        }
        const empty = await scanChatDir(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'), {
          host: h.dir,
          hostLabel: h.label,
          folder: undefined,
          workspaceHash: null,
        });
        out.push(...empty.map((s) => ({ ...s, meta: { ...s.meta, hostLabel: h.label } })));
      }

      const seen = new Set();
      return out
        .filter((s) => {
          const key = `${s.meta?.host}:${s.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return (s.messages || 0) > 0 || s.title;
        })
        .map((s) => ({ ...s, title: s.title || `${s.meta?.hostLabel || 'VS Code'} 会话` }));
    },

    async read(env, ref) {
      const conv = await readFromJsonl(ref);
      conv.source = {
        ...conv.source,
        adapter: id,
        name: ref.meta?.hostLabel ? `${ref.meta.hostLabel}（${name}）` : name,
        vendor,
      };
      conv.tags = [...new Set([...(conv.tags || []), 'vscode-chat'])];
      return conv;
    },

    async import(env, conv, opts) {
      const host = pickHost(env, hosts, opts.agent);
      if (!host) {
        return {
          writes: [],
          notes: [`未检测到 ${name} 的安装目录，无法原生导入；可改用 --to handoff 生成交接包。`],
        };
      }
      const userDir = env.codeUser(host.dir);
      const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
      const resolved = await resolveWorkspaceDir(userDir, cwd, { create: !opts.dryRun });
      const sessionId = uid();
      const file = path.join(resolved.sessionsDir, `${sessionId}.jsonl`);
      const template = await findTemplateState(resolved.dir);
      const line = JSON.stringify({ kind: 0, v: buildSessionState(conv, sessionId, template) });
      const notes = [];

      if (opts.dryRun) {
        return {
          writes: [{ path: file, bytes: Buffer.byteLength(line), kind: 'vscode-chatsession', preview: true }],
          notes: [],
        };
      }

      await ensureDir(resolved.sessionsDir);
      await fsp.writeFile(file, line + '\n', 'utf8');
      if (resolved.created) {
        notes.push('已新建工作区存储目录；首次打开该文件夹后会话才会出现在历史列表中。');
      }
      notes.push(`重启 ${host.label}（或重新加载窗口）后，在聊天历史中可见。`);
      return {
        writes: [writeRecord(file, line, 'vscode-chatsession')],
        notes,
        resume: { cwd, command: `打开 ${host.label} 的聊天历史面板`, sessionId },
      };
    },

    resumeHint(conv, opts) {
      return note || '重启对应 IDE 后，在聊天历史中打开该会话。';
    },
  });
}

/* ------------------------------------------------------------------ */

function pickHost(env, hosts, hint) {
  const list = hint ? hosts.filter((h) => hint.includes(h.dir) || hint.includes(h.label)) : hosts;
  for (const h of list.length ? list : hosts) {
    if (existsSync(env.codeUser(h.dir))) return h;
  }
  return null;
}

async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeFileUri(uri) {
  if (!uri || typeof uri !== 'string' || !uri.startsWith('file://')) return '';
  let s = uri.slice('file://'.length);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  s = s.replace(/^\/([a-zA-Z]):/, '$1:');
  return s.replace(/\//g, path.sep === '/' ? '/' : '\\');
}

/* ------------------------------------------------------------------ */

export const trae = makeStore({
  id: 'trae',
  name: 'Trae',
  vendor: '字节跳动',
  region: 'cn',
  hosts: [
    { dir: 'trae', label: 'Trae' },
    { dir: 'traeCn', label: 'Trae CN' },
  ],
  note: 'Trae 的聊天面板使用 VS Code 的 chatSessions 存储；重启后可见。',
});

export const vscodeChat = makeStore({
  id: 'vscode-chat',
  name: 'Windsurf / Kiro / VSCodium',
  vendor: '多家',
  region: 'global',
  hosts: [
    { dir: 'windsurf', label: 'Windsurf' },
    { dir: 'kiro', label: 'Kiro' },
    { dir: 'vscodium', label: 'VSCodium' },
  ],
  note: 'VS Code 分支的聊天面板格式可能随版本变化，导入属于实验性功能。',
});
