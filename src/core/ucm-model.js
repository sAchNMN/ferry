/**
 * UCM 模型层：结构定义、构造、校验、统计。
 *
 * 这里只放"数据长什么样"，不放渲染、脱敏、指纹 —— 那些在 ucm-render / ucm-redact / ucm-identity。
 * 分层原因：模型是契约（改动需 RFC），其余三者是视图与派生，变动频率高得多。
 *
 * 版本：ferry.conversation/1
 */
import { isoFrom, nowIso, uid } from './util.js';

export const UCM_SCHEMA = 'ferry.conversation/1';
export const ROLES = ['system', 'user', 'assistant', 'tool'];

/* ------------------------------------------------------------------ */
/* 内容块构造器                                                        */
/* ------------------------------------------------------------------ */

export const block = {
  text: (text) => ({ type: 'text', text: String(text ?? '') }),
  thinking: (text, meta) => ({ type: 'thinking', text: String(text ?? ''), ...(meta ? { meta } : {}) }),
  toolCall: (name, input, id) => ({
    type: 'tool_call',
    id: id || uid('call_'),
    name: name || 'unknown',
    input: input === undefined ? {} : input,
  }),
  toolResult: (callId, output, { name, isError = false } = {}) => ({
    type: 'tool_result',
    callId: callId || '',
    name: name || undefined,
    output: typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output, null, 2),
    isError: Boolean(isError),
  }),
  image: (blob, mime, name) => ({ type: 'image', blob, mime: mime || 'application/octet-stream', name }),
  file: (blob, mime, name) => ({ type: 'file', blob, mime: mime || 'application/octet-stream', name }),
  citation: (url, title) => ({ type: 'citation', url, title }),
  unknown: (raw, kind) => ({ type: 'unknown', kind: kind || 'raw', raw }),
};

export const msg = {
  user: (content, meta) => makeMessage('user', content, meta),
  assistant: (content, meta) => makeMessage('assistant', content, meta),
  system: (content, meta) => makeMessage('system', content, meta),
  tool: (content, meta) => makeMessage('tool', content, meta),
};

function makeMessage(role, content, meta) {
  const blocks = Array.isArray(content) ? content.filter(Boolean) : [block.text(content ?? '')];
  return {
    id: uid('m_'),
    role,
    createdAt: undefined,
    blocks: blocks.filter((b) => b && (b.type !== 'text' || b.text !== '')),
    ...(meta ? { meta } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 会话构造                                                            */
/* ------------------------------------------------------------------ */

export function createConversation(input = {}) {
  const now = nowIso();
  const messages = (input.messages || []).map((m) => normalizeMessage(m));
  const conv = {
    schema: UCM_SCHEMA,
    id: input.id || uid('c_'),
    title: (input.title || '未命名会话').trim() || '未命名会话',
    createdAt: isoFrom(input.createdAt) || messages[0]?.createdAt || now,
    updatedAt: isoFrom(input.updatedAt) || messages.at(-1)?.createdAt || now,
    source: {
      adapter: input.source?.adapter || 'unknown',
      name: input.source?.name || input.source?.adapter || '未知来源',
      vendor: input.source?.vendor,
      version: input.source?.version,
      sessionId: input.source?.sessionId,
      path: input.source?.path,
      officialUrl: input.source?.officialUrl,
    },
    workspace: normalizeWorkspace(input.workspace),
    model: input.model || undefined,
    tags: Array.isArray(input.tags) ? input.tags : [],
    messages,
    meta: input.meta || {},
    extra: input.extra || undefined,
  };
  conv.stats = conversationStats(conv);
  return conv;
}

function normalizeWorkspace(ws) {
  if (!ws) return undefined;
  const out = {};
  if (ws.cwd) out.cwd = String(ws.cwd);
  if (Array.isArray(ws.roots) && ws.roots.length) out.roots = ws.roots.map(String);
  if (ws.git && (ws.git.branch || ws.git.remote || ws.git.sha)) {
    out.git = {
      branch: ws.git.branch || undefined,
      remote: ws.git.remote || undefined,
      sha: ws.git.sha || undefined,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeMessage(m) {
  if (!m) return makeMessage('user', '');
  if (typeof m === 'string') return makeMessage('user', m);
  const role = ROLES.includes(m.role) ? m.role : 'user';
  let blocks = m.blocks;
  if (!Array.isArray(blocks)) {
    blocks = m.content ? (Array.isArray(m.content) ? m.content : [block.text(m.content)]) : [];
  }
  return {
    id: m.id || uid('m_'),
    role,
    createdAt: isoFrom(m.createdAt),
    blocks: blocks.filter(Boolean),
    ...(m.model ? { model: m.model } : {}),
    ...(m.meta ? { meta: m.meta } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 校验 / 修复                                                         */
/* ------------------------------------------------------------------ */

/**
 * 兼容旧版本或第三方的 UCM：补齐字段、丢弃坏块。
 * @returns {{conversation: object, issues: string[]}}
 */
export function validateConversation(raw) {
  const issues = [];
  if (!raw || typeof raw !== 'object') {
    throw new Error('会话数据不是对象');
  }
  if (raw.schema && raw.schema !== UCM_SCHEMA) {
    issues.push(`schema 为 ${raw.schema}，按 ${UCM_SCHEMA} 读取`);
  }
  if (!Array.isArray(raw.messages)) {
    issues.push('缺少 messages 数组，已置空');
    raw.messages = [];
  }
  const conv = createConversation({
    ...raw,
    messages: raw.messages
      .map((m) => {
        if (!m || typeof m !== 'object') return null;
        const blocks = (m.blocks || []).filter((b) => b && typeof b.type === 'string');
        if (!blocks.length && m.content) return normalizeMessage(m);
        return { ...m, blocks };
      })
      .filter(Boolean),
  });
  conv.stats = conversationStats(conv);
  return { conversation: conv, issues };
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export function conversationStats(conv) {
  const stats = {
    messages: conv.messages.length,
    user: 0,
    assistant: 0,
    system: 0,
    tool: 0,
    toolCalls: 0,
    chars: 0,
    images: 0,
  };
  for (const m of conv.messages) {
    stats[m.role] = (stats[m.role] || 0) + 1;
    for (const b of m.blocks) {
      if (b.type === 'text' || b.type === 'thinking') stats.chars += (b.text || '').length;
      else if (b.type === 'tool_call') stats.toolCalls++;
      else if (b.type === 'image') stats.images++;
    }
  }
  return stats;
}
