/**
 * 端到端验收：从"另一台电脑"的视角验证迁移是否真的成功。
 *
 * 与单元测试的区别：
 *   单元测试问"这个函数对不对"；
 *   这里问"用户换完电脑，能不能在目标 Agent 里看见并接着用"。
 * 所以断言只针对用户可见的结果：能扫到、标题对、内容在、工具调用没丢、干跑不写盘。
 *
 * 这个文件不依赖任何具体实现细节，只吃 src/core 的公开 API；
 * 实现怎么改都行，只要行为不变，测试就不该红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { collectForExport, compileMappings, importConversations } from '../../src/core/migrate.js';
import { writePack, readPack } from '../../src/core/archive.js';
import { scanStores, getStore } from '../../src/core/registry.js';
import { redactConversation } from '../../src/core/ucm.js';
import { freshDir, seedCodex } from '../helpers.js';
import { mintMachine, snapshotTree, diffSnapshots, withHoneypotHome, readBytes } from './harness.js';

const USER_TEXT = '帮我修复登录页的报错';
const TITLE = '修复登录页报错';

/** 造一台装了 Codex 会话的机器，导出成归档，返回归档路径与源会话。 */
async function exportFromMachineA() {
  const A = await mintMachine('A');
  await seedCodex(A.home, 'C:\\work\\demo');
  const collected = await collectForExport(A.env, { agents: ['codex'], redact: false });
  assert.equal(collected.conversations.length, 1, '源机器应恰好有 1 个会话');

  const packDir = await freshDir('pack');
  const file = path.join(packDir, 'from-A.ferrypack');
  await writePack(file, {
    conversations: collected.conversations,
    blobs: collected.blobs,
    password: 'pw-123456',
  });
  return { A, file, source: collected.conversations[0] };
}

test('端到端：A 机导出 → B 机导入 → 目标 Agent 能看见并能读回内容', async () => {
  const { file, source } = await exportFromMachineA();
  const B = await mintMachine('B');

  const pack = await readPack(file, { password: 'pw-123456' });
  const res = await importConversations(B.env, pack.conversations, {
    target: 'claude-code',
    workspace: 'C:\\work\\demo',
    backup: false,
    blobs: pack.blobs,
  });
  assert.equal(res.results.filter((r) => !r.error).length, 1, '导入应成功');

  const scan = await scanStores(B.env, { only: ['claude-code'] });
  const sessions = scan.results[0].sessions;
  assert.equal(sessions.length, 1, 'B 机的 Claude Code 应能在历史里看到这 1 个会话');
  assert.ok(sessions[0].title?.includes('登录页'), '标题不应丢失');
  assert.ok(sessions[0].updatedAt, '应有更新时间，否则历史列表排序会错');

  const conv = await getStore('claude-code').read(B.env, sessions[0], { blobs: new Map() });
  const text = JSON.stringify(conv);
  assert.ok(text.includes(USER_TEXT), '首条用户消息内容丢失');
  assert.ok(text.includes('已定位到空指针'), '助手回复内容丢失');
  assert.ok(
    conv.messages.some((m) => m.blocks.some((b) => b.type === 'tool_call' && b.name === 'shell')),
    '工具调用丢失',
  );
  assert.ok(
    conv.messages.some((m) => m.blocks.some((b) => b.type === 'tool_result' && String(b.output).includes('FAIL'))),
    '工具结果丢失',
  );
  assert.ok(conv.messages.length >= source.messages.length - 1, '消息条数明显减少，说明解析丢内容');
});

test('端到端：dry-run 必须零写盘', async () => {
  const { file } = await exportFromMachineA();
  const B = await mintMachine('B');
  const pack = await readPack(file, { password: 'pw-123456' });

  const before = await snapshotTree(B.home);
  const res = await importConversations(B.env, pack.conversations, {
    target: 'claude-code',
    workspace: 'C:\\work\\demo',
    backup: false,
    dryRun: true,
    blobs: pack.blobs,
  });
  const after = await snapshotTree(B.home);

  assert.equal(res.results.filter((r) => !r.error).length, 1, '干跑也要产出计划');
  const d = diffSnapshots(before, after);
  assert.deepEqual(
    [...d.added, ...d.removed, ...d.changed],
    [],
    `dry-run 动了文件：新增 ${d.added.join(',')} 删除 ${d.removed.join(',')} 改动 ${d.changed.join(',')}`,
  );
});

