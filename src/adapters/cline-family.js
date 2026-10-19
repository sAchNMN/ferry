/**
 * Cline 系（Cline / Roo Code / Kilo Code）适配器
 *
 * 三者共用 VS Code 扩展的存储布局：
 *   <User>/globalStorage/<extensionId>/tasks/<taskId>/
 *       api_conversation_history.json   Anthropic 风格的消息数组（信息最全）
 *       ui_messages.json                UI 事件流（含 say/ask、工具、命令输出）
 *       task_metadata.json              标题与时间
 *
 * 导入 = 在 tasks/ 下新建一个目录；扩展启动时会扫描该目录生成历史列表。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';
import { ensureDir, exists, existsSync, shortHash, uid } from '../core/util.js';
import { findExistingDir, firstLine, readJsonSafe, writeRecord } from './_shared.js';

const VARIANTS = [
  { id: 'cline', ext: 'saoudrizwan.claude-dev', name: 'Cline', vendor: 'Cline' },
  { id: 'roo', ext: 'rooveterinaryinc.roo-cline', name: 'Roo Code', vendor: 'Roo Code' },
  { id: 'kilo', ext: 'kilocode.kilo-code', name: 'Kilo Code', vendor: 'Kilo Code' },
];

export default defineStore({
  id: 'cline',
  name: 'Cline / Roo Code / Kilo Code',
  vendor: 'Cline 系',
  category: 'ide',
  region: 'global',
  docs: 'https://github.com/cline/cline',
  capabilities: { scan: true, export: true, import: true, resume: true, attachments: false, tools: true },

  async scan(env) {
    const out = [];
    const hosts = [];
    for (const h of ['code', 'codeInsiders', 'cursor', 'windsurf', 'trae', 'vscodium', 'kiro']) {
      const userDir = env.codeUser(h);
      if (await exists(userDir)) hosts.push({ host: h, userDir });
    }
    for (const { host, userDir } of hosts) {
      for (const v of VARIANTS) {
        const root = path.join(userDir, 'globalStorage', v.ext, 'tasks');
        if (!(await exists(root))) continue;
        let dirs = [];
        try {
          dirs = await fsp.readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const dir = path.join(root, d.name);
          const meta = (await readJsonSafe(path.join(dir, 'task_metadata.json'))) || {};
          const st = await fsp.stat(dir).catch(() => null);
          const ui = (await readJsonSafe(path.join(dir, 'ui_messages.json'))) || [];
          const firstUser = firstUserFromUi(ui);
          out.push({
            id: `${v.id}:${d.name}`,
            title: meta.task || firstUser || `${v.name} 任务 ${d.name.slice(0, 8)}`,
            path: dir,
            createdAt: meta.createdAt ? new Date(meta.createdAt).toISOString() : st?.birthtime?.toISOString(),
            updatedAt: st?.mtime?.toISOString(),
            workspace: meta.cwdOnTaskInitialization || meta.workspace || undefined,
            preview: firstUser,
            messages: ui.filter((m) => m.type === 'say' || m.type === 'ask').length,
            meta: { variant: v.id, host, taskId: d.name, root, ext: v.ext },
          });
        }
      }
    }
    return out;
  },

  async read(env, ref) {
    const dir = ref.path;
    const ui = (await readJsonSafe(path.join(dir, 'ui_messages.json'))) || [];
    const api = await readJsonSafe(path.join(dir, 'api_conversation_history.json'));
    const meta = (await readJsonSafe(path.join(dir, 'task_metadata.json'))) || {};
    const variant = VARIANTS.find((v) => v.id === ref.meta?.variant) || VARIANTS[0];

    let messages = [];
    if (Array.isArray(api) && api.length) {
      messages = fromAnthropicHistory(api);
    }
    if (!messages.length && Array.isArray(ui) && ui.length) {
      messages = fromUiMessages(ui);
    }
    const firstUser = messages.find((m) => m.role === 'user');
    const title =
      meta.task ||
      ref.title ||
      (firstUser ? firstLine(firstUser.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' '), 90) : '未命名任务');

    return createConversation({
      id: ref.id,
      title,
      createdAt: messages[0]?.createdAt || ref.createdAt,
      updatedAt: messages.at(-1)?.createdAt || ref.updatedAt,
      source: {
        adapter: 'cline',
        name: variant.name,
        vendor: variant.vendor,
        sessionId: ref.meta?.taskId || ref.id,
        path: dir,
      },
      workspace: { cwd: meta.cwdOnTaskInitialization || meta.workspace || ref.workspace },
      model: meta.modelId ? { id: meta.modelId } : undefined,
      messages,
    });
  },

  async import(env, conv, opts) {
    const variant = pickVariant(env, opts.agent);
    const cwd = opts.workspace || conv.workspace?.cwd || env.cwd;
    const taskId = String(Date.now());
    const dir = path.join(variant.root, taskId);
    const files = {};

    files['task_metadata.json'] = JSON.stringify(
      { task: conv.title, createdAt: new Date(conv.createdAt || Date.now()).getTime(), cwdOnTaskInitialization: cwd },
      null,
      2,
    );
    files['ui_messages.json'] = JSON.stringify(toUiMessages(conv), null, 2);
    files['api_conversation_history.json'] = JSON.stringify(toAnthropicHistory(conv), null, 2);
    files['claude_messages.json'] = files['api_conversation_history.json'];

    const writes = [];
    if (opts.dryRun) {
      for (const [name, content] of Object.entries(files)) {
        writes.push({ path: path.join(dir, name), bytes: Buffer.byteLength(content), kind: 'cline-task', preview: true });
      }
      return { writes, notes: ['模拟模式：未写入'] };
    }
    await ensureDir(dir);
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      await fsp.writeFile(file, content, 'utf8');
      writes.push(writeRecord(file, content, 'cline-task'));
    }
    return {
      writes,
      notes: [`任务目录：${dir}`],
      resume: { cwd, command: `打开 ${variant.name} 的任务历史列表`, sessionId: taskId },
    };
  },

  resumeHint() {
    return '重启 IDE，打开扩展侧边栏的历史任务列表即可继续。';
  },
});

/* ------------------------------------------------------------------ */

