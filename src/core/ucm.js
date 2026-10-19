/**
 * UCM —— Universal Conversation Model（通用会话模型）
 *
 * 所有 Agent 的会话先被归一化成这个结构，再打包 / 转换 / 渲染。
 * 目标是"信息不丢"：文本、思考、工具调用、工具结果、图片附件、工作区信息都保留。
 *
 * 版本：ferry.conversation/1
 */
import { isoFrom, nowIso, sha256, shortHash, truncate, uid, stableStringify } from './util.js';

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
  const blocks = Array.isArray(content)
    ? content.filter(Boolean)
    : [block.text(content ?? '')];
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
/* 统计 / 文本                                                         */
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

export function blockToText(b) {
  switch (b?.type) {
    case 'text':
    case 'thinking':
      return b.text || '';
    case 'tool_call':
      return `[调用 ${b.name}] ${typeof b.input === 'string' ? b.input : JSON.stringify(b.input)}`;
    case 'tool_result':
      return `[结果] ${b.output || ''}`;
    case 'image':
      return `[图片 ${b.name || b.blob || ''}]`;
    case 'file':
      return `[文件 ${b.name || b.blob || ''}]`;
    case 'citation':
      return `[引用 ${b.title || ''} ${b.url || ''}]`;
    default:
      return '';
  }
}

export function messageText(m, { includeThinking = false } = {}) {
  return m.blocks
    .filter((b) => includeThinking || b.type !== 'thinking')
    .map(blockToText)
    .join('\n')
    .trim();
}

export function conversationText(conv, opts) {
  return conv.messages.map((m) => `${m.role}: ${messageText(m, opts)}`).join('\n\n');
}

