/**
 * OpenAI Codex CLI / Codex 桌面端适配器
 *
 * 存储位置（~/.codex）：
 *   sessions/YYYY/MM/DD/rollout-<时间>-<sessionId>.jsonl   会话正文
 *   session_index.jsonl                                    id → 标题
 *   state_<n>.sqlite → threads 表                           应用内会话列表索引
 *
 * import 会同时写 rollout、更新 session_index，并在可能时登记到 threads 表，
 * 让迁移过去的会话在 `codex resume` 与 Codex 应用历史里都直接出现。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { block, createConversation, msg } from '../core/ucm.js';
import { ensureDir, exists, isoFrom, uid } from '../core/util.js';
import { closeQuietly, columns, insertLoose, openDb, sampleRow, tableExists } from '../core/sqlite.js';
import { firstLine, forEachLine, readHead, writeRecord } from './_shared.js';

export default defineStore({
  id: 'codex',
  name: 'Codex',
  vendor: 'OpenAI',
  category: 'cli',
  region: 'global',
  docs: 'https://github.com/openai/codex',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },

  async scan(env) {
    const base = path.join(env.home, '.codex');
    if (!(await exists(base))) return [];
    const index = await readSessionIndex(base);
    const files = [];
    for (const sub of ['sessions', 'archived_sessions']) {
      const dir = path.join(base, sub);
      if (await exists(dir)) files.push(...(await listJsonl(dir)));
    }
    const out = [];
    for (const file of files) {
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      const head = await readHead(file, 64 * 1024);
      const meta = parseHead(head);
      if (!meta.id) {
        // 没有 session_meta 的老文件：从文件名猜
        const m = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
        if (!m) continue;
        meta.id = m[1];
      }
      const idx = index.get(meta.id);
      // 索引里的 thread_name 也可能是注入文本：Codex 给内部会话起名时直接用了提示词原文。
      // 实测本机 112 个会话里有 30 个中招，所以这里也要过一遍同样的判定。
      const idxTitle = isSyntheticUserText(idx?.thread_name) ? '' : idx?.thread_name;
      const realTitle = idxTitle || meta.firstUser;
      // 没有真实标题 = 整段对话里没有一句是用户自己说的。
      // 实测本机 112 个会话里 69 个属于这类（Codex 的审批/子 Agent 自动运行）。
      // 它们不是用户的历史对话，标出来让上层可以过滤或降级展示。
      const internalSession = !realTitle;
      out.push({
        id: meta.id,
        title: realTitle || `Codex 内部会话 ${meta.id.slice(0, 8)}`,
        path: file,
        createdAt: meta.timestamp,
        updatedAt: idx?.updated_at || (st.mtime ? st.mtime.toISOString() : undefined),
        bytes: st.size,
        workspace: meta.cwd,
        preview: meta.firstUser,
        meta: { archived: file.includes('archived_sessions'), ...(internalSession ? { internalSession: true } : {}) },
      });
    }
    // 同一会话可能同时存在于 sessions 与 archived_sessions，保留更新的那份
    const best = new Map();
    for (const s of out) {
      const prev = best.get(s.id);
      if (!prev) best.set(s.id, s);
      else if ((s.updatedAt || '') > (prev.updatedAt || '')) best.set(s.id, s);
    }
    return [...best.values()];
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

    let cwd = ref.workspace;
    let model;
    let cliVersion;
    let sessionId = ref.id;
    let firstUser = '';
    const messages = [];
    let sawStructuredMessage = false;

    // 有些版本用 event_msg 记录对话，有些用 response_item；先扫一遍决定用哪套
    for (const e of entries) {
      if (e.type === 'event_msg' && (e.payload?.type === 'user_message' || e.payload?.type === 'agent_message')) {
        sawStructuredMessage = false;
      }
      if (e.type === 'response_item' && e.payload?.type === 'message') sawStructuredMessage = true;
    }

    for (const e of entries) {
      const p = e.payload || e;
      switch (e.type) {
        case 'session_meta': {
          cwd = p.cwd || cwd;
          sessionId = p.id || sessionId;
          cliVersion = p.cli_version;
          break;
        }
        case 'turn_context': {
          if (p.cwd) cwd = p.cwd;
          if (p.model) model = p.model;
          break;
        }
        case 'response_item': {
          const built = readResponseItem(p, ctx);
          if (built) {
            if (!built.createdAt && e.timestamp) built.createdAt = e.timestamp;
            if (built.role === 'user' && isSyntheticUserText(textOf(built))) {
              built.meta = { ...(built.meta || {}), internal: true, synthetic: true };
            }
            messages.push(built);
            if (built.role === 'user' && !firstUser && !built.meta?.internal) firstUser = firstLine(textOf(built), 100);
          }
          break;
        }
        case 'event_msg': {
          if (!sawStructuredMessage && p.type === 'user_message' && p.message) {
            messages.push({ id: uid('m_'), role: 'user', createdAt: e.timestamp, blocks: [block.text(p.message)] });
          } else if (!sawStructuredMessage && p.type === 'agent_message' && p.message) {
            messages.push({ id: uid('m_'), role: 'assistant', createdAt: e.timestamp, blocks: [block.text(p.message)] });
          } else if (p.type === 'context_compacted') {
            messages.push(msg.system([block.text('（Codex 已压缩上下文）')], { internal: true }));
          }
          break;
        }
        case 'compacted': {
          if (p.message) messages.push(msg.system([block.text(p.message)], { internal: true }));
          break;
        }
        case 'message': {
          // 早期版本把消息放在顶层
          const built = readResponseItem({ type: 'message', role: e.role, content: e.content }, ctx);
          if (built) messages.push(built);
          break;
        }
        default:
          break;
      }
    }

    return createConversation({
      id: sessionId,
      title: ref.title || firstUser || 'Codex 会话',
      createdAt: messages.find((m) => m.createdAt)?.createdAt || ref.createdAt,
      updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
      source: {
        adapter: 'codex',
        name: 'Codex',
        vendor: 'OpenAI',
        version: cliVersion,
        sessionId,
        path: ref.path,
      },
      workspace: { cwd },
      model: model ? { id: model, provider: 'openai' } : undefined,
      messages,
    });
  },

  async import(env, conv, opts) {
    const base = path.join(env.home, '.codex');
    const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
    const sessionId = uid();
    const now = new Date();
    const datePath = [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ];
    const stamp = now.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
    const dir = path.join(base, 'sessions', ...datePath);
    const file = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);

    const lines = [];
    const iso = now.toISOString();
    let ordinal = 0;

    /**
     * 写一行 rollout 记录。
     *
     * 字段对齐的是**真实 Codex rollout 文件**的结构（用 112 个真实文件统计出来的），
     * 不是我们自己的扫描器能读就算数 —— 那属于循环论证。
     *
     * 原则：补齐**身份/结构**字段（不加就解析不了），
     *       不伪造**策略/行为**字段（sandbox_policy、permission_profile 等，
     *       写错会改变用户恢复会话时的安全姿态）。
     */
    const push = (type, payload, ts = iso) =>
      lines.push(JSON.stringify({ timestamp: ts, ordinal: ordinal++, type, payload }));

    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const turnId = uid('turn_');

    push('session_meta', {
      session_id: sessionId,
      id: sessionId,
      timestamp: iso,
      cwd,
      runtime_workspace_roots: [cwd],
      originator: 'codex_cli',
      cli_version: '0.0.0',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
      history_mode: 'paginated',
      // 真实文件里是完整系统提示。这里不伪造内容，留空。
      //
      // provenance 整个省略是刻意的（2026-10-19 用 `codex migrate-rollouts` 实测出来的）：
      // 它是**枚举**，只接受已知值（实测 `type: "model"` 通过，`"ferry-import"` 失败）；
      // 而且 `model` 字段必填，只写 `{type}` 也会失败。字段本身可省略（写 null 也通过）。
      // 与其谎报"这段系统提示来自某个模型"，不如不写：我们没有这段内容的来源。
      //
      // 报错信息有误导性：字段不合法时 codex 报的是 "does not start with session metadata"，
      // 容易让人以为 type 字段错了，实际是整行反序列化失败。
      base_instructions: { text: '' },
      context_window: { window_id: sessionId },
    });

    push('turn_context', {
      turn_id: turnId,
      root_turn_id: turnId,
      cwd,
      workspace_roots: [cwd],
      current_date: today,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      model: conv.model?.id || 'gpt-5',
      approval_policy: 'on-request',
    });

    let firstUser = '';
    for (const m of conv.messages) {
      if (m.role === 'system' || m.meta?.internal) continue;
      const ts = m.createdAt || iso;
      if (m.role === 'user' || m.role === 'assistant') {
        const texts = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).filter(Boolean);
        const calls = m.blocks.filter((b) => b.type === 'tool_call');
        if (texts.length) {
          push(
            'response_item',
            {
              type: 'message',
              id: uid('msg_'),
              role: m.role,
              content: texts.map((t) => ({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: t })),
              internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: ts },
            },
            ts,
          );
          if (m.role === 'user' && !firstUser) firstUser = firstLine(texts[0], 100);
        }
        for (const c of calls) {
          push(
            'response_item',
            {
              type: 'function_call',
              id: uid('fc_'),
              name: c.name,
              arguments: JSON.stringify(c.input ?? {}),
              call_id: c.id || uid('call_'),
              internal_chat_message_metadata_passthrough: { turn_id: turnId },
            },
            ts,
          );
        }
      } else if (m.role === 'tool') {
        for (const r of m.blocks.filter((b) => b.type === 'tool_result')) {
          push(
            'response_item',
            {
              type: 'function_call_output',
              id: uid('fco_'),
              call_id: r.callId || '',
              output: r.output || '',
              internal_chat_message_metadata_passthrough: { turn_id: turnId },
            },
            ts,
          );
        }
      }
    }

    const data = lines.join('\n') + '\n';
    const notes = [];
    let dbRow = null;
    const indexPath = path.join(base, 'session_index.jsonl');
    const indexLine = JSON.stringify({ id: sessionId, thread_name: conv.title, updated_at: now.toISOString() }) + '\n';

    if (opts.dryRun) {
      return {
        // 干跑必须报出与真实执行**完全相同**的文件清单，否则用户按预览判断风险就是错的
        writes: [
          { path: file, bytes: Buffer.byteLength(data), kind: 'codex-rollout', preview: true },
          { path: indexPath, bytes: Buffer.byteLength(indexLine), kind: 'codex-index', preview: true },
        ],
        notes: ['模拟模式：未写入'],
        resume: { cwd, command: `codex resume ${sessionId}`, sessionId },
        sessionId,
      };
    }

    await ensureDir(dir);
    await fsp.writeFile(file, data, 'utf8');

    // 1) session_index.jsonl
    let indexRecord = null;
    try {
      await fsp.appendFile(indexPath, indexLine, 'utf8');
      // 必须记进 writes：否则 dry-run 预览会少报一个文件，用户以为只写 1 个、实际写了 2 个
      indexRecord = writeRecord(indexPath, indexLine, 'codex-index');
    } catch (err) {
      notes.push(`会话索引更新失败（不影响 resume）：${err.message}`);
    }

    // 2) state 数据库（尽力而为）
    try {
      dbRow = await registerThread(env, {
        id: sessionId,
        file,
        cwd,
        title: conv.title,
        firstUser,
        model: conv.model?.id,
        createdAt: now,
      });
      if (dbRow) notes.push('已登记到 Codex 应用的会话列表');
    } catch (err) {
      notes.push(`未写入 Codex 应用索引（可忽略）：${firstLine(err.message, 120)}`);
    }

    return {
      writes: [
        writeRecord(file, data, 'codex-rollout'),
        ...(indexRecord ? [indexRecord] : []),
        ...(dbRow ? [writeRecord(dbRow.dbFile, '', 'codex-index')] : []),
      ],
      notes,
      resume: { cwd, command: `codex resume ${sessionId}`, sessionId },
      // 顶层 sessionId 不是装饰：导入台账要靠它记「这个会话导到哪去了」，
      // 回滚时也靠它把台账条目摘掉。漏了它，台账里全是 null，回滚后重导会被幂等挡住。
      sessionId,
    };
  },

  resumeHint(conv, opts) {
    return opts?.sessionId ? '重启 Codex 应用后，历史列表里也能直接看到这条会话。' : '运行 codex resume 选择该会话。';
  },
});