function pickVariant(env, hint) {
  const candidates = VARIANTS.filter((v) => {
    if (hint && String(hint).includes(v.id)) return true;
    return true;
  });
  for (const v of candidates) {
    for (const h of ['code', 'cursor', 'windsurf', 'trae']) {
      const root = path.join(env.codeUser(h), 'globalStorage', v.ext, 'tasks');
      if (existsSync(root)) return { ...v, host: h, root };
    }
  }
  const v = VARIANTS[0];
  return { ...v, host: 'code', root: path.join(env.codeUser('code'), 'globalStorage', v.ext, 'tasks') };
}

function firstUserFromUi(ui) {
  for (const m of Array.isArray(ui) ? ui : []) {
    if (m.type === 'say' && (m.say === 'task' || m.say === 'user_feedback') && m.text) return firstLine(m.text, 100);
  }
  return '';
}

function fromAnthropicHistory(api) {
  const out = [];
  for (const m of api) {
    if (!m || typeof m !== 'object') continue;
    const blocks = [];
    const content = m.content;
    if (typeof content === 'string') {
      if (content.trim()) blocks.push(block.text(content));
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text' && c.text) blocks.push(block.text(c.text));
        else if (c.type === 'thinking' && c.thinking) blocks.push(block.thinking(c.thinking));
        else if (c.type === 'tool_use') blocks.push(block.toolCall(c.name, c.input, c.id));
        else if (c.type === 'tool_result') {
          const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : '';
          blocks.push(block.toolResult(c.tool_use_id, text));
        } else if (c.type === 'image') blocks.push(block.text('［图片］'));
      }
    }
    if (!blocks.length) continue;
    const isToolOnly = blocks.every((b) => b.type === 'tool_result');
    out.push({
      id: uid('m_'),
      role: isToolOnly ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user',
      blocks,
    });
  }
  return out;
}