test('端到端：跨平台路径映射把源工作区改写到目标机器', async () => {
  const { file } = await exportFromMachineA();
  const B = await mintMachine('B');
  const pack = await readPack(file, { password: 'pw-123456' });

  await importConversations(B.env, pack.conversations, {
    target: 'claude-code',
    backup: false,
    blobs: pack.blobs,
    map: compileMappings(['C:\\work\\demo=/home/u/work-demo']),
  });

  const [ref] = await getStore('claude-code').scan(B.env);
  const conv = await getStore('claude-code').read(B.env, ref, { blobs: new Map() });
  assert.equal(conv.workspace?.cwd, '/home/u/work-demo', '工作区路径没有被映射到目标机器');
});

test('端到端：归档被篡改必须显式失败，不能静默导入', async () => {
  const { file } = await exportFromMachineA();
  const raw = await readBytes(file);
  const tampered = Buffer.from(raw);
  tampered[Math.floor(tampered.length * 0.6)] ^= 0xff;
  const badFile = path.join(await freshDir('tampered'), 'bad.ferrypack');
  await fsp.writeFile(badFile, tampered);

  await assert.rejects(
    () => readPack(badFile, { password: 'pw-123456' }),
    '篡改过的归档必须报错；静默通过等于把损坏数据写进用户电脑',
  );
});

test('端到端：全流程不得触碰真实 HOME', async () => {
  const honeypot = await withHoneypotHome();
  try {
    const { file } = await exportFromMachineA();
    const B = await mintMachine('B');
    const pack = await readPack(file, { password: 'pw-123456' });
    await importConversations(B.env, pack.conversations, {
      target: 'claude-code',
      workspace: 'C:\\work\\demo',
      backup: false,
      blobs: pack.blobs,
    });

    const leaked = await honeypot.assertClean();
    assert.deepEqual(leaked, [], `有代码绕过了 env 直接读写 HOME，蜜罐目录出现：${leaked.join(', ')}`);
  } finally {
    honeypot.restore();
  }
});

test('端到端：导出脱敏后，归档里不得残留明文密钥', async () => {
  const A = await mintMachine('A');
  await seedCodex(A.home, 'C:\\work\\demo');
  const collected = await collectForExport(A.env, { agents: ['codex'], redact: false });

  const secret = 'sk-abcdefghijklmnopqrstuvwx';
  const conv = collected.conversations[0];
  conv.messages[0].blocks.push({ type: 'text', text: `这是我的 key：${secret}，别泄露` });
  const { conversation, hits } = redactConversation(conv);
  assert.ok(Object.keys(hits).length > 0, '脱敏应当命中至少一处');

  const file = path.join(await freshDir('redact-pack'), 'r.ferrypack');
  await writePack(file, { conversations: [conversation], blobs: collected.blobs, password: 'pw-123456' });

  const back = await readPack(file, { password: 'pw-123456' });
  const dumped = JSON.stringify(back.conversations);
  assert.ok(!dumped.includes(secret), '归档里仍能找到明文密钥');
  assert.ok(dumped.includes('REDACTED'), '脱敏应留下可追溯的占位标记');
  assert.ok(conversation.meta, '脱敏信息应记录在会话 meta 里');
});

test('端到端：同一归档重复导入必须幂等', { todo: '待 feat/migration-engine 实现：当前 import 每次生成新 sessionId，会重复' }, async () => {
  const { file } = await exportFromMachineA();
  const B = await mintMachine('B');
  const pack = await readPack(file, { password: 'pw-123456' });
  const opts = { target: 'claude-code', workspace: 'C:\\work\\demo', backup: false, blobs: pack.blobs };

  await importConversations(B.env, pack.conversations, opts);
  await importConversations(B.env, pack.conversations, opts);

  const scan = await getStore('claude-code').scan(B.env);
  assert.equal(scan.length, 1, '同一会话导入两次不应产生副本');
});

test('端到端：源端已有的会话标题必须保留，不能被截断的首条消息覆盖',
  { todo: '待 adapter 分支修复：codex 的 scan 已拿到 session_index 的 thread_name，但 read 用 deriveTitle 覆盖掉了' },
  async () => {
    const { A, source } = await exportFromMachineA();
    assert.ok(A.home);
    assert.equal(source.title, TITLE, '导出时应沿用源端标题，而不是首条用户消息的截断');
  });