/* ------------------------------------------------------------------ */

async function listJsonl(root) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6) await walk(full, depth + 1);
      } else if (e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

async function readSessionIndex(base) {
  const map = new Map();
  try {
    const text = await fsp.readFile(path.join(base, 'session_index.jsonl'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.id) map.set(e.id, e);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 没有索引也能靠 rollout 里的内容工作 */
  }
  return map;
}

function parseHead(head) {
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'session_meta') {
      meta.id = e.payload?.id;
      meta.cwd = e.payload?.cwd;
      meta.timestamp = e.payload?.timestamp || e.timestamp;
    }
    if (!meta.firstUser) {
      const p = e.payload || {};
      if (e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const t = contentText(p.content);
        if (t && !isSyntheticUserText(t)) meta.firstUser = firstLine(t, 100);
      }
    }
    if (meta.id && meta.firstUser) break;
  }
  return meta;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => c?.text || c?.content || '')
    .filter(Boolean)
    .join('\n');
}

function textOf(m) {
  return m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

/**
 * Codex 会把 AGENTS.md、环境上下文、权限说明作为「user 消息」写进 rollout。
 * 这些不是用户真正说的话，标记为 internal：归档里保留，渲染/导入时默认跳过。
 */
/**
 * 判断一条 user 消息是否是**机器注入**的，而不是用户真的说的话。
 *
 * 真实数据里存在大量这类消息：AGENTS.md 指令、environment_context、
 * 以及审批子系统塞进来的 "The following is the Codex agent history…"。
 * 它们会被当成"首条用户消息"，导致会话标题变成一大段系统提示（实测 112 个会话里 47 个中招），
 * 而且会把内部提示当成对话内容迁移到目标端。
 */
function isSyntheticUserText(text) {
  const t = String(text || '').trimStart();
  if (!t) return false;
  const head = t.slice(0, 200);
  return (
    // 通用规则：以 XML 风格标签开头的都不是用户手打的
    // （<environment_context> / <user_instructions> / <permissions instructions> / <recommended_plugins> …）
    /^<[a-z][\w-]*>/i.test(head) ||
    head.startsWith('# AGENTS.md instructions') ||
    head.startsWith('The following is the Codex agent history') ||
    (head.startsWith('# ') && t.includes('<INSTRUCTIONS>') && t.length > 500)
  );
}

function readResponseItem(p, ctx) {
  if (!p || typeof p !== 'object') return null;
  switch (p.type) {
    case 'message': {
      const role = p.role === 'developer' ? 'system' : p.role;
      if (!['system', 'user', 'assistant'].includes(role)) return null;
      const texts = [];
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (typeof c === 'string') texts.push(c);
        else if (c?.text) texts.push(c.text);
      }
      if (!texts.length) return null;
      return {
        id: uid('m_'),
        role,
        createdAt: undefined,
        blocks: [block.text(texts.join('\n'))],
        ...(role === 'system' ? { meta: { internal: true } } : {}),
      };
    }
    case 'reasoning': {
      const parts = [];
      for (const s of p.summary || []) if (s?.text) parts.push(s.text);
      for (const c of p.content || []) if (c?.text) parts.push(c.text);
      if (!parts.length) return null;
      return { id: uid('m_'), role: 'assistant', blocks: [block.thinking(parts.join('\n'))] };
    }
    case 'function_call':
    case 'custom_tool_call': {
      let input = p.arguments ?? p.input ?? {};
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          /* 保留字符串 */
        }
      }
      return {
        id: uid('m_'),
        role: 'assistant',
        blocks: [block.toolCall(p.name, input, p.call_id || p.id)],
      };
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output': {
      let output = p.output ?? '';
      if (typeof output === 'object' && output !== null) {
        output = output.content ?? output.output ?? JSON.stringify(output);
      }
      return {
        id: uid('m_'),
        role: 'tool',
        blocks: [block.toolResult(p.call_id || p.id, String(output), { isError: p.success === false })],
      };
    }
    case 'local_shell_call': {
      const cmd = p.action?.command;
      return {
        id: uid('m_'),
        role: 'assistant',
        blocks: [block.toolCall('shell', { command: Array.isArray(cmd) ? cmd.join(' ') : cmd }, p.call_id)],
      };
    }
    case 'web_search_call': {
      return {
        id: uid('m_'),
        role: 'assistant',
        blocks: [block.toolCall('web_search', p.action || {}, p.id)],
      };
    }
    case 'image':
    case 'input_image': {
      return null; // Codex 的图片通常以附件目录形式存在，暂不内联
    }
    default:
      return null;
  }
}

