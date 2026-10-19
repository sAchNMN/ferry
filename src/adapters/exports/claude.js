/**
 * Claude 官方导出包解析（网页版）。
 *
 * 来源：Claude → Settings → Privacy → Export data。
 * 注意：这是 Claude 网页版，与 Claude Code 的本地 jsonl 存储是两条完全不同的链路，
 * 不要把本文件的逻辑和 `src/adapters/claude-code.js` 混在一起。
 */
import { defineImporter } from '../../core/adapter.js';
import { block, createConversation, deriveTitle } from '../../core/ucm.js';
import { isoFrom, uid } from '../../core/util.js';
import { asArray, extractConversations } from './_shared.js';

export const claudeExport = defineImporter({
  id: 'claude-export',
  name: 'Claude 官方导出',
  vendor: 'Anthropic',
  description: 'Claude → Settings → Privacy → Export data',
  extensions: ['.zip', '.json'],
  detect(buf, filename) {
    try {
      return asArray(extractConversations(buf, filename)).some((c) => c && Array.isArray(c.chat_messages));
    } catch {
      return false;
    }
  },
  read(buf, filename) {
    return asArray(extractConversations(buf, filename))
      .filter((c) => c && Array.isArray(c.chat_messages))
      .map(claudeToConversation);
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
