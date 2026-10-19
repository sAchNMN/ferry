/**
 * 写回格式的"真实世界"约束。
 *
 * 为什么需要这一层：我们用**自己的扫描器**验证"导入成功"——写和读都是自己的代码，
 * 这是循环论证。真实应用（`codex` CLI）用的是它自己的解析器，可能根本不认我们写的文件。
 *
 * 这里的期望值不是猜的，是从本机 112 个真实 Codex rollout 文件里统计出来的结构。
 * 断言分两档：
 *   - 当前已满足的结构（会真跑，防止退化）；
 *   - 与真实文件仍有差距的字段（记为 todo，附具体缺项，交 adapter-codex 补齐）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { collectForExport, importConversations } from '../../src/core/migrate.js';
import { freshDir, makeEnv, seedClaude } from '../helpers.js';

/** 造一次 Claude Code → Codex 的写回，返回生成文件的解析结果。 */
async function writeCodexRollout() {
  const homeA = await freshDir('schema-src');
  const homeB = await freshDir('schema-dst');
  await seedClaude(homeA, '/home/u/proj');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);

  const collected = await collectForExport(envA, { agents: ['claude-code'], redact: false });
  assert.ok(collected.conversations.length > 0, '夹具应至少有一个会话');

  const res = await importConversations(envB, collected.conversations, {
    target: 'codex',
    workspace: 'D:\\work\\demo',
    backup: false,
  });
  const written = (res.results[0]?.writes || []).map((w) => w.path).find((p) => /rollout-.*\.jsonl$/.test(p));
  assert.ok(written, `没有生成 rollout 文件，写入记录：${JSON.stringify(res.results[0]?.writes)}`);

  const raw = await fs.readFile(written, 'utf8');
  const records = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { written, records };
}

test('写回 Codex：文件名与首行 session_meta 必须可被识别', async () => {
  const { written, records } = await writeCodexRollout();
  assert.match(path.basename(written), /^rollout-.+\.jsonl$/);
  assert.equal(records[0].type, 'session_meta');
  assert.ok(records[0].payload?.id, 'session_meta 必须带 id，否则会话无法被索引');
  assert.ok(records[0].payload?.cwd, 'session_meta 必须带 cwd');
});

test('写回 Codex：必须包含 turn_context 与消息型 response_item', async () => {
  const { records } = await writeCodexRollout();
  assert.ok(records.some((r) => r.type === 'turn_context'), '缺少 turn_context，Codex 恢复时会话上下文不完整');

  const messages = records.filter((r) => r.type === 'response_item' && r.payload?.type === 'message');
  assert.ok(messages.length >= 2, '至少应写入用户与助手各一条消息');
  for (const m of messages) {
    assert.ok(['user', 'assistant'].includes(m.payload.role), `非法角色：${m.payload.role}`);
    assert.ok(Array.isArray(m.payload.content), 'response_item 的 content 必须是数组');
  }
});

test('写回 Codex：工具调用写成 function_call / function_call_output 成对出现', async () => {
  const { records } = await writeCodexRollout();
  const items = records.filter((r) => r.type === 'response_item').map((r) => r.payload?.type);
  if (!items.includes('function_call')) return; // 夹具里没有工具调用时跳过

  const calls = new Set(
    records.filter((r) => r.type === 'response_item' && r.payload?.type === 'function_call').map((r) => r.payload.call_id),
  );
  const outs = new Set(
    records
      .filter((r) => r.type === 'response_item' && r.payload?.type === 'function_call_output')
      .map((r) => r.payload.call_id),
  );
  for (const id of calls) assert.ok(outs.has(id), `工具调用 ${id} 没有对应的输出，Codex 会认为这轮没结束`);
});

test('写回 Codex：session_meta 字段需与真实 rollout 对齐', async () => {
  const { records } = await writeCodexRollout();
  const meta = records[0].payload;
  for (const key of ['session_id', 'base_instructions', 'context_window', 'runtime_workspace_roots', 'thread_source']) {
    assert.ok(key in meta, `session_meta 缺字段：${key}`);
  }
});

test('写回 Codex：response_item 需带 id 与会话元数据（status/summary 属 reasoning 条目，不在此列）', async () => {
  const { records } = await writeCodexRollout();
  for (const r of records.filter((x) => x.type === 'response_item')) {
    assert.ok(r.payload.id, `${r.payload.type} 缺 id`);
  }
  const msg = records.find((r) => r.type === 'response_item' && r.payload?.type === 'message');
  assert.ok(msg.payload.internal_chat_message_metadata_passthrough, '缺 internal_chat_message_metadata_passthrough');
  // 说明：真实文件的 status / summary / encrypted_content 属于 reasoning 类条目，
  // 我们目前不产出这类条目（thinking 块没写进去）。那是内容缺口，不是字段缺口。
});
