/**
 * ChatGPT 官方导出包解析。
 *
 * 来源：ChatGPT → Settings → Data controls → Export data，得到 zip（内含 conversations.json）。
 * 关键结构：`mapping` 是节点图，需要从 current_node 沿 parent 回溯成链；
 * 分支会话默认只取当前分支，其余分支保留为 meta.sidechain 由核心决定丢不丢。
 */
import { defineImporter } from '../../core/adapter.js';
import { block, createConversation, deriveTitle } from '../../core/ucm.js';
import { isoFrom, uid } from '../../core/util.js';
import { asArray, extractConversations } from './_shared.js';

export const chatgptExport = defineImporter({
  id: 'chatgpt-export',
  name: 'ChatGPT 官方导出',
  vendor: 'OpenAI',
  description: '设置 → 数据控制 → 导出数据，解压或直接选择 .zip',
  extensions: ['.zip', '.json'],
  detect(buf, filename) {
    try {
      return asArray(extractConversations(buf, filename)).some((c) => c && (c.mapping || c.conversation_id));
    } catch {
      return false;
    }
  },
  read(buf, filename) {
    return asArray(extractConversations(buf, filename))
      .filter((c) => c && c.mapping)
      .map(chatgptToConversation);
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
      if (text) {
        messages.push({
          id: m.id || uid('m_'),
          role: 'system',
          createdAt: isoFrom(m.create_time),
          blocks: [block.text(text)],
        });
      }
      continue;
    }

    const ct = m.content?.content_type;
    const ts = isoFrom(m.create_time);
    if (
      ct === 'text' ||
      ct === 'multimodal_text' ||
      ct === 'code' ||
      ct === 'execution_output' ||
      ct === 'thoughts' ||
      ct === 'reasoning_recap'
    ) {
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
    model: messages.find((m) => m.model)?.model
      ? { id: messages.find((m) => m.model).model, provider: 'openai' }
      : undefined,
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
  return list
    .map((t) => t.summary || t.content || '')
    .filter(Boolean)
    .join('\n\n');
}
