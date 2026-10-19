/**
 * Markdown / 纯文本导入器。
 *
 * 按 "## 用户 / 助手" 或 "User: / Assistant:" 切分角色；
 * 切不开就整篇当成一条 user 消息，至少保证内容不丢。
 */
import path from 'node:path';
import { defineImporter } from '../../core/adapter.js';
import { block, createConversation } from '../../core/ucm.js';
import { uid } from '../../core/util.js';

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
