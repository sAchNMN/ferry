/**
 * 外部导出文件导入器：ChatGPT / Claude 官方数据导出。
 *
 * 这两家都是"云端会话"，本地只可能拿到官方导出包（.zip 或解压后的 .json）。
 * 导入后会话进入 Ferry 归档，可以再转成任意本地 Agent 的原生格式，或生成交接包继续聊。
 */
import path from 'node:path';
import { defineImporter } from '../core/adapter.js';
import { block, createConversation, deriveTitle } from '../core/ucm.js';
import { isoFrom, uid } from '../core/util.js';
import { readZip } from '../core/zip.js';

/* ------------------------------------------------------------------ */
/* 公共：从 zip / json 里取出会话数组                                  */
/* ------------------------------------------------------------------ */

function entriesToJson(entries, matcher) {
  const hit = entries.find((e) => matcher(e.name));
  if (!hit) return null;
  try {
    return JSON.parse(hit.data.toString('utf8'));
  } catch {
    return null;
  }
}

export function extractConversations(buf, filename = '') {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    const entries = readZip(buf);
    const json =
      entriesToJson(entries, (n) => n === 'conversations.json') ||
      entriesToJson(entries, (n) => n.endsWith('/conversations.json')) ||
      entriesToJson(entries, (n) => n.endsWith('.json') && !n.includes('/__'));
    if (!json) throw new Error('ZIP 中找不到 conversations.json');
    return json;
  }
  if (/\.json$/i.test(filename) || buf.length) {
    return JSON.parse(buf.toString('utf8'));
  }
  throw new Error('无法识别的文件');
}

/* ------------------------------------------------------------------ */
/* ChatGPT                                                            */
/* ------------------------------------------------------------------ */

export const chatgptExport = defineImporter({
  id: 'chatgpt-export',
  name: 'ChatGPT 官方导出',
  vendor: 'OpenAI',
  description: '设置 → 数据控制 → 导出数据，解压或直接选择 .zip',
  extensions: ['.zip', '.json'],
  detect(buf, filename) {
    try {
      const data = extractConversations(buf, filename);
      const arr = Array.isArray(data) ? data : [data];
      return arr.some((c) => c && (c.mapping || c.conversation_id));
    } catch {
      return false;
    }
  },
  read(buf, filename) {
    const data = extractConversations(buf, filename);
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter((c) => c && c.mapping).map(chatgptToConversation);
  },
});

function chatgptToConversation(c) {
  const nodes = c.mapping || {};
  const chain = [];
  let id = c.current_node || findLeaf(nodes);
  const guard = new Set();
  while (id && nodes[id] && !guard.has(id)) {
    guard.add(id);
    chain.push(nodes[id]);
    id = nodes[id].parent;
  }
  chain.reverse();

  const messages = [];
  for (const node of chain) {
    const m = node?.message;
    if (!m) continue;
    const role = m.author?.role;
    if (!role) continue;
    if (m.metadata?.is_visually_hidden_from_conversation && role !== 'user') continue;
    if (m.metadata?.is_user_system_message) {
      const text = partsText(m.content);
      if (text) messages.push({ id: m.id || uid('m_'), role: 'system', createdAt: isoFrom(m.create_time), blocks: [block.text(text)] });
      continue;
    }

    const ct = m.content?.content_type;
    const ts = isoFrom(m.create_time);
    if (ct === 'text' || ct === 'multimodal_text' || ct === 'code' || ct === 'execution_output' || ct === 'thoughts' || ct === 'reasoning_recap') {
      const blocks = [];
      if (ct === 'thoughts') {
        const thought = thoughtsText(m.content);
        if (thought) blocks.push(block.thinking(thought));
      } else if (ct === 'reasoning_recap') {
        const text = partsText(m.content) || m.content?.content || '';
        if (text) blocks.push(block.thinking(text));
      } else if (ct === 'code' || (role === 'assistant' && m.recipient && m.recipient !== 'all')) {
        const code = partsText(m.content);
        blocks.push(block.toolCall(m.recipient || 'code', { code }, m.id));
      } else if (ct === 'execution_output') {
        blocks.push(block.toolResult('', partsText(m.content)));
      } else {
        for (const p of m.content?.parts || []) {
          if (typeof p === 'string') blocks.push(block.text(p));
          else if (p?.content_type === 'image_asset_pointer') blocks.push(block.text(`［图片 ${p.asset_pointer || ''}］`));
          else if (p?.text) blocks.push(block.text(p.text));
        }
      }
      if (!blocks.length) continue;
      const isTool = role === 'tool' || ct === 'execution_output';
      messages.push({
        id: m.id || uid('m_'),
        role: isTool ? 'tool' : role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user',
        createdAt: ts,
        blocks,
        ...(m.metadata?.model_slug ? { model: m.metadata.model_slug } : {}),
      });
    }
  }

  const conv = createConversation({
    id: c.conversation_id || uid('chatgpt_'),
    title: c.title || 'ChatGPT 会话',
    createdAt: isoFrom(c.create_time) || messages[0]?.createdAt,
    updatedAt: isoFrom(c.update_time) || messages.at(-1)?.createdAt,
    source: {
      adapter: 'chatgpt-export',
      name: 'ChatGPT',
      vendor: 'OpenAI',
      sessionId: c.conversation_id,
      officialUrl: 'https://chatgpt.com',
    },
    workspace: undefined,
    model: messages.find((m) => m.model)?.model ? { id: messages.find((m) => m.model).model, provider: 'openai' } : undefined,
    messages,
  });
  if (!conv.title || conv.title === 'ChatGPT 会话') conv.title = deriveTitle(conv);
  return conv;
}