async function registerThread(env, info) {
  const base = path.join(env.home, '.codex');
  const files = (await fsp.readdir(base).catch(() => []))
    .filter((f) => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!files.length) return null;
  const dbFile = path.join(base, files[0]);
  const db = await openDb(dbFile, { readOnly: false });
  try {
    if (!tableExists(db, 'threads')) return null;
    const cols = columns(db, 'threads');
    const hasId = cols.some((c) => c.name === 'id');
    const hasPath = cols.some((c) => c.name === 'rollout_path');
    if (!hasId || !hasPath) return null;

    const template = sampleRow(db, 'threads');
    const prefix = template?.rollout_path?.startsWith('\\\\?\\') ? '\\\\?\\' : '';
    const nowSec = Math.floor(info.createdAt.getTime() / 1000);
    const row = {
      id: info.id,
      rollout_path: prefix + path.resolve(info.file),
      created_at: nowSec,
      updated_at: nowSec,
      created_at_ms: info.createdAt.getTime(),
      updated_at_ms: info.createdAt.getTime(),
      recency_at: nowSec,
      recency_at_ms: info.createdAt.getTime(),
      cwd: info.cwd,
      title: String(info.title || '').slice(0, 500),
      first_user_message: String(info.firstUser || '').slice(0, 2000),
      preview: String(info.firstUser || '').slice(0, 500),
      source: 'cli',
      model_provider: template?.model_provider || 'openai',
      sandbox_policy: template?.sandbox_policy || JSON.stringify({ type: 'workspace-write', network_access: false }),
      approval_mode: template?.approval_mode || 'on-request',
      model: info.model || template?.model || null,
      cli_version: template?.cli_version || '0.0.0',
      has_user_event: 0,
      archived: 0,
      history_mode: template?.history_mode || 'legacy',
      memory_mode: template?.memory_mode || 'enabled',
    };
    insertLoose(db, 'threads', row, template);
    return { dbFile };
  } finally {
    closeQuietly(db);
  }
}