function fromUiMessages(ui) {
  const out = [];
  for (const m of ui) {
    if (!m || typeof m !== 'object') continue;
    const ts = m.ts ? new Date(m.ts).toISOString() : undefined;
    if (m.type === 'say') {
      if (m.say === 'task' || m.say === 'user_feedback') {
        if (m.text) out.push({ id: uid('m_'), role: 'user', createdAt: ts, blocks: [block.text(m.text)] });
      } else if (m.say === 'text' || m.say === 'completion_result' || m.say === 'error' || m.say === 'info') {
        if (m.text) out.push({ id: uid('m_'), role: 'assistant', createdAt: ts, blocks: [block.text(m.text)] });
      } else if (m.say === 'reasoning' && m.text) {
        out.push({ id: uid('m_'), role: 'assistant', createdAt: ts, blocks: [block.thinking(m.text)] });
      } else if (m.say === 'tool' && m.text) {
        let info = {};
        try {
          info = JSON.parse(m.text);
        } catch {
          info = { tool: 'tool', content: m.text };
        }
        out.push({
          id: uid('m_'),
          role: 'assistant',
          createdAt: ts,
          blocks: [block.toolCall(info.tool || 'tool', info, undefined)],
        });
      } else if (m.say === 'command_output' && m.text) {
        out.push({ id: uid('m_'), role: 'tool', createdAt: ts, blocks: [block.toolResult('', m.text)] });
      }
    } else if (m.type === 'ask' && m.text) {
      if (m.ask === 'tool' || m.ask === 'command') {
        out.push({ id: uid('m_'), role: 'assistant', createdAt: ts, blocks: [block.toolCall(m.ask, { text: m.text })] });
      } else {
        out.push({ id: uid('m_'), role: 'assistant', createdAt: ts, blocks: [block.text(m.text)] });
      }
    }
  }
  // 合并相邻的同角色纯文本消息，避免碎片化
  const merged = [];
  for (const m of out) {
    const prev = merged.at(-1);
    const pureText = m.blocks.length === 1 && m.blocks[0].type === 'text';
    const prevPure = prev && prev.blocks.length === 1 && prev.blocks[0].type === 'text' && prev.role === m.role;
    if (prev && prevPure && pureText) prev.blocks[0].text += '\n\n' + m.blocks[0].text;
    else merged.push(m);
  }
  return merged;
}

function toUiMessages(conv) {
  const out = [];
  let first = true;
  for (const m of conv.messages) {
    const ts = m.createdAt ? new Date(m.createdAt).getTime() : Date.now();
    if (m.role === 'user') {
      const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) {
        out.push({ ts, type: 'say', say: first ? 'task' : 'user_feedback', text });
        first = false;
      }
    } else if (m.role === 'assistant') {
      for (const b of m.blocks) {
        if (b.type === 'text') out.push({ ts, type: 'say', say: 'text', text: b.text });
        else if (b.type === 'thinking') out.push({ ts, type: 'say', say: 'reasoning', text: b.text });
        else if (b.type === 'tool_call')
          out.push({ ts, type: 'say', say: 'tool', text: JSON.stringify({ tool: b.name, ...(typeof b.input === 'object' ? b.input : { input: b.input }) }) });
      }
    } else if (m.role === 'tool') {
      for (const b of m.blocks) {
        if (b.type === 'tool_result') out.push({ ts, type: 'say', say: 'command_output', text: b.output || '' });
      }
    }
  }
  return out;
}

function toAnthropicHistory(conv) {
  const out = [];
  for (const m of conv.messages) {
    if (m.role === 'system') continue;
    const content = [];
    for (const b of m.blocks) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.text, signature: '' });
      else if (b.type === 'tool_call') content.push({ type: 'tool_use', id: b.id || uid('toolu_'), name: b.name, input: b.input ?? {} });
      else if (b.type === 'tool_result')
        content.push({ type: 'tool_result', tool_use_id: b.callId || '', content: [{ type: 'text', text: b.output || '' }] });
    }
    if (!content.length) continue;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return out;
}