function findLeaf(nodes) {
  for (const [id, n] of Object.entries(nodes)) {
    if (!n?.children?.length) return id;
  }
  return Object.keys(nodes)[0];
}

function partsText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  return (content.parts || [])
    .map((p) => (typeof p === 'string' ? p : p?.text || ''))
    .filter(Boolean)
    .join('\n');
}

function thoughtsText(content) {
  if (!content) return '';
  if (typeof content.content === 'string') return content.content;
  const list = content.thoughts || [];
  return list.map((t) => t.summary || t.content || '').filter(Boolean).join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Claude                                                             */
/* ------------------------------------------------------------------ */

export const claudeExport = defineImporter({
  id: 'claude-export',
  name: 'Claude 官方导出',
  vendor: 'Anthropic',
  description: 'Claude → Settings → Privacy → Export data',
  extensions: ['.zip', '.json'],
  detect(buf, filename) {
    try {
      const data = extractConversations(buf, filename);
      const arr = Array.isArray(data) ? data : [data];
      return arr.some((c) => c && Array.isArray(c.chat_messages));
    } catch {
      return false;
    }
  },
  read(buf, filename) {
    const data = extractConversations(buf, filename);
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter((c) => c && Array.isArray(c.chat_messages)).map(claudeToConversation);
  },
});

function claudeToConversation(c) {
  const messages = [];
  for (const m of c.chat_messages || []) {
    const blocks = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text' && part.text) blocks.push(block.text(part.text));
        else if (part.type === 'thinking' && part.thinking) blocks.push(block.thinking(part.thinking));
        else if (part.type === 'tool_use') blocks.push(block.toolCall(part.name, part.input, part.id));
        else if (part.type === 'tool_result') blocks.push(block.toolResult(part.tool_use_id, String(part.content ?? '')));
      }
    }
    if (!blocks.length && m.text) blocks.push(block.text(m.text));
    for (const a of m.attachments || []) {
      blocks.push(block.text(`［附件：${a.file_name || '文件'}］`));
    }
    for (const f of m.files || []) {
      if (f.file_name) blocks.push(block.text(`［文件：${f.file_name}］`));
    }
    if (!blocks.length) continue;
    messages.push({
      id: m.uuid || uid('m_'),
      role: m.sender === 'assistant' ? 'assistant' : m.sender === 'human' ? 'user' : 'system',
      createdAt: isoFrom(m.created_at),
      blocks,
    });
  }

  const conv = createConversation({
    id: c.uuid || uid('claude_'),
    title: c.name || 'Claude 会话',
    createdAt: isoFrom(c.created_at) || messages[0]?.createdAt,
    updatedAt: isoFrom(c.updated_at) || messages.at(-1)?.createdAt,
    source: {
      adapter: 'claude-export',
      name: 'Claude',
      vendor: 'Anthropic',
      sessionId: c.uuid,
      officialUrl: 'https://claude.ai',
    },
    messages,
  });
  if (!conv.title || conv.title === 'Claude 会话') conv.title = deriveTitle(conv);
  return conv;
}

/* ------------------------------------------------------------------ */
/* 通用 Markdown / 文本                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 通用 JSON / Markdown                                               */
/* ------------------------------------------------------------------ */

const GENERIC_ROLES = new Set(['user', 'assistant', 'system', 'tool', 'human', 'ai', 'bot', 'model']);

