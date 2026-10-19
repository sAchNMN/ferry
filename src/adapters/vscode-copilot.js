/**
 * GitHub Copilot Chat（VS Code 扩展）适配器
 *
 * 存储位置：
 *   <User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
 *   <User>/globalStorage/emptyWindowChatSessions/*.jsonl
 *   <User>/globalStorage/github.copilot-chat/session-store.db
 *
 * chatSessions 的 JSONL 是"快照 + 增量补丁"：kind=0 存整棵状态树，kind=1 用路径补丁更新。
 * import 时会复用同工作区已有会话的 inputState 模板，尽量与当前 VS Code 版本兼容。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineStore } from '../core/adapter.js';
import { block, createConversation, msg } from '../core/ucm.js';
import { ensureDir, exists, shortHash, uid } from '../core/util.js';
import { closeQuietly, insertLoose, openDb, tableExists } from '../core/sqlite.js';
import { findExistingDir, firstLine, readJsonSafe, writeRecord } from './_shared.js';

export default defineStore({
  id: 'vscode-copilot',
  name: 'GitHub Copilot Chat',
  vendor: 'GitHub / Microsoft',
  category: 'ide',
  region: 'global',
  docs: 'https://code.visualstudio.com/docs/copilot/chat/chat-overview',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },

  async scan(env) {
    const out = [];
    for (const host of ['code', 'codeInsiders', 'vscodium']) {
      const userDir = env.codeUser(host);
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
        const wsJson = await readJsonSafe(path.join(dir, 'workspace.json'));
        const folder = decodeFileUri(wsJson?.folder || wsJson?.workspace || '') || undefined;
        out.push(...(await scanChatDir(path.join(dir, 'chatSessions'), { host, folder, workspaceHash: d.name })));
      }
      out.push(
        ...(await scanChatDir(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'), {
          host,
          folder: undefined,
          workspaceHash: null,
        })),
      );
      out.push(...(await scanSessionStore(path.join(userDir, 'globalStorage', 'github.copilot-chat', 'session-store.db'), host)));
    }
    // 去重（同一 sessionId 可能同时出现在 jsonl 与 db）
    const seen = new Set();
    return out.filter((s) => {
      const key = `${s.meta?.host}:${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  async read(env, ref) {
    if (ref.meta?.store === 'db') return readFromDb(ref);
    return readFromJsonl(ref);
  },

  async import(env, conv, opts) {
    const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
    const hostDirName = 'code';
    const userDir = env.codeUser(hostDirName);
    if (!(await exists(userDir))) {
      return { writes: [], notes: ['未检测到 VS Code，Copilot Chat 无法原生导入；建议改为导出交接包。'] };
    }
    const resolved = await resolveWorkspaceDir(userDir, cwd, { create: !opts.dryRun });
    const targetDir = resolved.sessionsDir;
    const sessionId = uid();
    const file = path.join(targetDir, `${sessionId}.jsonl`);

    const template = await findTemplateState(resolved.dir);
    const state = buildSessionState(conv, sessionId, template);
    const line = JSON.stringify({ kind: 0, v: state });
    const notes = [];
    const writes = [];

    if (opts.dryRun) {
      return { writes: [{ path: file, bytes: Buffer.byteLength(line), kind: 'vscode-chatsession', preview: true }], notes };
    }
    await ensureDir(targetDir);
    await fsp.writeFile(file, line + '\n', 'utf8');
    writes.push(writeRecord(file, line, 'vscode-chatsession'));

    if (resolved.created) {
      notes.push(`已新建工作区存储目录 ${path.basename(resolved.dir)}；首次打开该文件夹后会话才会出现在列表中。`);
    }

    // 同步写入 Copilot 的会话索引库（存在才写）
    try {
      const dbFile = path.join(userDir, 'globalStorage', 'github.copilot-chat', 'session-store.db');
      if (await exists(dbFile)) {
        const db = await openDb(dbFile, { readOnly: false });
        try {
          if (tableExists(db, 'sessions')) {
            const now = new Date().toISOString();
            insertLoose(db, 'sessions', {
              id: sessionId,
              cwd,
              summary: conv.title,
              created_at: now,
              updated_at: now,
            });
            if (tableExists(db, 'turns')) {
              let idx = 0;
              for (const m of conv.messages) {
                if (m.role !== 'user' && m.role !== 'assistant') continue;
                const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
                if (!text) continue;
                insertLoose(db, 'turns', {
                  session_id: sessionId,
                  turn_index: idx++,
                  user_message: m.role === 'user' ? text : null,
                  assistant_response: m.role === 'assistant' ? text : null,
                  timestamp: m.createdAt || now,
                });
              }
            }
            writes.push(writeRecord(dbFile, '', 'copilot-chat-index'));
            notes.push('已写入 Copilot Chat 会话索引');
          }
        } finally {
          closeQuietly(db);
        }
      }
    } catch (err) {
      notes.push(`会话索引库写入跳过：${firstLine(err.message, 100)}`);
    }

    notes.push('重启 VS Code（或重新加载窗口）后，在 Chat 历史中可见。');
    return {
      writes,
      notes,
      resume: { cwd, command: '在 VS Code 中打开 Copilot Chat → 历史会话', sessionId },
    };
  },

  resumeHint() {
    return '重启 VS Code，打开 Chat 视图的历史会话列表即可继续。';
  },
});

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

export async function scanChatDir(dir, meta) {
  const out = [];
  if (!(await exists(dir))) return out;
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.size < 50) continue;
    const head = await fsp.readFile(full, 'utf8').catch(() => '');
    const info = parseSessionHead(head);
    if (!info.sessionId) continue;
    out.push({
      id: info.sessionId,
      title: info.title || `Copilot 会话 ${info.sessionId.slice(0, 8)}`,
      path: full,
      createdAt: info.createdAt,
      updatedAt: st.mtime.toISOString(),
      bytes: st.size,
      workspace: meta.folder,
      preview: info.title,
      messages: info.requests,
      meta: { ...meta, source: 'chatSessions' },
    });
  }
  return out;
}

function parseSessionHead(text) {
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.kind === 0 && rec.v) {
      const v = rec.v;
      info.sessionId = v.sessionId;
      info.createdAt = v.creationDate ? new Date(v.creationDate).toISOString() : undefined;
      info.requests = Array.isArray(v.requests) ? v.requests.length : 0;
      const first = v.requests?.[0];
      info.title = first ? firstLine(requestUserText(first), 90) : '';
    }
    if (info.sessionId && info.title) break;
  }
  return info;
}

async function scanSessionStore(dbFile, host) {
  if (!(await exists(dbFile))) return [];
  const out = [];
  let db;
  try {
    db = await openDb(dbFile, { readOnly: true });
    if (!tableExists(db, 'sessions')) return [];
    const rows = db.prepare('select * from sessions').all();
    const turnCounts = new Map();
    if (tableExists(db, 'turns')) {
      for (const r of db.prepare('select session_id, count(*) c from turns group by session_id').all()) {
        turnCounts.set(r.session_id, r.c);
      }
    }
    for (const r of rows) {
      out.push({
        id: r.id,
        title: r.summary || `Copilot 会话 ${String(r.id).slice(0, 8)}`,
        path: `${dbFile}#${r.id}`,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        workspace: r.cwd || undefined,
        messages: turnCounts.get(r.id) || 0,
        meta: { host, source: 'session-store.db', store: 'db', dbFile },
      });
    }
  } catch {
    return out;
  } finally {
    closeQuietly(db);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

export async function readFromJsonl(ref) {
  const text = await fsp.readFile(ref.path, 'utf8');
  let state = null;
  const requests = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.kind === 0 && rec.v) {
      state = rec.v;
      if (Array.isArray(state.requests)) {
        requests.length = 0;
        requests.push(...state.requests);
      }
    } else if (rec.kind === 1 && Array.isArray(rec.k)) {
      // 路径补丁：["requests", 0, "response"]
      applyPatch(state, rec.k, rec.v);
    }
  }

  const messages = [];
  for (const req of requests) {
    const userText = requestUserText(req);
    if (userText) {
      messages.push({
        id: req.requestId || uid('m_'),
        role: 'user',
        createdAt: req.timestamp ? new Date(req.timestamp).toISOString() : undefined,
        blocks: [block.text(userText)],
      });
    }
    const blocks = responseBlocks(req);
    if (blocks.length) {
      messages.push({
        id: uid('m_'),
        role: 'assistant',
        createdAt: req.timestamp ? new Date(req.timestamp).toISOString() : undefined,
        blocks,
        ...(req.modelId ? { model: req.modelId } : {}),
      });
    }
  }

  return createConversation({
    id: ref.id,
    title: ref.title,
    createdAt: messages[0]?.createdAt || ref.createdAt,
    updatedAt: ref.updatedAt,
    source: {
      adapter: 'vscode-copilot',
      name: 'GitHub Copilot Chat',
      vendor: 'GitHub / Microsoft',
      sessionId: ref.id,
      path: ref.path,
    },
    workspace: ref.workspace ? { cwd: ref.workspace } : undefined,
    model: state?.inputState?.selectedModel?.identifier ? { id: state.inputState.selectedModel.identifier } : undefined,
    messages,
  });
}

async function readFromDb(ref) {
  const db = await openDb(ref.meta.dbFile, { readOnly: true });
  try {
    const session = db.prepare('select * from sessions where id = ?').get(ref.id) || {};
    const turns = tableExists(db, 'turns')
      ? db.prepare('select * from turns where session_id = ? order by turn_index').all(ref.id)
      : [];
    const messages = [];
    for (const t of turns) {
      if (t.user_message) {
        messages.push({ id: `${ref.id}-u-${t.id}`, role: 'user', createdAt: t.timestamp, blocks: [block.text(t.user_message)] });
      }
      if (t.assistant_response) {
        messages.push({
          id: `${ref.id}-a-${t.id}`,
          role: 'assistant',
          createdAt: t.timestamp,
          blocks: [block.text(t.assistant_response)],
        });
      }
    }
    return createConversation({
      id: ref.id,
      title: session.summary || ref.title,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      source: {
        adapter: 'vscode-copilot',
        name: 'GitHub Copilot Chat',
        vendor: 'GitHub / Microsoft',
        sessionId: ref.id,
        path: ref.path,
      },
      workspace: session.cwd ? { cwd: session.cwd } : undefined,
      messages,
    });
  } finally {
    closeQuietly(db);
  }
}

function applyPatch(state, keys, value) {
  if (!state) return;
  let obj = state;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (obj[k] == null) obj[k] = typeof keys[i + 1] === 'number' ? [] : {};
    obj = obj[k];
  }
  obj[keys[keys.length - 1]] = value;
}

function requestUserText(req) {
  if (!req) return '';
  const msgObj = req.message || {};
  if (typeof msgObj.text === 'string' && msgObj.text) return msgObj.text;
  if (Array.isArray(msgObj.parts)) {
    return msgObj.parts
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof req.message === 'string') return req.message;
  return '';
}

function responseBlocks(req) {
  const out = [];
  const response = Array.isArray(req.response) ? req.response : [];
  for (const r of response) {
    if (!r || typeof r !== 'object') continue;
    switch (r.kind) {
      case 'markdownContent':
        if (r.content?.value) out.push(block.text(r.content.value));
        break;
      case 'thinking':
        if (r.value) out.push(block.thinking(r.value));
        break;
      case 'toolInvocationSerialized': {
        const name = r.toolId || r.toolName || 'tool';
        const input = r.invocationMessage?.value || r.invocationMessage || {};
        out.push(block.toolCall(name, input, r.toolCallId));
        if (r.resultDetails?.output || r.pastTenseMessage?.value) {
          out.push(
            block.toolResult(r.toolCallId, r.resultDetails?.output || r.pastTenseMessage?.value || '', {
              name,
              isError: r.isError,
            }),
          );
        }
        break;
      }
      case 'textEditGroup': {
        const edits = Array.isArray(r.edits) ? r.edits : [];
        out.push(block.text(`（编辑了 ${edits.length} 处：${r.uri?.fsPath || r.uri?.path || ''}）`));
        break;
      }
      case 'progressTask':
        if (r.content?.value) out.push(block.text(r.content.value));
        break;
      case 'warning':
        if (r.content?.value) out.push(block.text(`⚠️ ${r.content.value}`));
        break;
      default:
        if (r.content?.value) out.push(block.text(r.content.value));
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

function encodeFileUri(p) {
  const normalized = String(p).replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/:/g, '%3A')}`;
}

function decodeFileUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (!uri.startsWith('file://')) return '';
  let s = uri.slice('file://'.length);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  s = s.replace(/^\/([a-zA-Z])%?3?[aA]?\//, '/$1:/'); // 容错
  s = s.replace(/^\/([a-zA-Z]):/, '$1:');
  return s.replace(/\//g, path.sep === '/' ? '/' : '\\');
}

export async function resolveWorkspaceDir(userDir, cwd, { create = true } = {}) {
  const wsRoot = path.join(userDir, 'workspaceStorage');
  if (create) await ensureDir(wsRoot);
  const match = await findExistingDir(wsRoot, async (dir) => {
    const j = await readJsonSafe(path.join(dir, 'workspace.json'));
    const folder = decodeFileUri(j?.folder || j?.workspace || '');
    return folder && samePathLoose(folder, cwd);
  });
  if (match) {
    return { dir: match, created: false, sessionsDir: path.join(match, 'chatSessions') };
  }
  const uri = encodeFileUri(cwd);
  const hash = crypto.createHash('md5').update(uri).digest('hex');
  const dir = path.join(wsRoot, hash);
  if (create) {
    await ensureDir(dir);
    await fsp.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ folder: uri }), 'utf8');
  }
  return { dir, created: true, sessionsDir: path.join(dir, 'chatSessions') };
}

function samePathLoose(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export async function findTemplateState(workspaceDir) {
  const dir = path.join(workspaceDir, 'chatSessions');
  try {
    const files = await fsp.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const text = await fsp.readFile(path.join(dir, f), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.kind === 0 && rec.v?.inputState) return rec.v.inputState;
      }
    }
  } catch {
    /* 没有模板就手工构造 */
  }
  return null;
}

