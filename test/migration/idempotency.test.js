/**
 * 迁移引擎：导入幂等与 map 归一。
 *
 * 幂等的定义（契约 §2 硬性要求第 4 条）：同一会话导入两次，第二次不得产生重复会话。
 * 实现方式是导入台账（<ferryHome>/imported.json），因为导入会重写 sessionId，
 * 导入后的指纹与源端对不上，扫描比对这条路走不通。
 *
 * 这里同时锁住台账的降级行为：台账坏了、缺了、格式不认识，都不能阻断迁移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { collectForExport, importConversations, compileMappings, normalizeMap } from '../../src/core/migrate.js';
import { scanStores, getStore } from '../../src/core/registry.js';
import { ledgerPath, readLedger } from '../../src/core/ledger.js';
import { freshDir, makeEnv, seedCodex } from '../helpers.js';

/** 造源机器 → 收集会话，返回 { conversations, envB }。 */
async function prepare() {
  const homeA = await freshDir('idem-A');
  const homeB = await freshDir('idem-B');
  await seedCodex(homeA, 'C:\\work\\demo');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);
  const collected = await collectForExport(envA, { agents: ['codex'], redact: false });
  assert.equal(collected.conversations.length, 1);
  return { conversations: collected.conversations, envB, homeB };
}

const baseOpts = { target: 'claude-code', workspace: 'C:\\work\\demo', backup: false };

test('幂等：第二次导入直接跳过，目标机只有 1 个会话', async () => {
  const { conversations, envB } = await prepare();

  const first = await importConversations(envB, conversations, baseOpts);
  assert.equal(first.results[0].skipped, false);
  assert.equal(first.results[0].error, null);

  const second = await importConversations(envB, conversations, baseOpts);
  assert.equal(second.results[0].skipped, true, '第二次应当被跳过');
  assert.deepEqual(second.results[0].writes, [], '跳过时不应有任何写入');
  assert.match(second.results[0].notes.join(' '), /已导入过/);

  const scan = await scanStores(envB, { only: ['claude-code'] });
  assert.equal(scan.results[0].sessions.length, 1, '重复导入产生了副本');
});

test('幂等：--force 强制重导，会话增加但台账不膨胀', async () => {
  const { conversations, envB } = await prepare();

  await importConversations(envB, conversations, baseOpts);
  const forced = await importConversations(envB, conversations, { ...baseOpts, force: true });
  assert.equal(forced.results[0].skipped, false, 'force 不应跳过');
  assert.ok(forced.results[0].writes.length > 0);

  const scan = await scanStores(envB, { only: ['claude-code'] });
  assert.equal(scan.results[0].sessions.length, 2, 'force 应当再写一份');

  const ledger = await readLedger(envB);
  assert.equal(Object.keys(ledger.targets['claude-code']).length, 1, '同一指纹只应有一条台账记录');
});

test('幂等：dry-run 不写台账', async () => {
  const { conversations, envB } = await prepare();

  const dry = await importConversations(envB, conversations, { ...baseOpts, dryRun: true });
  assert.equal(dry.results[0].skipped, false, '首次干跑不该被跳过');
  await assert.rejects(() => fsp.access(ledgerPath(envB)), '干跑不应创建台账文件');

  // 干跑之后真实导入，仍应真正写入（没被干跑"占位"）
  const real = await importConversations(envB, conversations, baseOpts);
  assert.equal(real.results[0].skipped, false);
  assert.ok(real.results[0].writes.length > 0);
});

test('幂等：干跑能识别"已导入过"，并报出跳过计划', async () => {
  const { conversations, envB } = await prepare();
  await importConversations(envB, conversations, baseOpts);

  const dry = await importConversations(envB, conversations, { ...baseOpts, dryRun: true });
  assert.equal(dry.results[0].skipped, true, '干跑也应当如实报告"这次不会写任何东西"');
  assert.deepEqual(dry.results[0].writes, []);
});

test('幂等：台账损坏时降级为空台账，不阻断导入', async () => {
  const { conversations, envB } = await prepare();
  await fsp.mkdir(path.dirname(ledgerPath(envB)), { recursive: true });
  await fsp.writeFile(ledgerPath(envB), '{ 这不是 JSON', 'utf8');

  const warnings = [];
  const res = await importConversations(envB, conversations, {
    ...baseOpts,
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(res.results[0].error, null, '台账坏了不该阻断迁移');
  assert.equal(res.results[0].skipped, false);
  assert.ok(warnings.some((w) => w.includes('台账')), '应告警说明台账异常');
});

test('幂等：不同目标互不影响', async () => {
  const { conversations, envB } = await prepare();
  await importConversations(envB, conversations, baseOpts);

  const other = await importConversations(envB, conversations, { ...baseOpts, target: 'codex' });
  assert.equal(other.results[0].skipped, false, '换一个目标不应被上一次导入挡住');
});

test('map 归一：传原始字符串不再崩，等价于 compileMappings', () => {
  const rules = ['C:\\work\\demo=/home/u/demo'];
  assert.deepEqual(normalizeMap(rules), compileMappings(rules));
  assert.deepEqual(normalizeMap(compileMappings(rules)), compileMappings(rules));
  assert.deepEqual(normalizeMap(undefined), []);
  assert.deepEqual(normalizeMap([{ from: 'a', to: 'b' }, { bad: 1 }]), [{ from: 'a', to: 'b' }]);
});

test('map 归一：导入时直接给字符串也能完成路径映射', async () => {
  const { conversations, envB } = await prepare();
  await importConversations(envB, conversations, {
    ...baseOpts,
    map: ['C:\\work\\demo=/home/u/work-demo'],
  });
  const [ref] = await getStore('claude-code').scan(envB);
  const conv = await getStore('claude-code').read(envB, ref, { blobs: new Map() });
  assert.equal(conv.workspace?.cwd, '/home/u/work-demo');
});