function looksLikeGeneric(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const list = Array.isArray(obj) ? obj : obj.messages || obj.conversations || obj.chat || obj.records;
  if (!Array.isArray(list) || !list.length) return false;
  const first = list[0];
  if (!first || typeof first !== 'object') return false;
  const role = first.role || first.sender || first.author?.role || first.from;
  return GENERIC_ROLES.has(String(role || '').toLowerCase());
}

export const genericJson = defineImporter({
  id: 'generic-json',
  name: '通用 JSON 对话',
  vendor: '通用',
  description: '任何 [{role, content}] 形式的对话记录（第三方导出工具、浏览器插件等）',
  extensions: ['.json'],
  detect(buf) {
    try {
      const data = JSON.parse(buf.toString('utf8'));
      return looksLikeGeneric(data);
    } catch {
      return false;
    }
  },
  read(buf, filename) {
    const data = JSON.parse(buf.toString('utf8'));
    const list = Array.isArray(data) ? data : null;
    if (list && list.every((x) => x && typeof x === 'object' && (x.messages || x.chat_messages))) {
      return list.map((c) => genericToConversation(c, filename));
    }
    if (list && looksLikeGeneric(list)) {
      return [
        genericToConversation(
          { title: path.basename(filename || '导入的对话').replace(/\.[^.]+$/, ''), messages: list },
          filename,
        ),
      ];
    }
    const convs = data.conversations || data.chats || [];
    if (Array.isArray(convs) && convs.length) return convs.map((c) => genericToConversation(c, filename));
    return [genericToConversation(data, filename)];
  },
});

function genericToConversation(c, filename) {
  const raw = c.messages || c.chat?.messages || c.records || c.conversation || [];
  const messages = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || typeof m !== 'object') continue;
    const roleRaw = String(m.role || m.sender || m.author?.role || m.from || 'user').toLowerCase();
    const role = GENERIC_ROLES.has(roleRaw) ? (roleRaw === 'human' ? 'user' : ['ai', 'bot', 'model'].includes(roleRaw) ? 'assistant' : roleRaw) : 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) text = m.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
    else if (typeof m.text === 'string') text = m.text;
    if (!text.trim()) continue;
    messages.push({ id: m.id || uid('m_'), role, createdAt: isoFrom(m.createdAt || m.create_time || m.timestamp), blocks: [block.text(text)] });
  }
  const conv = createConversation({
    id: c.id || c.uuid || uid('json_'),
    title: c.title || c.name || path.basename(filename || '导入的对话').replace(/\.[^.]+$/, ''),
    createdAt: isoFrom(c.createdAt || c.create_time),
    updatedAt: isoFrom(c.updatedAt || c.update_time),
    source: { adapter: 'generic-json', name: '通用 JSON', vendor: '通用', sessionId: c.id || c.uuid },
    messages,
  });
  if (!messages.length) conv.title = `${conv.title}（空）`;
  return conv;
}

export const markdownImporter = defineImporter({
  id: 'markdown',
  name: 'Markdown / 纯文本',
  vendor: '通用',
  description: '把一份导出的 Markdown 当成一条会话导入（按 "## 用户/助手" 或 "User:/Assistant:" 切分）',
  extensions: ['.md', '.txt'],
  detect(buf, filename) {
    return /\.(md|txt)$/i.test(filename) && buf.length > 0;
  },
  read(buf, filename) {
    const text = buf.toString('utf8');
    const title = path.basename(filename || 'Markdown 文档').replace(/\.(md|txt)$/i, '');
    const messages = [];
    const lines = text.split(/\r?\n/);
    let current = null;
    const headerRe = /^(?:#{1,3}\s*)?(用户|助手|User|Assistant|Human|AI|系统|System)\s*[:：]?\s*$/i;
    for (const line of lines) {
      const m = headerRe.exec(line.trim());
      if (m) {
        const role = /用户|User|Human/i.test(m[1]) ? 'user' : /系统|System/i.test(m[1]) ? 'system' : 'assistant';
        current = { role, lines: [] };
        messages.push(current);
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (!messages.length) {
      return [
        createConversation({
          id: uid('md_'),
          title,
          source: { adapter: 'markdown', name: 'Markdown', vendor: '通用' },
          messages: [{ role: 'user', blocks: [block.text(text)] }],
        }),
      ];
    }
    return [
      createConversation({
        id: uid('md_'),
        title,
        source: { adapter: 'markdown', name: 'Markdown', vendor: '通用' },
        messages: messages.map((m) => ({
          id: uid('m_'),
          role: m.role,
          blocks: [block.text(m.lines.join('\n').trim())],
        })),
      }),
    ];
  },
});
