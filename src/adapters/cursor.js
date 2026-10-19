/**
 * Cursor 适配器（Composer / Agent 会话）
 *
 * 存储位置：
 *   <User>/globalStorage/state.vscdb         sqlite，表 cursorDiskKV
 *   cursorDiskKV['composerData:<id>']        会话元数据 + bubble 顺序
 *   cursorDiskKV['bubbleId:<composerId>:<bubbleId>']   单条消息
 *   ItemTable['composer.composerData']       会话列表（allComposers）
 *
 * 注意：Cursor 不保证跨版本兼容，导入属于"尽力而为"，写入前会备份数据库。
 * 导入前请退出 Cursor，否则 SQLite 可能被锁。
 */
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';
import { closeQuietly, openDb, tableExists } from '../core/sqlite.js';
import { exists, existsSync, isoFrom, uid } from '../core/util.js';

const HOSTS = ['cursor', 'cursorNightly'];

export default defineStore({
  id: 'cursor',
  name: 'Cursor',
  vendor: 'Anysphere',
  category: 'ide',
  region: 'global',
  docs: 'https://cursor.com/docs',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },
  experimental: true,

  async scan(env) {
    const out = [];
    for (const host of HOSTS) {
      const dbFile = path.join(env.globalStorage(host), 'state.vscdb');
      if (!(await exists(dbFile))) continue;
      let db;
      try {
        db = await openDb(dbFile, { readOnly: true });
        if (!tableExists(db, 'cursorDiskKV')) continue;
        const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
        for (const row of rows) {
          const data = parseJson(row.value);
          if (!data) continue;
          const id = String(row.key).slice('composerData:'.length);
          const conv = data.conversation || data.bubbles || [];
          out.push({
            id,
            title: data.name || data.title || `Cursor 会话 ${id.slice(0, 8)}`,
            path: `${dbFile}#${id}`,
            createdAt: isoFrom(data.createdAt || data.created_at),
            updatedAt: isoFrom(data.lastUpdatedAt || data.updatedAt),
            workspace: cursorWorkspace(data),
            messages: Array.isArray(conv) ? conv.length : 0,
            bytes: Buffer.byteLength(JSON.stringify(data)),
            meta: { host, dbFile, composerId: id },
          });
        }
      } catch {
        /* 该 Cursor 版本可能换了存储方式：跳过，不影响其它适配器 */
      } finally {
        closeQuietly(db);
      }
    }
    return out;
  },

  async read(env, ref) {
    const { dbFile, composerId } = ref.meta || {};
    const db = await openDb(dbFile, { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`);
      const data = parseJson(row?.value) || {};
      const order = Array.isArray(data.conversation) ? data.conversation : [];
      const messages = [];

      for (const item of order) {
        const bubbleId = typeof item === 'string' ? item : item?.bubbleId || item?.id;
        if (!bubbleId) continue;
        const bRow = db
          .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
          .get(`bubbleId:${composerId}:${bubbleId}`);
        const bubble = parseJson(bRow?.value);
        if (!bubble) continue;
        const built = bubbleToMessage(bubble);
        if (built) messages.push(built);
      }

      return createConversation({
        id: composerId,
        title: ref.title,
        createdAt: messages[0]?.createdAt || ref.createdAt,
        updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
        source: {
          adapter: 'cursor',
          name: 'Cursor',
          vendor: 'Anysphere',
          sessionId: composerId,
          path: dbFile,
        },
        workspace: { cwd: cursorWorkspace(data) },
        model: data.modelConfig?.modelName ? { id: data.modelConfig.modelName } : undefined,
        messages,
      });
    } finally {
      closeQuietly(db);
    }
  },

  async import(env, conv, opts) {
    const host = HOSTS.find((h) => existsSync(env.globalStorage(h)));
    if (!host) {
      return { writes: [], notes: ['未检测到 Cursor；无法写入。可改用 --to handoff。'] };
    }
    const dbFile = path.join(env.globalStorage(host), 'state.vscdb');
    if (!(await exists(dbFile))) {
      return { writes: [], notes: [`找不到 Cursor 数据库：${dbFile}`] };
    }
    const composerId = uid();
    const now = Date.now();
    const items = [];
    const bubbles = [];
    let i = 0;
    for (const m of conv.messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = m.blocks
        .filter((b) => b.type === 'text' || b.type === 'thinking')
        .map((b) => b.text)
        .join('\n\n');
      const tools = m.blocks.filter((b) => b.type === 'tool_call');
      if (!text && !tools.length) continue;
      const bubbleId = uid();
      bubbles.push({
        key: `bubbleId:${composerId}:${bubbleId}`,
        value: {
          bubbleId,
          type: m.role === 'user' ? 1 : 2,
          text,
          richText: text,
          createdAt: m.createdAt || new Date(now + i).toISOString(),
          ...(tools.length
            ? {
                toolFormerData: {
                  toolName: tools[0].name,
                  params: tools[0].input,
                },
              }
            : {}),
        },
      });
      items.push({ type: m.role === 'user' ? 1 : 2, bubbleId });
      i++;
    }
    if (!items.length) return { writes: [], notes: ['没有可写入的消息'] };

    const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
    const composer = {
      composerId,
      name: conv.title,
      createdAt: conv.createdAt ? new Date(conv.createdAt).getTime() : now,
      lastUpdatedAt: now,
      conversation: items,
      status: 'completed',
      context: { folder: { uri: `file://${cwd.replace(/\\/g, '/')}` } },
      modelConfig: { modelName: conv.model?.id || 'auto' },
      unifiedMode: 'agent',
      isAgentic: true,
      numBubbles: items.length,
    };

    const writes = [];
    if (opts.dryRun) {
      return {
        writes: [
          { path: dbFile, bytes: 0, kind: 'cursor-composer', preview: true },
          ...bubbles.map((b) => ({ path: dbFile, bytes: 0, kind: 'cursor-bubble', preview: true })),
        ],
        notes: ['模拟模式：未写入；实际导入前请退出 Cursor'],
      };
    }

    const db = await openDb(dbFile, { readOnly: false });
    try {
      const tx = db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
      tx.run(`composerData:${composerId}`, JSON.stringify(composer));
      for (const b of bubbles) tx.run(b.key, JSON.stringify(b.value));
      // 更新会话列表
      try {
        if (tableExists(db, 'ItemTable')) {
          const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
          const list = parseJson(row?.value);
          if (list && Array.isArray(list.allComposers)) {
            list.allComposers.unshift({
              composerId,
              name: conv.title,
              createdAt: composer.createdAt,
              lastUpdatedAt: now,
              type: 'agent',
              unifiedMode: 'agent',
              isArchived: false,
              isDraft: false,
            });
            db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('composer.composerData', ?)").run(
              JSON.stringify(list),
            );
          }
        }
      } catch {
        /* 列表结构变化时忽略，composerData 本身仍可被读取 */
      }
    } finally {
      closeQuietly(db);
    }

    writes.push({ path: dbFile, bytes: 0, kind: 'cursor-composer' });
    return {
      writes,
      notes: ['已写入 Cursor 数据库；重启 Cursor 后打开 Composer 历史即可看到。'],
      resume: { cwd, command: '打开 Cursor → Composer 历史（Ctrl/Cmd+I）' },
    };
  },

  resumeHint() {
    return '重启 Cursor，在 Composer / Agent 历史中选择该会话。';
  },
});

/* ------------------------------------------------------------------ */

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch {
    return null;
  }
}

function cursorWorkspace(data) {
  const folder = data?.context?.folder?.uri || data?.workspaceIdentifier?.uri || data?.context?.repository;
  if (!folder) return undefined;
  try {
    const s = decodeURIComponent(String(folder).replace(/^file:\/\//, ''));
    return s.replace(/^\/([a-zA-Z]):/, '$1:').replace(/\//g, '\\');
  } catch {
    return String(folder);
  }
}

function bubbleToMessage(bubble) {
  const text = bubble.text || bubble.richText || '';
  const blocks = [];
  if (text) blocks.push(block.text(text));
  const tf = bubble.toolFormerData;
  if (tf && tf.toolName) blocks.push(block.toolCall(tf.toolName, tf.params ?? {}, bubble.bubbleId));
  if (!blocks.length) return null;
  return {
    id: bubble.bubbleId || uid('m_'),
    role: bubble.type === 1 ? 'user' : 'assistant',
    createdAt: isoFrom(bubble.createdAt || bubble.timestamp),
    blocks,
  };
}
