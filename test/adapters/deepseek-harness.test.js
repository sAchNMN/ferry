import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { collectForExport, importConversations } from '../../src/core/migrate.js';
import { getStore, scanStores } from '../../src/core/registry.js';
import { freshDir, makeEnv, seedDeepSeekHarness } from '../helpers.js';

test('DeepSeek Harness：扫描并读取事件日志', async () => {
  const home = await freshDir('deepseek-harness-read');
  const seeded = await seedDeepSeekHarness(home, 'C:\\work\\deepseek');
  const env = makeEnv(home);
  const store = getStore('deepseek-harness');

  const [ref] = await store.scan(env);
  assert.ok(ref);
  assert.equal(ref.id, seeded.sessionId);
  assert.equal(ref.title, '修复 DeepSeek 迁移');
  assert.equal(ref.workspace, seeded.cwd);

  const conv = await store.read(env, ref, { blobs: new Map() });
  assert.equal(conv.source.adapter, 'deepseek-harness');
  assert.equal(conv.model.id, 'deepseek-chat');
  assert.deepEqual(conv.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.ok(conv.messages[2].blocks.some((b) => b.type === 'thinking' && b.text.includes('迁移入口')));
  assert.ok(conv.messages[2].blocks.some((b) => b.type === 'tool_call' && b.name === 'shell'));
  assert.ok(conv.messages[3].blocks.some((b) => b.type === 'tool_result' && b.output.includes('FAIL')));
});

test('DeepSeek Harness：导出后可迁移到 Claude Code', async () => {
  const sourceHome = await freshDir('deepseek-harness-src');
  const targetHome = await freshDir('deepseek-harness-dst');
  await seedDeepSeekHarness(sourceHome);

  const collected = await collectForExport(makeEnv(sourceHome), {
    agents: ['deepseek-harness'],
    redact: false,
  });
  assert.equal(collected.conversations.length, 1);

  const result = await importConversations(makeEnv(targetHome), collected.conversations, {
    target: 'claude-code',
    workspace: 'C:\\work\\deepseek',
    backup: false,
  });
  assert.equal(result.results[0].error, null);

  const scan = await scanStores(makeEnv(targetHome), { only: ['claude-code'] });
  assert.equal(scan.results[0].sessions.length, 1);
  const [ref] = scan.results[0].sessions;
  const conv = await getStore('claude-code').read(makeEnv(targetHome), ref, { blobs: new Map() });
  assert.equal(conv.title, '修复 DeepSeek 迁移');
  assert.ok(JSON.stringify(conv).includes('FAIL migration.test.js'));
});

test('DeepSeek Harness：读取拼接的 zstd JSONL frames', async () => {
  const home = await freshDir('deepseek-harness-zstd');
  const seeded = await seedDeepSeekHarness(home);
  const raw = await fsp.readFile(seeded.file, 'utf8');
  const compressed = Buffer.concat(
    raw
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => zstdCompressSync(Buffer.from(`${line}\n`))),
  );
  const compressedFile = path.join(path.dirname(seeded.file), 'session.jsonl.zstd');
  await fsp.writeFile(compressedFile, compressed);
  await fsp.rm(seeded.file);

  const env = makeEnv(home);
  const [ref] = await getStore('deepseek-harness').scan(env);
  const conv = await getStore('deepseek-harness').read(env, ref, { blobs: new Map() });
  assert.equal(conv.messages.length, 5);
  assert.ok(conv.messages.some((m) => JSON.stringify(m).includes('FAIL migration.test.js')));
});

/**
 * 2026-10-19 真机发现：本机 Harness 写的是 `session.v4.jsonl.zstd`（带格式版本号），
 * 适配器早期只认 `session.jsonl` / `session.jsonl.zstd`，扫描结果直接是 0。
 * 这条用例锁死"带版本号的压缩会话文件名"。
 */
test('DeepSeek Harness：识别带版本号的 session.v4.jsonl.zstd', async () => {
  const home = await freshDir('deepseek-harness-v4');
  const seeded = await seedDeepSeekHarness(home);
  const raw = await fsp.readFile(seeded.file, 'utf8');
  const compressed = Buffer.concat(
    raw
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => zstdCompressSync(Buffer.from(`${line}\n`))),
  );
  const versioned = path.join(path.dirname(seeded.file), 'session.v4.jsonl.zstd');
  await fsp.writeFile(versioned, compressed);
  await fsp.rm(seeded.file);

  const env = makeEnv(home);
  const refs = await getStore('deepseek-harness').scan(env);
  assert.equal(refs.length, 1, '带版本号的会话文件必须被扫描到');
  assert.equal(refs[0].id, seeded.sessionId);
  assert.equal(refs[0].meta.compressed, true);

  const conv = await getStore('deepseek-harness').read(env, refs[0], { blobs: new Map() });
  assert.equal(conv.messages.length, 5);
  assert.ok(JSON.stringify(conv).includes('FAIL migration.test.js'));
});

