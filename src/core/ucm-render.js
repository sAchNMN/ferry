/**
 * UCM 渲染层：Markdown 与交接包。
 *
 * 纯函数，不写盘、不读 env。谁要落文件谁自己负责。
 * 渲染输出是"给人看的"，不是"给机器读的"——需要无损往返请走 ferrypack。
 */
import { truncate } from './util.js';

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
  const L =
    language === 'en'
      ? {
          title: 'Session handoff pack',
          from: 'Source',
          when: 'Time',
          proj: 'Project',
          model: 'Model',
          intro:
            'Below is the full transcript of a previous AI-agent session. Please read it carefully and continue the work from where it stopped. Do not repeat completed steps; ask first if anything is ambiguous.',
          transcript: 'Transcript',
          todo: 'Continue from the last user request. Keep prior decisions and constraints.',
        }
      : {
          title: '会话交接包',
          from: '来源',
          when: '时间',
          proj: '项目',
          model: '模型',
          intro:
            '以下是我与另一个 AI Agent 的完整历史对话。请通读后**接着最后的进度继续工作**，不要重复已经完成的步骤；如有歧义先问我。',
          transcript: '对话全文',
          todo: '请从最后一条用户请求继续，保持之前已确认的决策与约束。',
        };
  const lines = [`# ${L.title}：${conv.title}`, ''];
  lines.push(`- ${L.from}：${conv.source.name}`);
  lines.push(`- ${L.when}：${localStamp(conv.updatedAt || conv.createdAt)}`);
  if (conv.workspace?.cwd) lines.push(`- ${L.proj}：\`${conv.workspace.cwd}\``);
  if (conv.model?.id) lines.push(`- ${L.model}：${conv.model.id}`);
  lines.push('', '---', '', L.intro, '', `## ${L.transcript}`, '');
  for (const m of msgs) {
    if (m.meta?.internal) continue;
    const who =
      m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : m.role === 'system' ? 'SYSTEM' : 'TOOL';
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
