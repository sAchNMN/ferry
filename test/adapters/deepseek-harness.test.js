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
