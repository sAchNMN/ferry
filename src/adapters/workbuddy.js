/**
 * WorkBuddy（腾讯 WorkBuddy 桌面端）适配器
 *
 * 存储位置（`~/.workbuddy`）：
 *   projects/<slug>/<sessionId>.jsonl        会话正文，一行一个事件
 *   projects/<slug>/<sessionId>/tool-results/ 大输出的溢写文件（正文里只留 <persisted-output> 占位，导出时读回内联）
 *   workbuddy.db → sessions 表                应用内会话列表索引（侧栏历史读这里）
 *   blobs/<前两位>/<sha256>.<ext>             图片正文，image_blob_ref 里带 blob_path 直指
 *
 * slug 规则（用本机 123 行 sessions 实测，113 行能对上；剩下 8 行是 `D:\` 与 UNC，
 * 也符合同一规则 —— 盘根 `D:` 落成 `d`，UNC 去掉前导分隔符）：
 *   C:\Users\me\Desktop\Thdr        → c-Users-me-Desktop-Thdr
 *   \\wsl.localhost\Ubuntu\home\z\p → wsl.localhost-Ubuntu-home-z-p
 *   D:\                             → d
 *
 * 事件类型（实测 8 种）：
 *   session-meta          会话开局标记，无正文
 *   message               role=user/assistant，content[] 里是 input_text / output_text / image_blob_ref
 *   reasoning             模型的思考，rawContent[] 里是 reasoning_text
 *   function_call         工具调用，arguments 是 JSON 字符串
 *   function_call_result  工具结果，output 是 {type:'text',text} 或数组
 *   ai-title              模型生成的标题
 *   file-history-snapshot 文件快照（与对话无关）
 *   resend-fork-notice    重发标记（与对话无关）
 *
 * 关键坑：WorkBuddy 每一轮都会把 `<system-reminder>`（环境上下文 / 身份文件 / 记忆提醒）
 * 塞进 user 消息的同一个 input_text 块里，真正的用户输入在后面的 `<user_query>` 标签里。
 * 不做剥离的话，导出的会话会变成一堆 8KB 的系统提示，标题也会取成提示词原文 ——
 * 这正是 Codex 适配器踩过的同一个坑（见 docs/lanes/adapter-codex.md）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';
import { ensureDir, exists, isoFrom, uid } from '../core/util.js';
import { splitPath } from '../core/paths.js';
import { closeQuietly, columns, insertLoose, openDb, sampleRow, tableExists } from '../core/sqlite.js';
import { firstLine, forEachLine, readHead, writeRecord } from './_shared.js';

const IGNORED_EVENTS = new Set(['file-history-snapshot', 'resend-fork-notice']);

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

export default defineStore({
  id: 'workbuddy',
  name: 'WorkBuddy',
  vendor: '腾讯',
  category: 'desktop',
  region: 'cn',
  docs: 'https://www.workbuddy.cn/docs/workbuddy/Overview',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: true, tools: true },

  async scan(env) {
    const root = wbRoot(env);
    const projectsDir = path.join(root, 'projects');
    if (!(await exists(projectsDir))) return [];

    const index = await readSessionIndex(path.join(root, 'workbuddy.db'));
    let dirs;
    try {
      dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projectsDir, d.name);
      let files;
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        // 只认 `<uuid>.jsonl`；同目录下的 `<uuid>.file-rollback.ndjson` 是回滚日志，不是会话
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -'.jsonl'.length);
        const full = path.join(dir, f);
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isFile() || st.size === 0) continue;

        const row = index.get(id);
        // UI 里删掉的会话：文件可能还在，但不该跟着迁移
        if (row?.deleted_at) continue;

        const head = await readHead(full, 64 * 1024);
        // 打开过但一句话没发的空会话（实测 Copilot 那批就是这么来的噪音）：直接不列
        if (!/"type"\s*:\s*"message"/.test(head)) continue;
        const meta = parseHead(head);

        const title = pickTitle(row, meta, id);
        out.push({
          id,
          title,
          path: full,
          createdAt: isoFrom(row?.created_at) || meta.timestamp,
          updatedAt: isoFrom(row?.updated_at) || isoFrom(row?.last_activity_at) || (st.mtime ? st.mtime.toISOString() : undefined),
          bytes: st.size,
          workspace: row?.cwd || meta.cwd,
          preview: meta.firstUser,
          meta: {
            projectSlug: d.name,
            // 注意：这里**不**打 internalSession —— scan 只读文件头，长会话里用户第一句话
            // 可能很靠后，用它过滤会把真实对话误判成内部会话（Codex 那边实测差了 15 个）。
            ...(row?.is_background_automation ? { backgroundAutomation: true } : {}),
          },
        });
      }
    }
    // 同一 id 只会出现在一个 slug 目录里（cwd 变了会新建目录），但保底去重
    const best = new Map();
    for (const s of out) {
      const prev = best.get(s.id);
      if (!prev || String(s.updatedAt || '') > String(prev.updatedAt || '')) best.set(s.id, s);
    }
    return [...best.values()];
  },

  async read(env, ref, ctx) {
    const messages = [];
    let cwd = ref.workspace;
    let model = null;
    let modelName = null;
    let aiTitle = '';
    let sessionMeta = null;
    let sessionId = ref.id;

    await forEachLine(ref.path, async (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== 'object') return;
      if (IGNORED_EVENTS.has(e.type)) return;
      if (e.cwd && !cwd) cwd = e.cwd;
      if (e.sessionId) sessionId = e.sessionId;

      switch (e.type) {
        case 'session-meta':
          sessionMeta = e.meta || null;
          return;

        case 'ai-title':
          if (e.aiTitle) aiTitle = String(e.aiTitle);
          return;

        case 'message': {
          const role = e.role === 'user' ? 'user' : e.role === 'assistant' ? 'assistant' : null;
          if (!role) return;
          const blocks = [];
          for (const c of Array.isArray(e.content) ? e.content : []) {
            if (typeof c === 'string') {
              pushText(blocks, role, c);
              continue;
            }
            if (!c || typeof c !== 'object') continue;
            switch (c.type) {
              case 'input_text':
              case 'output_text':
              case 'text':
                pushText(blocks, role, c.text);
                break;
              case 'image_blob_ref': {
                const b = await blobRefBlock(env, ref, ctx, c);
                if (b) blocks.push(b);
                break;
              }
              case 'image':
              case 'input_image': {
                const b = await inlineImageBlock(ctx, c);
                if (b) blocks.push(b);
                break;
              }
              default:
                if (c.text) blocks.push(block.text(String(c.text)));
                break;
            }
          }
          if (!blocks.length) return;
          const pv = e.providerData || {};
          if (pv.model) model = pv.model;
          if (pv.requestModelName) modelName = pv.requestModelName;
          const built = {
            id: e.id || uid('m_'),
            role,
            createdAt: isoFrom(e.timestamp),
            blocks,
          };
          if (role === 'assistant' && pv.model) built.model = pv.model;
          if (e.status === 'incomplete') built.meta = { truncated: true };
          messages.push(built);
          return;
        }

        case 'reasoning': {
          const text = reasoningText(e);
          if (!text.trim()) return;
          const pv = e.providerData || {};
          if (pv.model) model = pv.model;
          messages.push({ id: e.id || uid('m_'), role: 'assistant', createdAt: isoFrom(e.timestamp), blocks: [block.thinking(text)] });
          return;
        }

        case 'function_call': {
          let input = e.arguments;
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input);
            } catch {
              /* 保留原始字符串，总比丢掉强 */
            }
          }
          if (input === undefined) input = {};
          messages.push({
            id: e.id || uid('m_'),
            role: 'assistant',
            createdAt: isoFrom(e.timestamp),
            blocks: [block.toolCall(e.name, input, e.callId)],
          });
          return;
        }

        case 'function_call_result': {
          const output = await expandPersisted(env, ref, outputText(e.output));
          messages.push({
            id: e.id || uid('m_'),
            role: 'tool',
            createdAt: isoFrom(e.timestamp),
            blocks: [block.toolResult(e.callId, output, { name: e.name, isError: Boolean(e.status && e.status !== 'completed') })],
          });
          return;
        }

        default:
          return;
      }
    });

    const firstUser = messages.find((m) => m.role === 'user');
    const hasUser = Boolean(firstUser);
    const derived = firstUser ? firstLine(textOf(firstUser), 100) : '';

    return createConversation({
      id: sessionId,
      title: firstLine(ref.title, 120) || (aiTitle && !looksSynthetic(aiTitle) ? aiTitle : '') || derived || `WorkBuddy 会话 ${String(sessionId).slice(0, 8)}`,
      createdAt: messages[0]?.createdAt || ref.createdAt,
      updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
      source: {
        adapter: 'workbuddy',
        name: 'WorkBuddy',
        vendor: '腾讯',
        sessionId,
        path: ref.path,
      },
      workspace: { cwd },
      model: model ? { id: model, ...(modelName ? { name: modelName } : {}), vendor: 'tencent' } : undefined,
      messages,
      meta: {
        ...(sessionMeta?.['codebuddy.ai/hostKind'] ? { hostKind: sessionMeta['codebuddy.ai/hostKind'] } : {}),
        ...(aiTitle ? { aiTitle } : {}),
        // 和 Codex 一样：整段没有一句是用户说的（自动化跑批）就标出来，让上层能过滤
        ...(hasUser ? {} : { internalSession: true }),
      },
    });
  },

  async import(env, conv, opts) {
    const root = wbRoot(env);
    const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
    const sessionId = uid();
    const slug = projectSlug(cwd);
    const dir = path.join(root, 'projects', slug);
    const file = path.join(dir, `${sessionId}.jsonl`);
    const dbFile = path.join(root, 'workbuddy.db');

    const now = Date.now();
    const model = conv.model?.id || 'unknown';
    const lines = [];
    const blobWrites = [];
    const notes = [];
    // 一次导入算一个"请求上下文"，真实文件里同一次请求的事件共用这个 id
    const conversationRequestId = crypto.randomBytes(16).toString('hex');
    let parentId = null;
    let clock = now;
    let skippedBlocks = 0;

    /**
     * 写一行事件。字段对齐**真实 WorkBuddy 文件**（本机 120 个会话统计出来的集合），
     * 不是"我们自己的解析器能读"就算数 —— 那属于循环论证。
     *
     * 原则：补**身份/结构**字段（少了解析不了），
     *       不伪造**策略/遥测/展示**字段（usage、traceId、argumentsDisplayText、
     *       toolResult 的渲染结果）—— 那些是模型运行时算出来的，编数字只会骗用户。
     */
    const emit = (type, payload = {}, { providerFor = null, id = wbId(), timestamp, first = false, last = false } = {}) => {
      const record = { id };
      if (!first) record.parentId = parentId;
      record.timestamp = timestamp ?? clock++;
      record.type = type;
      Object.assign(record, payload);
      if (providerFor) {
        // 真实文件里用户消息的 providerData 只有 agent / conversationRequestId，
        // 模型相关字段是助手侧才有的
        record.providerData =
          providerFor === 'user'
            ? { agent: 'cli', conversationRequestId }
            : {
                agent: 'cli',
                conversationRequestId,
                messageId: crypto.createHash('md5').update(id).digest('hex'),
                model,
                requestModelId: model,
                requestModelName: conv.model?.name || model,
              };
      }
      // 真实数据里只有 session-meta 没有 cwd，其余事件都带
      if (type !== 'session-meta') record.cwd = cwd;
      record.sessionId = sessionId;
      // ai-title 在真实文件里没有 parentId（它是旁路标注，不在消息链上）
      if (last) delete record.parentId;
      lines.push(JSON.stringify(record));
      parentId = id;
      return id;
    };

    emit('session-meta', { meta: { 'codebuddy.ai/hostKind': 'unopted' } }, { first: true });

    for (const m of conv.messages || []) {
      if (m.role === 'system' || m.meta?.internal) continue;
      const ts = toMs(m.createdAt) ?? clock++;
      if (m.role === 'user') {
        const content = [];
        for (const b of m.blocks || []) {
          if (b.type === 'text') {
            if (b.text) content.push({ type: 'input_text', text: b.text });
          } else if (b.type === 'image' || b.type === 'file') {
            const ref = await materializeBlob(env, root, b, opts, blobWrites);
            if (ref) content.push(ref);
            else skippedBlocks++;
          }
        }
        if (!content.length) continue;
        emit('message', { role: 'user', content, status: 'completed' }, { providerFor: 'user', timestamp: ts });
        continue;
      }

      if (m.role === 'assistant') {
        for (const b of m.blocks || []) {
          if (b.type === 'text' && b.text) {
            emit(
              'message',
              { role: 'assistant', content: [{ type: 'output_text', text: b.text }], status: 'completed' },
              { providerFor: 'assistant', timestamp: ts },
            );
          } else if (b.type === 'thinking' && b.text) {
            emit(
              'reasoning',
              { content: [], rawContent: [{ type: 'reasoning_text', text: b.text }] },
              { providerFor: 'assistant', timestamp: ts },
            );
          } else if (b.type === 'tool_call') {
            emit(
              'function_call',
              { name: b.name || 'tool', arguments: JSON.stringify(b.input ?? {}), callId: b.id || uid('call_'), message: b.name || 'tool' },
              { providerFor: 'assistant', timestamp: ts },
            );
          } else if (b.type === 'image' || b.type === 'file') {
            skippedBlocks++;
          }
        }
        continue;
      }

      if (m.role === 'tool') {
        for (const b of m.blocks || []) {
          if (b.type !== 'tool_result') continue;
          emit(
            'function_call_result',
            {
              name: b.name || 'tool',
              callId: b.callId || '',
              output: { type: 'text', text: b.output || '' },
              status: b.isError ? 'error' : 'completed',
            },
            { providerFor: 'assistant', timestamp: ts },
          );
        }
      }
    }

    emit('ai-title', { aiTitle: firstLine(conv.title, 120) || '迁移的会话' }, { timestamp: clock++, last: true });

    const data = lines.join('\n') + '\n';
    const dbExists = await exists(dbFile);
    const userMsgCount = lines.filter((l) => l.includes('"role":"user"')).length;
    if (!userMsgCount) notes.push('该会话没有可导入的用户消息，导入后可能显示为空会话');
    if (skippedBlocks) notes.push(`${skippedBlocks} 个附件/图片没有可用的二进制内容，已跳过`);

    const previewWrites = [
      { path: file, bytes: Buffer.byteLength(data), kind: 'workbuddy-session', preview: true },
      ...blobWrites.map((w) => ({ ...w, preview: true })),
      // 干跑与真实执行必须报同一份清单，否则用户按预览判断风险就是错的
      ...(dbExists ? [{ path: dbFile, bytes: 0, kind: 'workbuddy-db', preview: true }] : []),
    ];

    if (opts.dryRun) {
      return {
        writes: previewWrites,
        notes: ['模拟模式：未写入', ...notes],
        resume: { cwd, sessionId },
        sessionId,
      };
    }

    await ensureDir(dir);
    await fsp.writeFile(file, data, 'utf8');
    for (const w of blobWrites) {
      await ensureDir(path.dirname(w.path));
      // wx: 同一 sha256 已经存在就别覆盖（内容寻址，内容必然相同）
      await fsp.writeFile(w.path, w.data, { flag: 'wx' }).catch(() => {});
    }

    const writes = [
      writeRecord(file, data, 'workbuddy-session'),
      ...blobWrites.map((w) => ({ path: w.path, bytes: w.size || 0, kind: 'workbuddy-blob' })),
    ];

    // 登记到 sessions 表，否则侧栏历史里看不到（应用只认数据库，不扫目录）
    try {
      const registered = await registerSession(env, {
        id: sessionId,
        cwd,
        title: conv.title,
        createdAt: toMs(conv.createdAt) ?? now,
        updatedAt: toMs(conv.updatedAt) ?? now,
        model,
      });
      if (registered) {
        writes.push(writeRecord(dbFile, '', 'workbuddy-db'));
        notes.push('已登记到 WorkBuddy 会话列表（重启应用后可见）');
      } else {
        notes.push('目标目录里没有 workbuddy.db，只写了会话文件；应用首次启动后可能不会自动登记');
      }
    } catch (err) {
      notes.push(`写 workbuddy.db 失败（会话文件已写入）：${firstLine(err.message, 140)}`);
    }

    return {
      writes,
      notes,
      resume: { cwd, sessionId },
      sessionId,
    };
  },

  /** 导入时会原地改写 workbuddy.db，三个文件一起备份才是一致快照（WAL 模式）。 */
  backupScope(env) {
    const root = wbRoot(env);
    return [path.join(root, 'workbuddy.db'), path.join(root, 'workbuddy.db-wal'), path.join(root, 'workbuddy.db-shm')];
  },

  resumeHint(conv, opts) {
    return opts?.sessionId
      ? '重启 WorkBuddy（或切到该工作区）后，侧栏历史里就能直接打开这条会话。'
      : '重启 WorkBuddy 后，在左侧历史列表里选择该会话。';
  },
});

