/**
 * UCM 文本层：把结构化会话降维成纯文本。
 *
 * 这是所有"转格式"路径的共同底座（Markdown、交接包、指纹、摘要都从这里取文本）。
 * 只依赖模型层，不依赖渲染层 —— 保持单向。
 */
import { truncate } from './util.js';
import { conversationStats } from './ucm-model.js';

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