test('DeepSeek Harness：不把同名非会话文件当成会话', async () => {
  const home = await freshDir('deepseek-harness-noise');
  const seeded = await seedDeepSeekHarness(home);
  const dir = path.dirname(seeded.file);
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.bak'), 'not a session\n');
  await fsp.writeFile(path.join(dir, 'session-notes.jsonl'), 'not a session\n');

  const refs = await getStore('deepseek-harness').scan(makeEnv(home));
  assert.equal(refs.length, 1, '只应识别真正的 session*.jsonl[.zstd]');
  assert.equal(refs[0].id, seeded.sessionId);
});

/** 把夹具里的会话头改成指定版本，可选改文件名。 */
async function seedVersioned(home, version, fileName = 'session.jsonl') {
  const seeded = await seedDeepSeekHarness(home);
  const lines = (await fsp.readFile(seeded.file, 'utf8')).trimEnd().split(/\r?\n/);
  const header = JSON.parse(lines[0]);
  header.version = version;
  lines[0] = JSON.stringify(header);
  const file = path.join(path.dirname(seeded.file), fileName);
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  if (file !== seeded.file) await fsp.rm(seeded.file);
  return { ...seeded, file };
}

/**
 * 2026-10-19 真机实测：本机有 3 个 v3 会话，其中 2 个有真实内容（21 / 201 条消息）。
 * 「只支持 v4」的版本门槛会把它们直接拒掉 —— 这条用例锁死 v3 必须可读。
 */
test('DeepSeek Harness：v3 会话照样能读（不能只支持 v4）', async () => {
  const home = await freshDir('deepseek-harness-v3');
  const seeded = await seedVersioned(home, 3, 'session.v3.jsonl');
  const env = makeEnv(home);
  const store = getStore('deepseek-harness');

  const refs = await store.scan(env);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].meta.version, 3);

  const conv = await store.read(env, refs[0], { blobs: new Map() });
  assert.equal(conv.meta.formatVersion, 3);
  assert.equal(conv.messages.length, 5);
  assert.ok(JSON.stringify(conv).includes('FAIL migration.test.js'));
});

/**
 * 反方向：真正未知的版本要显式失败，不能读出半截会话冒充成功。
 * 扫描阶段仍列出（用户能看到这个会话存在），但要到 read 才报错。
 */
test('DeepSeek Harness：未知版本 v9 可扫描但读取时显式拒绝', async () => {
  const home = await freshDir('deepseek-harness-v9');
  await seedVersioned(home, 9, 'session.v9.jsonl');
  const env = makeEnv(home);
  const store = getStore('deepseek-harness');

  const refs = await store.scan(env);
  assert.equal(refs.length, 1, '未知版本也要能被扫描到，否则用户不知道它被跳过了');

  await assert.rejects(
    () => store.read(env, refs[0], { blobs: new Map() }),
    (err) => {
      assert.equal(err.code, 'EREAD');
      assert.match(err.hint, /不支持的 Harness 会话版本/);
      assert.match(err.hint, /v9/);
      return true;
    },
  );
});

/**
 * 同一个目录里会同时残留旧版本文件（v3 空壳）和新版本文件（v4）。
 * 只认最高 generation，否则同一条会话会被导出两次。
 */
test('DeepSeek Harness：同目录多版本文件只取最新的一个', async () => {
  const home = await freshDir('deepseek-harness-generations');
  const seeded = await seedDeepSeekHarness(home);
  const dir = path.dirname(seeded.file);
  const v4 = path.join(dir, 'session.v4.jsonl');
  await fsp.rename(seeded.file, v4);

  // 旧版本：同一会话 id，但只有个头，没有内容（真机上就是这种空壳）
  const header = { type: 'session', version: 3, id: seeded.sessionId, createdAt: 1760000000000, cwd: seeded.cwd };
  await fsp.writeFile(path.join(dir, 'session.v3.jsonl'), `${JSON.stringify(header)}\n`);

  const env = makeEnv(home);
  const refs = await getStore('deepseek-harness').scan(env);
  assert.equal(refs.length, 1, '同一会话的两个版本文件只能产出一个 ref');
  assert.equal(path.basename(refs[0].path), 'session.v4.jsonl');
  assert.equal(refs[0].meta.version, 4);
});

/**
 * 以前坏行会被静默跳过，于是一个写坏的会话会被当成"内容更少但成功的会话"导出。
 * 现在必须显式失败 —— 半截历史比报错更危险。
 */
test('DeepSeek Harness：JSONL 坏行显式报错，不静默跳过', async () => {
  const home = await freshDir('deepseek-harness-torn');
  const seeded = await seedDeepSeekHarness(home);
  const lines = (await fsp.readFile(seeded.file, 'utf8')).trimEnd().split(/\r?\n/);
  const broken = [...lines.slice(0, 3), '{"type":"user/message","data":', ...lines.slice(3)];
  await fsp.writeFile(seeded.file, `${broken.join('\n')}\n`);

  const env = makeEnv(home);
  const [ref] = await getStore('deepseek-harness').scan(env);

  await assert.rejects(
    () => getStore('deepseek-harness').read(env, ref, { blobs: new Map() }),
    (err) => {
      assert.equal(err.code, 'EREAD');
      assert.match(err.hint, /JSONL 损坏/);
      return true;
    },
  );
});