/** 取第一段用户文本作为标题候选。 */
export function deriveTitle(conv, max = 40) {
  const first = conv.messages.find((m) => m.role === 'user' && messageText(m).trim());
  if (!first) return conv.title;
  return truncate(messageText(first).replace(/^#+\s*/, ''), max);
}

/** 粗略 token 估算（中英混排都按 ~2.2 字符/token）。 */
export function estimateTokens(conv) {
  return Math.ceil((conv.stats?.chars || conversationStats(conv).chars) / 2.2);
}

/* ------------------------------------------------------------------ */
/* 脱敏                                                                */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'openai', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer', re: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi },
  { kind: 'assignment', re: /\b((?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|token)\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi },
  { kind: 'url-credential', re: /\b([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+:)([^@/\s]{6,})(@)/gi },
];

/**
 * 在文本中打码常见密钥。刻意保守：只替换高置信度模式，避免破坏正常内容。
 */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', hits: [] };
  let out = text;
  const hits = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      const groups = args.slice(0, -2);
      hits.push(kind);
      if (kind === 'bearer' || kind === 'assignment') {
        return `${groups[1]}[REDACTED:${kind}]`;
      }
      if (kind === 'url-credential') {
        return `${groups[1]}[REDACTED:${kind}]${groups[3]}`;
      }
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, hits };
}

/** 会返回脱敏副本与命中统计，不修改原对象。 */
export function redactConversation(conv) {
  const hits = {};
  const clone = structuredClone(conv);
  const scrub = (text) => {
    const r = redactText(text);
    for (const h of r.hits) hits[h] = (hits[h] || 0) + 1;
    return r.text;
  };
  for (const m of clone.messages) {
    for (const b of m.blocks) {
      if (b.type === 'text' || b.type === 'thinking') b.text = scrub(b.text);
      else if (b.type === 'tool_result') b.output = scrub(b.output);
      else if (b.type === 'tool_call' && typeof b.input === 'string') b.input = scrub(b.input);
      else if (b.type === 'tool_call' && b.input && typeof b.input === 'object') {
        b.input = JSON.parse(scrub(JSON.stringify(b.input)));
      }
    }
  }
  return { conversation: clone, hits };
}

/* ------------------------------------------------------------------ */
/* Markdown 渲染                                                       */
/* ------------------------------------------------------------------ */

export function renderMarkdown(conv, opts = {}) {
  const {
    includeThinking = true,
    includeTools = true,
    maxToolOutput = 2000,
    frontmatter = true,
    title = conv.title,
  } = opts;
  const lines = [];
  if (frontmatter) {
    lines.push('---');
    lines.push(`title: ${JSON.stringify(title)}`);
    lines.push(`source: ${conv.source.name}`);
    if (conv.source.adapter) lines.push(`adapter: ${conv.source.adapter}`);
    if (conv.createdAt) lines.push(`created: ${conv.createdAt}`);
    if (conv.updatedAt) lines.push(`updated: ${conv.updatedAt}`);
    if (conv.workspace?.cwd) lines.push(`workspace: ${JSON.stringify(conv.workspace.cwd)}`);
    if (conv.model?.id) lines.push(`model: ${JSON.stringify(conv.model.id)}`);
    lines.push(`messages: ${conv.stats.messages}`);
    lines.push('---', '');
  }
  lines.push(`# ${title}`, '');
  for (const m of conv.messages) {
    if (m.meta?.internal) continue;
    const visible = m.blocks.some(
      (b) =>
        (b.type === 'text' && b.text?.trim()) ||
        (b.type === 'thinking' && includeThinking) ||
        (b.type === 'tool_call' && includeTools) ||
        (b.type === 'tool_result' && includeTools) ||
        b.type === 'image' ||
        b.type === 'file' ||
        b.type === 'citation',
    );
    if (!visible) continue;
    const who =
      m.role === 'user' ? '🧑 用户' : m.role === 'assistant' ? '🤖 助手' : m.role === 'system' ? '⚙️ 系统' : '🛠 工具';
    const time = m.createdAt ? ` · ${localStamp(m.createdAt)}` : '';
    lines.push(`## ${who}${time}`, '');
    for (const b of m.blocks) {
      if (b.type === 'text') {
        lines.push(b.text.trim(), '');
      } else if (b.type === 'thinking') {
        if (!includeThinking) continue;
        lines.push('<details><summary>思考</summary>', '', b.text.trim(), '', '</details>', '');
      } else if (b.type === 'tool_call') {
        if (!includeTools) continue;
        lines.push('```' + toolLang(b.name), `# 调用：${b.name}`, formatToolInput(b.input), '```', '');
      } else if (b.type === 'tool_result') {
        if (!includeTools) continue;
        const out = truncateMiddle(b.output || '', maxToolOutput);
        lines.push('```text', out, '```', '');
      } else if (b.type === 'image') {
        lines.push(`![${b.name || 'image'}](blobs/${b.blob})`, '');
      } else if (b.type === 'file') {
        lines.push(`📎 [${b.name || 'file'}](blobs/${b.blob})`, '');
      } else if (b.type === 'citation') {
        lines.push(`- [${b.title || b.url}](${b.url})`);
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function toolLang(name) {
  const n = String(name || '').toLowerCase();
  if (/shell|bash|terminal|exec|command|powershell/.test(n)) return 'bash';
  if (/python/.test(n)) return 'python';
  if (/edit|write|patch|diff/.test(n)) return 'diff';
  return 'json';
}

/** ISO 时间 → 本地时间字符串（YYYY-MM-DD HH:mm）。 */
export function localStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function truncateMiddle(text, max) {
  if (!max || text.length <= max) return text;
  const half = Math.floor((max - 20) / 2);
  return `${text.slice(0, half)}\n\n…（已截断 ${text.length - max} 字符）…\n\n${text.slice(-half)}`;
}

/* ------------------------------------------------------------------ */
/* 交接包（给云端 / 任意模型续聊用）                                   */
/* ------------------------------------------------------------------ */

export function renderHandoff(conv, opts = {}) {
  const {
    maxMessages = 0,
    includeThinking = false,
    includeTools = true,
    maxToolOutput = 800,
    language = 'zh',
  } = opts;
  const msgs = maxMessages > 0 ? conv.messages.slice(-maxMessages) : conv.messages;
  const L = language === 'en'
    ? {
        title: 'Session handoff pack',
        from: 'Source', when: 'Time', proj: 'Project', model: 'Model',
        intro: 'Below is the full transcript of a previous AI-agent session. Please read it carefully and continue the work from where it stopped. Do not repeat completed steps; ask first if anything is ambiguous.',
        transcript: 'Transcript', todo: 'Continue from the last user request. Keep prior decisions and constraints.',
      }
    : {
        title: '会话交接包',
        from: '来源', when: '时间', proj: '项目', model: '模型',
        intro: '以下是我与另一个 AI Agent 的完整历史对话。请通读后**接着最后的进度继续工作**，不要重复已经完成的步骤；如有歧义先问我。',
        transcript: '对话全文', todo: '请从最后一条用户请求继续，保持之前已确认的决策与约束。',
      };
  const lines = [`# ${L.title}：${conv.title}`, ''];
  lines.push(`- ${L.from}：${conv.source.name}`);
  lines.push(`- ${L.when}：${localStamp(conv.updatedAt || conv.createdAt)}`);
  if (conv.workspace?.cwd) lines.push(`- ${L.proj}：\`${conv.workspace.cwd}\``);
  if (conv.model?.id) lines.push(`- ${L.model}：${conv.model.id}`);
  lines.push('', '---', '', L.intro, '', `## ${L.transcript}`, '');
  for (const m of msgs) {
    if (m.meta?.internal) continue;
    const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : m.role === 'system' ? 'SYSTEM' : 'TOOL';
    const parts = [];
    for (const b of m.blocks) {
      if (b.type === 'text') parts.push(b.text.trim());
      else if (b.type === 'thinking' && includeThinking) parts.push(`<thinking>\n${b.text.trim()}\n</thinking>`);
      else if (b.type === 'tool_call' && includeTools)
        parts.push(`[tool:${b.name}] ${truncate(JSON.stringify(b.input ?? {}), 600)}`);
      else if (b.type === 'tool_result' && includeTools)
        parts.push(`[tool result] ${truncate(b.output || '', maxToolOutput)}`);
      else if (b.type === 'image') parts.push(`[image: ${b.name || b.blob}]`);
    }
    const visible = parts.filter(Boolean);
    if (!visible.length) continue;
    lines.push(`### ${who}`, ...visible, '');
  }
  lines.push('---', '', `**${L.todo}**`, '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 指纹 / 去重                                                         */
/* ------------------------------------------------------------------ */

/** 会话指纹：优先用源 sessionId，否则用内容哈希。用于跨机去重。 */
export function conversationFingerprint(conv) {
  if (conv.source?.sessionId) {
    return shortHash(`${conv.source.adapter}:${conv.source.sessionId}`, 24);
  }
  const pieces = conv.messages.slice(0, 3).map((m) => messageText(m));
  return shortHash(stableStringify({ t: conv.title, p: pieces, n: conv.messages.length }), 24);
}

export function contentHash(conv) {
  return sha256(stableStringify(conv));
}
