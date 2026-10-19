/**
 * 验收：`ferry rollback` 能不能真的把目标还原。
 *
 * 对应 scope.md §4 第 7 条 —— 七条门槛里唯一一条既没真机走过、也没有任何自动化测试的。
 * 这里跑完整链路：真实的 WorkBuddy 会话 → 导入目标机器（自动备份）→ 回滚 → 逐字节比对目录。
 *
 * 断言口径：**只看文件，不看空目录**。
 * 回滚不删除导入期间新建的目录（`projects/<slug>/`），因为删目录有误删用户数据的风险。
 * 空目录对应用无影响：侧栏读的是数据库，扫描器也只认目录里的 jsonl。
 * 这个取舍写在这里，避免以后有人以为"少删了个目录"是 bug。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { collectForExport, importConversations } from '../../src/core/migrate.js';
import { rollback } from '../../src/core/backup.js';
import { scanStores } from '../../src/core/registry.js';
import { freshDir, makeEnv, seedWorkBuddyDb, seedWorkBuddySession } from '../helpers.js';
import { mintMachine, snapshotTree, diffSnapshots } from './harness.js';

/** 快照里去掉目录条目，只留文件路径与内容哈希。 */
function filesOnly(snapshot) {
  return new Map([...snapshot].filter(([, value]) => value !== 'dir'));
}

test('回滚：真实 WorkBuddy 导入后，目标目录逐字节回到导入前', async () => {
  const A = await mintMachine('rb-e2e-A');
  const B = await mintMachine('rb-e2e-B');
  const seeded = await seedWorkBuddySession(A.home);
  await seedWorkBuddyDb(B.home);

  const wbDir = path.join(B.home, '.workbuddy');
  const before = filesOnly(await snapshotTree(wbDir));

  const collected = await collectForExport(A.env, { agents: ['workbuddy'], redact: false });
  assert.equal(collected.conversations.length, 1);

  const result = await importConversations(B.env, collected.conversations, {
    target: 'workbuddy',
    workspace: 'C:\\work\\restored',
    backup: true,
    blobs: collected.blobs,
  });
  assert.equal(result.results[0].error, null, '导入本身要成功，否则测不到回滚');
  assert.ok(result.backup, '非 dry-run 导入必须产生备份');

  // 先确认导入确实改了目标目录，不然后面的比对没有意义
  const after = filesOnly(await snapshotTree(wbDir));
  const changed = diffSnapshots(before, after);
  assert.ok(changed.added.length >= 1, '导入应该新增会话文件');
  assert.ok(changed.changed.length >= 1, '导入应该改写 sessions 表所在的库');

  const res = await rollback(B.env, result.backup.id);
  assert.deepEqual(
    res.results.filter((r) => r.action === 'failed'),
    [],
    '回滚不应有失败项',
  );

  const restored = filesOnly(await snapshotTree(wbDir));
  const back = diffSnapshots(before, restored);
  assert.deepEqual(back.added, [], '回滚后不应留下导入新建的文件');
  assert.deepEqual(back.removed, [], '回滚后原有文件不能丢');
  assert.deepEqual(back.changed, [], '回滚后每个文件的内容都要与导入前一致');

  // 用户视角：库里回到只有原来那 1 条会话
  const scan = await scanStores(B.env, { only: ['workbuddy'] });
  assert.equal(scan.results[0].sessions.length, 1, '回滚后侧栏应恢复原状');
  assert.equal(scan.results[0].sessions[0].id, 'existing-session');
});

test('回滚：二次导入再回滚，仍然只留下导入前的内容', async () => {  const A = await mintMachine('rb-e2e-twice-A');
  const B = await mintMachine('rb-e2e-twice-B');
  await seedWorkBuddySession(A.home);
  await seedWorkBuddyDb(B.home);

  const wbDir = path.join(B.home, '.workbuddy');
  const before = filesOnly(await snapshotTree(wbDir));
  const collected = await collectForExport(A.env, { agents: ['workbuddy'], redact: false });

  const importer = (opts = {}) =>
    importConversations(B.env, collected.conversations, { target: 'workbuddy', workspace: 'C:\\work\\twice', backup: true, blobs: collected.blobs, ...opts });

  const first = await importer();
  assert.equal(first.results[0].error, null);
  const second = await importer();
  assert.equal(second.results[0].error, null);

  // 第二次是幂等跳过，清单为空；回滚第二次的备份不应破坏第一次导入的内容
  await rollback(B.env, second.backup.id);

  await rollback(B.env, first.backup.id);
  const restored = filesOnly(await snapshotTree(wbDir));
  const back = diffSnapshots(before, restored);
  assert.deepEqual(back, { added: [], removed: [], changed: [] });

  const seededFile = await snapshotTree(wbDir);
  assert.ok(![...seededFile.keys()].some((k) => k.endsWith('.jsonl') && !k.includes('existing')), '不该残留任何导入的会话文件');
});

/**
 * 2026-10-19 验证 Codex 时踩到：回滚删掉了目标里的会话，但台账还记着"已导入"，
 * 再导一次直接被幂等跳过 —— 用户看到「已导入过（某时刻），跳过」，
 * 跑去目标应用里却什么都没有。台账必须跟着回滚走。
 */
test('回滚：导入台账跟着一起清，回滚后能直接重导', async () => {
  const A = await mintMachine('rb-ledger-A');
  const B = await mintMachine('rb-ledger-B');
  await seedWorkBuddySession(A.home);
  await seedWorkBuddyDb(B.home);

  const collected = await collectForExport(A.env, { agents: ['workbuddy'], redact: false });
  const run = () =>
    importConversations(B.env, collected.conversations, {
      target: 'workbuddy',
      workspace: 'C:\\work\\ledger',
      backup: true,
      blobs: collected.blobs,
    });

  const first = await run();
  assert.equal(first.results[0].error, null);
  assert.equal(first.results[0].skipped, false);

  const rb = await rollback(B.env, first.backup.id);
  assert.equal(rb.forgotten, 1, '回滚应把这次登记从导入台账里摘掉');

  const again = await run();
  assert.equal(again.results[0].skipped, false, '台账没清干净，回滚后重导会被误判成"已导入过"');
  assert.equal(again.results[0].error, null);
});

/**
 * 兼容旧备份：`imported` 字段是后来才加进备份清单的。
 * 老版本产生的备份里没有它，但用户照样会回滚 —— 这时要从被删的文件名反推会话 id。
 */
test('回滚：旧备份没有 imported 字段，也要能从文件名兜底清台账', async () => {
  const A = await mintMachine('rb-ledger-old-A');
  const B = await mintMachine('rb-ledger-old-B');
  await seedWorkBuddySession(A.home);
  await seedWorkBuddyDb(B.home);

  const collected = await collectForExport(A.env, { agents: ['workbuddy'], redact: false });
  const run = () =>
    importConversations(B.env, collected.conversations, {
      target: 'workbuddy',
      workspace: 'C:\\work\\ledger-old',
      backup: true,
      blobs: collected.blobs,
    });

  const first = await run();
  assert.equal(first.results[0].error, null);

  // 模拟旧版本产生的备份：把新加的 imported 字段抹掉
  const manifestPath = path.join(first.backup.dir, 'backup.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  delete manifest.imported;
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));

  const rb = await rollback(B.env, first.backup.id);
  assert.equal(rb.forgotten, 1, '要从 rollout / <uuid>.jsonl 文件名反推出会话 id');

  const again = await run();
  assert.equal(again.results[0].skipped, false);
});
