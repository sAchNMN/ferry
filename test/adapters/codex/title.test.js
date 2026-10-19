/**
 * Codex 会话标题的取词规则。
 *
 * 真实数据里 Codex 会把**机器注入**的内容写成 user 消息（AGENTS.md 指令、environment_context、
 * 审批子系统的 "The following is the Codex agent history…"），而 `session_index.jsonl` 的
 * `thread_name` 也可能直接就是这些提示词原文。
 *
 * 结果：用户的历史列表里出现一大段系统提示当标题。实测本机 112 个会话里 47 个中招。
 * 这些用例把"什么算用户真说的话"钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getStore } from '../../../src/core/registry.js';
import { freshDir, makeEnv } from '../../helpers.js';

const ID_A = '019f0000-0000-7000-8000-00000000aaaa';
const ID_B = '019f0000-0000-7000-8000-00000000bbbb';
const ID_C = '019f0000-0000-7000-8000-00000000cccc';

function rollout(id, userTexts) {
  const lines = [
    {
      timestamp: '2026-10-19T02:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id, session_id: id, timestamp: '2026-10-19T02:00:00.000Z', cwd: 'C:\\work\\demo' },
    },
    ...userTexts.map((text, i) => ({
      timestamp: `2026-10-19T02:00:0${i + 1}.000Z`,
      ordinal: i + 1,
      type: 'response_item',
      payload: { type: 'message', id: `m${i}`, role: 'user', content: [{ type: 'input_text', text }] },
    })),
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function seed(home, spec) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '19');
  await fsp.mkdir(dir, { recursive: true });
  for (const [id, s] of Object.entries(spec)) {
    await fsp.writeFile(path.join(dir, `rollout-2026-10-19T02-00-00-${id}.jsonl`), rollout(id, s.userTexts), 'utf8');
  }
  const indexLines = Object.entries(spec)
    .filter(([, s]) => s.threadName)
    .map(([id, s]) => JSON.stringify({ id, thread_name: s.threadName, updated_at: '2026-10-19T02:00:09.000Z' }));
  if (indexLines.length) {
    await fsp.writeFile(path.join(home, '.codex', 'session_index.jsonl'), indexLines.join('\n') + '\n', 'utf8');
  }
}

const INJECT_AGENTS = '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n你是我的严苛导师……\n</INSTRUCTIONS>';
const INJECT_ENV = '<environment_context>\n  <cwd>C:\\work\\demo</cwd>\n</environment_context>';
const INJECT_APPROVAL = 'The following is the Codex agent history whose request action you are assessing.';

test('标题：跳过注入消息，取第一句用户真说的话', async () => {
  const home = await freshDir('codex-title-a');
  await seed(home, {
    [ID_A]: { userTexts: [INJECT_AGENTS, INJECT_APPROVAL, '帮我修复登录页的报错'] },
  });
  const [ref] = await getStore('codex').scan(makeEnv(home));
  assert.equal(ref.title, '帮我修复登录页的报错');
  assert.equal(ref.meta.internalSession, undefined);
});

test('标题：索引里的 thread_name 若是注入文本，也要忽略并回退到真实消息', async () => {
  const home = await freshDir('codex-title-b');
  await seed(home, {
    [ID_B]: { userTexts: [INJECT_ENV, '把部署脚本改成幂等的'], threadName: INJECT_APPROVAL },
  });
  const [ref] = await getStore('codex').scan(makeEnv(home));
  assert.equal(ref.title, '把部署脚本改成幂等的');
});

test('标题：索引里有正常 thread_name 时优先用它（用户改过的名字不能被覆盖）', async () => {
  const home = await freshDir('codex-title-c');
  await seed(home, {
    [ID_C]: { userTexts: ['随便说一句'], threadName: '我自己起的名字' },
  });
  const [ref] = await getStore('codex').scan(makeEnv(home));
  assert.equal(ref.title, '我自己起的名字', '用户手动改过的会话名优先级最高');
});

test('标题：完全没有真实用户消息 → 标记为内部会话，不拿提示词当标题', async () => {
  const home = await freshDir('codex-title-d');
  await seed(home, {
    [ID_A]: { userTexts: [INJECT_AGENTS, INJECT_ENV] },
  });
  const [ref] = await getStore('codex').scan(makeEnv(home));
  assert.match(ref.title, /^Codex 内部会话 [0-9a-f]{8}$/, `标题应显式说明是内部会话，实际：${ref.title}`);
  assert.equal(ref.meta.internalSession, true, '应打上内部会话标记，便于上层过滤');
  assert.ok(!String(ref.title).includes('AGENTS'), '绝不能把提示词原文当标题');
});

test('标题：XML 风格标签开头的注入内容通用识别（不靠穷举已知标签）', async () => {
  const home = await freshDir('codex-title-e');
  await seed(home, {
    [ID_B]: { userTexts: ['<some_future_injection>随便什么</some_future_injection>', '真正的问题'] },
  });
  const [ref] = await getStore('codex').scan(makeEnv(home));
  assert.equal(ref.title, '真正的问题');
});