/* ------------------------------------------------------------------ */

function wbRoot(env) {
  return path.join(env.home, '.workbuddy');
}

/**
 * cwd → projects 下的目录名。
 * 实测规则：盘符小写后接 `-`，其余分隔符一律变 `-`，UNC 去前导分隔符，尾部不留 `-`。
 */
export function projectSlug(cwd) {
  let s = String(cwd || '').replace(/\\/g, '/');
  s = s.replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}-`);
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/+/g, '-');
  s = s.replace(/-+$/, '');
  return s || 'root';
}

/**
 * 从 user 消息里剥掉机器注入的上下文，只留用户真正说的话。
 *
 * 结构（实测）：`<system-reminder ...>…</system-reminder>` × N，然后是 `<user_query>真正的输入</user_query>`。
 * 不剥离的后果是导出内容全是系统提示、标题取成提示词原文。
 */
export function cleanUserText(text) {
  let t = String(text ?? '');
  if (!t) return '';
  t = t.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '');
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(t);
  if (q) t = q[1];
  return t.trim();
}

function pushText(blocks, role, raw) {
  const text = role === 'user' ? cleanUserText(raw) : String(raw ?? '');
  if (!text) return;
  blocks.push(block.text(text));
}

function looksSynthetic(text) {
  const t = String(text || '').trimStart();
  if (!t) return true;
  return /^<[a-z][\w-]*>/i.test(t.slice(0, 200));
}

function pickTitle(row, meta, id) {
  const fromDb = [row?.custom_title, row?.title].find((t) => t && !looksSynthetic(t));
  const fromFile = [meta.aiTitle, meta.firstUser].find((t) => t && !looksSynthetic(t));
  return firstLine(fromDb || fromFile, 110) || `WorkBuddy 会话 ${String(id).slice(0, 8)}`;
}

function reasoningText(e) {
  const parts = [];
  for (const source of [e.rawContent, e.content]) {
    if (!Array.isArray(source)) {
      if (typeof source === 'string' && source) parts.push(source);
      continue;
    }
    for (const c of source) {
      if (typeof c === 'string') parts.push(c);
      else if (c?.text) parts.push(c.text);
      else if (c?.type === 'reasoning_text' && c.text) parts.push(c.text);
    }
  }
  return parts.join('\n');
}

/** function_call_result.output 有三种实测形态：字符串 / {type,text} / [{type:'input_text',text}]。 */
function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((c) => (typeof c === 'string' ? c : c?.text || (c?.type ? `［${c.type}］` : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;
    if (output.content != null) return outputText(output.content);
    return JSON.stringify(output, null, 2);
  }
  return String(output);
}

function textOf(m) {
  return m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function blobRefBlock(env, ref, ctx, c) {
  const mime = c.mime || 'image/png';
  const name = c.original_filename;
  const ext = MIME_EXT[mime] || extOf(c.blob_path);
  const file = await resolveStored(c.blob_path, (recorded) =>
    c.blob_id ? path.join(env.home, '.workbuddy', 'blobs', c.blob_id.slice(0, 2), `${c.blob_id}.${ext}`) : recorded,
  );
  if (file) {
    try {
      const data = await fsp.readFile(file);
      const sha = ctx?.blobs?.add?.(data, { mime, name });
      if (sha) return block.image(sha, mime, name);
    } catch {
      /* blob 被清理或换了机器，退化成文字占位 */
    }
  }
  const label = name || `blob ${String(c.blob_id || '').slice(0, 8)}`;
  return block.text(`［图片：${label}］`);
}

/**
 * 大输出不整段写进 JSONL：WorkBuddy 存成 `<persisted-output>` 占位，
 * 只留 2KB 预览 + 溢写文件路径。照抄占位会让 30~80KB 的命令输出迁移后只剩 2KB。
 * 读不到溢写文件就保留占位，不假装成功。
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

async function expandPersisted(env, ref, text) {
  if (typeof text !== 'string' || !text.startsWith('<persisted-output>')) return text;
  const m = /Full output saved to:\s*(.+?)\s*(?:\r?\n|$)/.exec(text);
  if (!m) return text;
  const recorded = m[1].trim();
  const file = await resolveStored(recorded, (p) =>
    // 末段必须跨平台取：POSIX 上 path.basename 会把整个 `C:\...\x.txt` 当文件名。
    path.join(env.home, '.workbuddy', 'projects', ref.meta?.projectSlug || '', ref.id, 'tool-results', splitPath(p).parts.at(-1) || ''),
  );
  if (!file) return text;
  try {
    const st = await fsp.stat(file);
    if (st.size > MAX_OUTPUT_BYTES) {
      const head = (await fsp.readFile(file, 'utf8')).slice(0, MAX_OUTPUT_BYTES);
      return `${head}\n\n[输出超过 ${Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)}MB，已截断]`;
    }
    return await fsp.readFile(file, 'utf8');
  } catch {
    return text;
  }
}

/**
 * 落盘路径可能是**另一台机器**的绝对路径（`--home F:\Users\alice` 离线迁移就是这种情况）。
 * 先按记录值读，读不到再按本机 env.home 重建一份，两条都失败才认输。
 */
async function resolveStored(recorded, rebuild) {
  for (const candidate of [recorded, rebuild(recorded)]) {
    if (!candidate) continue;
    try {
      const st = await fsp.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function extOf(file) {
  const m = /\.([a-z0-9]+)$/i.exec(String(file || ''));
  return m ? m[1].toLowerCase() : 'png';
}

async function inlineImageBlock(ctx, c) {
  const src = c.source || c;
  if (src?.type === 'base64' && src.data) {
    const data = Buffer.from(src.data, 'base64');
    const mime = src.media_type || c.mime || 'image/png';
    const sha = ctx?.blobs?.add?.(data, { mime, name: c.original_filename });
    if (sha) return block.image(sha, mime, c.original_filename);
    return block.text(`［图片：base64 ${data.length} 字节］`);
  }
  if (src?.type === 'url' && src.url) return block.text(`![image](${src.url})`);
  return block.text('［图片］');
}

function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 1e15 ? Math.round(value / 1000) : value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** 与真实文件的 id 同构：32 位 hex 的 UUID 布局，前 12 位带时间，天然按时间递增。 */
function wbId() {
  const hex = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(10).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/* ---------------------------- 索引读取 ---------------------------- */

/**
 * 读 sessions 表（只读）。应用在跑的时候库是 WAL 模式，读得到。
 * 任何失败都不阻断 —— 没有索引也能靠 JSONL 本身工作，只是标题和更新时间会退化。
 */
async function readSessionIndex(dbFile) {
  const map = new Map();
  if (!(await exists(dbFile))) return map;
  let db = null;
  try {
    db = await openDb(dbFile, { readOnly: true });
    if (!tableExists(db, 'sessions')) return map;
    const cols = new Set(columns(db, 'sessions').map((c) => c.name));
    const want = ['id', 'cwd', 'title', 'custom_title', 'created_at', 'updated_at', 'last_activity_at', 'deleted_at', 'is_background_automation'];
    const picked = want.filter((c) => cols.has(c));
    const rows = db.prepare(`SELECT ${picked.map((c) => `"${c}"`).join(',')} FROM "sessions"`).all();
    for (const row of rows) if (row.id) map.set(row.id, row);
  } catch {
    /* 库被独占 / 版本不认识：退化成只看文件 */
  } finally {
    closeQuietly(db);
  }
  return map;
}

/** 首页 64KB 里能拿到的元信息。 */
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
    if (!meta.cwd && e.cwd) meta.cwd = e.cwd;
    if (!meta.timestamp && e.timestamp) meta.timestamp = isoFrom(e.timestamp);
    if (e.type === 'ai-title' && e.aiTitle && !looksSynthetic(e.aiTitle)) meta.aiTitle = firstLine(e.aiTitle, 110);
    if (e.type === 'message' && e.role === 'user' && !meta.firstUser) {
      for (const c of Array.isArray(e.content) ? e.content : []) {
        const cleaned = cleanUserText(c?.text);
        if (cleaned && !looksSynthetic(cleaned)) {
          meta.firstUser = firstLine(cleaned, 100);
          break;
        }
      }
    }
    // 不提前 break：ai-title 是模型在首轮之后生成的，通常写在文件靠后的位置。
    // 只读 64KB，扫完的代价可以忽略，换来的是"没有数据库时标题依然准确"。
  }
  return meta;
}

/* ---------------------------- 导入落库 ---------------------------- */

function userIdFromStorage(root) {
  try {
    const entry = fs
      .readdirSync(path.join(root, 'storage'), { withFileTypes: true })
      .find((d) => d.isDirectory() && /^user-[0-9a-f-]{16,}$/i.test(d.name));
    return entry ? entry.name.replace(/^user-/, '') : '';
  } catch {
    return '';
  }
}

/**
 * 往 sessions 表插一行。user_id 必须沿用本机已有的值 —— 换了 id 应用会当成别的账号的数据。
 * 表结构随版本变，所以用 insertLoose（读现有行当模板 + 动态列）。
 */
async function registerSession(env, info) {
  const root = wbRoot(env);
  const dbFile = path.join(root, 'workbuddy.db');
  if (!(await exists(dbFile))) return false;
  const db = await openDb(dbFile, { readOnly: false });
  try {
    if (!tableExists(db, 'sessions')) return false;
    const template = sampleRow(db, 'sessions');
    const userId = template?.user_id || userIdFromStorage(root) || 'ferry-import';
    insertLoose(
      db,
      'sessions',
      {
        id: info.id,
        cwd: info.cwd,
        user_id: userId,
        title: String(info.title || '').slice(0, 500),
        custom_title: null,
        status: 'completed',
        created_at: info.createdAt,
        updated_at: info.updatedAt,
        last_activity_at: info.updatedAt,
        deleted_at: null,
        is_playground: 0,
        is_background_automation: 0,
        model: info.model || template?.model || null,
      },
      template,
    );
    // workspaces 只是"最近打开的项目"列表，写不进去不影响可见性
    if (tableExists(db, 'workspaces')) {
      try {
        db.prepare('INSERT OR IGNORE INTO "workspaces" ("path","last_opened_at") VALUES (?,?)').run(info.cwd, info.updatedAt);
      } catch {
        /* 列名变了就放弃，不影响主流程 */
      }
    }
    return true;
  } finally {
    closeQuietly(db);
  }
}

/** 图片落盘到 `blobs/<前两位>/<sha256>.<ext>`，返回 image_blob_ref 结构。 */
async function materializeBlob(env, root, b, opts, sink) {
  const blob = opts.blobs?.get?.(b.blob);
  if (!blob) return null;
  const sha = b.blob;
  const mime = blob.mime || b.mime || 'image/png';
  const ext = MIME_EXT[mime] || 'bin';
  const target = path.join(root, 'blobs', sha.slice(0, 2), `${sha}.${ext}`);
  sink.push({ path: target, kind: 'workbuddy-blob', bytes: blob.data.length, size: blob.data.length, data: blob.data });
  return {
    type: 'image_blob_ref',
    blob_id: sha,
    mime,
    size: blob.data.length,
    blob_path: target,
    ...(b.name ? { original_filename: b.name } : {}),
  };
}
