/**
 * 通用 JSON 对话导入器。
 *
 * 面向"任何 [{role, content}] 形式的对话记录"：第三方导出工具、浏览器插件、自建脚本。
 * 这是兜底通道，detect 必须保守 —— 一旦误命中，会把别的厂商的包按通用格式读成垃圾。
 */
import path from 'node:path';
import { defineImporter } from '../../core/adapter.js';
import { block, createConversation } from '../../core/ucm.js';
import { isoFrom, uid } from '../../core/util.js';

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
      return looksLikeGeneric(JSON.parse(buf.toString('utf8')));
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
    const role = GENERIC_ROLES.has(roleRaw)
      ? roleRaw === 'human'
        ? 'user'
        : ['ai', 'bot', 'model'].includes(roleRaw)
          ? 'assistant'
          : roleRaw
      : 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) text = m.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
    else if (typeof m.text === 'string') text = m.text;
    if (!text.trim()) continue;
    messages.push({
      id: m.id || uid('m_'),
      role,
      createdAt: isoFrom(m.createdAt || m.create_time || m.timestamp),
      blocks: [block.text(text)],
    });
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