export function buildSessionState(conv, sessionId, template) {
  const now = Date.now();
  const requests = [];
  const messages = conv.messages;

  const responseOf = (blocks) => {
    const out = [];
    for (const b of blocks) {
      if (b.type === 'text') out.push({ kind: 'markdownContent', content: { value: b.text } });
      else if (b.type === 'thinking') out.push({ kind: 'thinking', value: b.text });
      else if (b.type === 'tool_call')
        out.push({
          kind: 'toolInvocationSerialized',
          toolId: b.name,
          toolCallId: b.id,
          invocationMessage: { value: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) },
          isComplete: true,
        });
      else if (b.type === 'tool_result')
        out.push({ kind: 'markdownContent', content: { value: '```\n' + String(b.output ?? '').slice(0, 4000) + '\n```' } });
    }
    return out;
  };

  let index = 0;
  for (let k = 0; k < messages.length; k++) {
    const m = messages[k];
    if (m.role !== 'user') continue;
    const userText = m.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (!userText) continue;

    const replyBlocks = [];
    let j = k + 1;
    while (j < messages.length && messages[j].role !== 'user') {
      if (messages[j].role === 'assistant' || messages[j].role === 'tool') replyBlocks.push(...messages[j].blocks);
      j++;
    }

    requests.push({
      requestId: `ferry-${shortHash(`${sessionId}:${index++}`, 16)}`,
      message: { text: userText, parts: [{ text: userText }] },
      variableData: { variables: [] },
      response: responseOf(replyBlocks),
      timestamp: m.createdAt ? new Date(m.createdAt).getTime() : now,
      modelId: conv.model?.id,
      modelState: { value: 1, completedAt: now },
      isCanceled: false,
      agent: { id: 'github.copilot.default', name: 'Ferry' },
    });
    k = j - 1;
  }

  return {
    version: 3,
    creationDate: conv.createdAt ? new Date(conv.createdAt).getTime() : now,
    initialLocation: 'panel',
    responderUsername: '',
    sessionId,
    hasPendingEdits: false,
    requests,
    pendingRequests: [],
    inputState: template
      ? { ...template, inputText: '' }
      : {
          attachments: [],
          mode: { id: 'agent', kind: 'agent' },
          selectedModel: { identifier: conv.model?.id || 'copilot/auto', metadata: { id: conv.model?.id || 'auto', name: 'Auto' } },
          inputText: '',
          selections: [],
          permissionLevel: 'default',
          contrib: {},
        },
  };
}

