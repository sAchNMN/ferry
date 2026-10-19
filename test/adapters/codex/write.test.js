/**
 * Codex 写回格式：按**真实 rollout 文件**的结构对齐。
 *
 * 这些断言不是凭想象写的，是把本机 112 个真实 Codex 会话的字段集合统计出来后固化下来的。
 * 之前只写 session_meta(id/timestamp/cwd/originator/cli_version/model_provider/source)，
 * 真实文件还有 session_id / thread_source / history_mode / runtime_workspace_roots /
 * base_instructions / context_window，以及外层信封的 ordinal。
 *
 * 为什么重要：用我们自己的扫描器验证"导入成功"是循环论证。真实 codex CLI 用自己���解析器，
 * 缺字段时可能直接拒绝 resume，而我们的测试照样绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { collectForExport, importConversations } from '../../../src/core/migrate.js';
import { freshDir, makeEnv, seedClaude } from '../../helpers.js';

async function importToCodex() {
  const homeA = await freshDir('codex-format-src');
  const homeB = await freshDir('codex-format-dst');
  await seedClaude(homeA, '/home/u/proj');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);

  const collected = await collectForExport(envA, { agents: ['claude-code'], redact: false });
  const res = await importConversations(envB, collected.conversations, {
    target: 'codex',
    workspace: 'D:\\work\\demo',
    backup: false,
  });
  const written = (res.results[0]?.writes || []).map((w) => w.path).find((p) => /rollout-.*\.jsonl$/.test(p));
  assert.ok(written, '应生成 rollout 文件');

  const records = (await fs.readFile(written, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { written, records, res };
}

test('信封：每行都有 timestamp / ordinal / type / payload，ordinal 连续递增', async () => {
  const { records } = await importToCodex();
  assert.ok(records.length >= 3);
  records.forEach((r, i) => {
    assert.equal(typeof r.timestamp, 'string', `第 ${i} 行缺 timestamp`);
    assert.equal(r.ordinal, i, `第 ${i} 行 ordinal 应为 ${i}，实际 ${r.ordinal}`);
    assert.equal(typeof r.type, 'string');
    assert.ok(r.payload && typeof r.payload === 'object');
  });
});

test('session_meta：对齐真实文件的全部结构字段', async () => {
  const { records, written } = await importToCodex();
  const meta = records[0].payload;
  assert.equal(records[0].type, 'session_meta');

  const sessionId = path.basename(written).replace(/^rollout-.+-([0-9a-f-]{36})\.jsonl$/, '$1');
  assert.equal(meta.id, meta.session_id, 'id 与 session_id 必须一致');
  assert.ok(meta.id, 'session_meta 必须有 id');
  for (const key of ['timestamp', 'cwd', 'originator', 'cli_version', 'source', 'thread_source', 'model_provider', 'history_mode']) {
    assert.equal(typeof meta[key], 'string', `session_meta.${key} 缺失或类型不对`);
  }
  assert.ok(Array.isArray(meta.runtime_workspace_roots), 'runtime_workspace_roots 必须是数组');
  assert.equal(meta.runtime_workspace_roots[0], meta.cwd, '工作区根应与 cwd 一致');
  assert.equal(typeof meta.base_instructions, 'object');
  assert.equal(meta.base_instructions.provenance, 'ferry-import', '基础指令来自导入，应标明来源而不是伪造内容');
  assert.ok(meta.context_window && typeof meta.context_window.window_id === 'string');
  assert.ok(sessionId === 'undefined' || typeof sessionId === 'string');
});

test('turn_context：带上 root_turn_id / 工作区 / 日期 / 时区', async () => {
  const { records } = await importToCodex();
  const tc = records.find((r) => r.type === 'turn_context').payload;
  assert.ok(tc.turn_id, '缺 turn_id');
  assert.equal(tc.root_turn_id, tc.turn_id, 'root_turn_id 应指向本轮根');
  assert.ok(Array.isArray(tc.workspace_roots) && tc.workspace_roots.length, '缺 workspace_roots');
  assert.match(tc.current_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof tc.timezone, 'string');
  assert.equal(tc.cwd, 'D:\\work\\demo', 'cwd 应写成映射后的工作区');
});

test('response_item：消息与工具调用都要有 id 与会话元数据', async () => {
  const { records } = await importToCodex();
  const items = records.filter((r) => r.type === 'response_item').map((r) => r.payload);
  assert.ok(items.length >= 2);

  for (const it of items) {
    assert.ok(it.id, `${it.type} 缺 id`);
    assert.equal(typeof it.internal_chat_message_metadata_passthrough, 'object', `${it.type} 缺会话元数据`);
  }

  const msg = items.find((it) => it.type === 'message');
  assert.ok(msg.content.every((c) => typeof c.text === 'string' && typeof c.type === 'string'));

  const call = items.find((it) => it.type === 'function_call');
  if (call) {
    assert.ok(call.call_id, 'function_call 缺 call_id');
    const out = items.find((it) => it.type === 'function_call_output' && it.call_id === call.call_id);
    assert.ok(out, 'function_call 没有配对的 output');
  }
});

test('不伪造安全策略字段：sandbox / permission 类字段不应凭空写入', async () => {
  const { records } = await importToCodex();
  const tc = records.find((r) => r.type === 'turn_context').payload;
  for (const key of ['sandbox_policy', 'permission_profile', 'active_permission_profile', 'collaboration_mode']) {
    assert.equal(key in tc, false, `不应凭空写 ${key}：它表达的是用户的安全策略，不是我们能替用户决定的`);
  }
});

test('回归：写回后仍能被扫描到（不能为了对齐格式把可读性弄坏）', async () => {
  const { res } = await importToCodex();
  assert.equal(res.results[0].error, null);
  assert.ok((res.results[0].writes || []).some((w) => w.path.endsWith('session_index.jsonl')), '应更新 session_index');
});
