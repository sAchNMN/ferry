import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { rollback } from '../../src/core/backup.js';
import { collectForExport, importConversations } from '../../src/core/migrate.js';
import { getStore, scanStores } from '../../src/core/registry.js';
import { block, createConversation } from '../../src/core/ucm.js';
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

/* ------------------------------------------------------------------ */
/* 写回：v4 事件流 + workspace 索引                                    */
/* ------------------------------------------------------------------ */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

/** 伪造 Harness 已初始化的 workspace 索引（侧栏成员资格的唯一来源）。 */
async function seedWorkspaceIndex(home, workspacePath, sessionIds = []) {
  const file = path.join(home, '.dsh', 'storages', 'workspace.json');
  const index = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [WORKSPACE_ID],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        [WORKSPACE_ID]: {
          path: workspacePath,
          title: path.basename(workspacePath),
          sessionIds,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    },
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(index, null, 2));
  return { file, index, id: WORKSPACE_ID };
}

async function importInto(targetHome, sourceHome, opts = {}) {
  const collected = await collectForExport(makeEnv(sourceHome), {
    agents: ['deepseek-harness'],
    redact: false,
  });
  return importConversations(makeEnv(targetHome), collected.conversations, {
    target: 'deepseek-harness',
    workspace: 'C:\\work\\deepseek',
    backup: false,
    ...opts,
  });
}

/** 逐帧解压 Harness 的 zstd 容器（header 一帧、事件一帧）。 */
function decompressSession(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const end = zstdFrameEnd(buffer, offset);
    chunks.push(zstdDecompressSync(buffer.subarray(offset, end)));
    offset = end;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function zstdFrameEnd(raw, start) {
  let cursor = start + 4;
  const descriptor = raw[cursor++];
  const singleSegment = Boolean(descriptor & 0x20);
  const fcsFlag = descriptor >>> 6;
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03];
  if (!singleSegment) cursor += 1;
  cursor += dictionaryBytes;
  cursor += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  let last = false;
  while (!last) {
    const header = raw[cursor] | (raw[cursor + 1] << 8) | (raw[cursor + 2] << 16);
    cursor += 3;
    last = Boolean(header & 1);
    const blockType = (header >>> 1) & 0x03;
    const storedSize = blockType === 1 ? 1 : header >>> 3;
    cursor += storedSize;
  }
  if (descriptor & 0x04) cursor += 4;
  return cursor;
}

test('DeepSeek Harness：能力声明为可原生写回', () => {
  const store = getStore('deepseek-harness');
  assert.equal(store.capabilities.import, true);
  assert.equal(store.capabilities.resume, true);
});

test('DeepSeek Harness：写回 v4 会话并登记到 workspace 索引', async () => {
  const srcHome = await freshDir('dsh-write-src');
  const dstHome = await freshDir('dsh-write-dst');
  await seedDeepSeekHarness(srcHome);
  const seeded = await seedWorkspaceIndex(dstHome, 'C:\\work\\deepseek');

  const result = await importInto(dstHome, srcHome);
  const entry = result.results[0];
  assert.equal(entry.error, null);

  const sessionWrite = entry.writes.find((w) => w.kind === 'deepseek-harness-session');
  const indexWrite = entry.writes.find((w) => w.kind === 'deepseek-harness-workspace-index');
  assert.ok(sessionWrite, '必须写入会话文件');
  assert.ok(indexWrite, '必须登记 workspace 索引');
  assert.match(
    sessionWrite.path,
    /--C-work-deepseek--[\\/]session-[0-9a-f-]{36}[\\/]session\.v4\.jsonl\.zstd$/,
  );

  const index = JSON.parse(await fsp.readFile(seeded.file, 'utf8'));
  assert.deepEqual(index.tables.workspaces[seeded.id].sessionIds, [entry.resume.sessionId]);
  assert.equal(index.tables.workspaces[seeded.id].path, 'C:\\work\\deepseek');

  const refs = await getStore('deepseek-harness').scan(makeEnv(dstHome));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, entry.resume.sessionId);
  assert.equal(refs[0].title, '修复 DeepSeek 迁移');
  assert.equal(refs[0].workspace, 'C:\\work\\deepseek');

  const conv = await getStore('deepseek-harness').read(makeEnv(dstHome), refs[0], { blobs: new Map() });
  assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(conv.messages[0].blocks[0].text, '请检查迁移脚本。');
  assert.ok(conv.messages[1].blocks.some((b) => b.type === 'tool_call' && b.name === 'shell'));
  assert.ok(conv.messages[2].blocks.some((b) => b.type === 'tool_result' && b.output.includes('FAIL')));
});

test('DeepSeek Harness：写出的日志是闭合的 v4 事件流', async () => {
  const srcHome = await freshDir('dsh-write-format-src');
  const dstHome = await freshDir('dsh-write-format-dst');
  await seedDeepSeekHarness(srcHome);
  await seedWorkspaceIndex(dstHome, 'C:\\work\\deepseek');

  const result = await importInto(dstHome, srcHome);
  const sessionWrite = result.results[0].writes.find((w) => w.kind === 'deepseek-harness-session');
  const lines = decompressSession(await fsp.readFile(sessionWrite.path)).split(/\r?\n/).filter(Boolean);

  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'session');
  assert.equal(header.version, 4);
  assert.equal(header.isSeeded, false);
  assert.equal(header.cwd, 'C:\\work\\deepseek');

  const events = lines.slice(1).map((line) => JSON.parse(line));
  events.forEach((event, index) => assert.equal(event.seq, index, 'seq 必须从 0 开始且稠密'));
  assert.equal(events[0].type, 'session/title');

  const surfaceTypes = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);
  for (const event of events.filter((e) => surfaceTypes.has(e.type))) {
    assert.equal(event.surfaceOp, 'append', `${event.type} 必须声明 append`);
  }

  const assistant = events.find((e) => e.type === 'assistant/message');
  assert.ok(Array.isArray(assistant.data.stream), 'assistant/message 必须带 stream 数组');
  const call = events.find((e) => e.type === 'tool/call');
  const toolResult = events.find((e) => e.type === 'tool/result');
  assert.equal(call.data.callId, toolResult.data.message.toolCallId);
  assert.deepEqual(toolResult.sourceEventSeqs, [call.seq]);

  let turn = 0;
  let step = 0;
  let openStep = false;
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn += 1;
      assert.equal(event.data.turn, turn);
      openStep = false;
    } else if (event.type === 'step/start') {
      step += 1;
      assert.equal(event.data.turn, turn);
      assert.equal(event.data.step, step);
      openStep = true;
    } else if (event.type === 'step/end') {
      assert.equal(openStep, true);
      openStep = false;
    } else if (event.type === 'turn/end') {
      assert.equal(openStep, false, 'turn 结束时不能还有打开的 step');
      assert.equal(event.data.turn, turn);
    }
  }
});

test('DeepSeek Harness：预演零写盘，且清单与真实写入一致', async () => {
  const srcHome = await freshDir('dsh-dry-src');
  const dstHome = await freshDir('dsh-dry-dst');
  await seedDeepSeekHarness(srcHome);
  await seedWorkspaceIndex(dstHome, 'C:\\work\\deepseek');

  const planned = await importInto(dstHome, srcHome, { dryRun: true });
  const plannedWrites = planned.results[0].writes;
  assert.equal(plannedWrites.length, 2);
  await assert.rejects(() => fsp.stat(path.join(dstHome, '.dsh', 'sessions')), /ENOENT/);

  const real = await importInto(dstHome, srcHome);
  const realWrites = real.results[0].writes;
  assert.deepEqual(realWrites.map((w) => w.kind), plannedWrites.map((w) => w.kind));
  for (const write of [...plannedWrites, ...realWrites]) assert.ok(write.bytes > 0);
  assert.match(realWrites[0].path, /session-[0-9a-f-]{36}[\\/]session\.v4\.jsonl\.zstd$/);
});

test('DeepSeek Harness：目标目录没有项目时新建 workspace 并排在最前', async () => {
  const srcHome = await freshDir('dsh-new-ws-src');
  const dstHome = await freshDir('dsh-new-ws-dst');
  await seedDeepSeekHarness(srcHome);
  const seeded = await seedWorkspaceIndex(dstHome, 'C:\\work\\other');

  const result = await importInto(dstHome, srcHome, { workspace: 'C:\\work\\newproj' });
  assert.equal(result.results[0].error, null);

  const index = JSON.parse(await fsp.readFile(seeded.file, 'utf8'));
  assert.equal(index.global.workspaceIds.length, 2);
  const newId = index.global.workspaceIds[0];
  assert.notEqual(newId, seeded.id);
  assert.equal(index.tables.workspaces[newId].path, 'C:\\work\\newproj');
  assert.equal(index.tables.workspaces[newId].title, 'newproj');
  assert.deepEqual(index.tables.workspaces[newId].sessionIds, [result.results[0].resume.sessionId]);
});

test('DeepSeek Harness：索引尚未初始化时只写会话，交给首启 bootstrap 归组', async () => {
  const srcHome = await freshDir('dsh-no-index-src');
  const dstHome = await freshDir('dsh-no-index-dst');
  await seedDeepSeekHarness(srcHome);

  const result = await importInto(dstHome, srcHome);
  const entry = result.results[0];
  assert.equal(entry.error, null);
  assert.equal(entry.writes.length, 1);
  assert.ok(entry.notes.some((note) => note.includes('自动归组')));
  assert.equal((await getStore('deepseek-harness').scan(makeEnv(dstHome))).length, 1);
});

test('DeepSeek Harness：workspace 索引损坏时中止导入，不留下半条会话', async () => {
  const srcHome = await freshDir('dsh-bad-index-src');
  const dstHome = await freshDir('dsh-bad-index-dst');
  await seedDeepSeekHarness(srcHome);
  const file = path.join(dstHome, '.dsh', 'storages', 'workspace.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true }, tables: {} }));

  const result = await importInto(dstHome, srcHome);
  const entry = result.results[0];
  assert.match(entry.error, /workspace 索引/);
  await assert.rejects(() => fsp.stat(path.join(dstHome, '.dsh', 'sessions')), /ENOENT/);
});

test('DeepSeek Harness：rollback 还原 workspace 索引并删掉新建会话', async () => {
  const srcHome = await freshDir('dsh-rollback-src');
  const dstHome = await freshDir('dsh-rollback-dst');
  await seedDeepSeekHarness(srcHome);
  const seeded = await seedWorkspaceIndex(dstHome, 'C:\\work\\deepseek');
  const before = await fsp.readFile(seeded.file, 'utf8');

  const result = await importInto(dstHome, srcHome, { backup: true });
  assert.equal(result.results[0].error, null);
  assert.ok(result.backup);
  assert.notEqual(await fsp.readFile(seeded.file, 'utf8'), before);
  assert.equal((await getStore('deepseek-harness').scan(makeEnv(dstHome))).length, 1);

  await rollback(makeEnv(dstHome), result.backup.id);
  assert.equal(await fsp.readFile(seeded.file, 'utf8'), before);
  assert.equal((await getStore('deepseek-harness').scan(makeEnv(dstHome))).length, 0);
});

test('DeepSeek Harness：没有结果的工具调用整对跳过并记入 losses', async () => {
  const home = await freshDir('dsh-unpaired');
  const conv = createConversation({
    title: '没有结果的调用',
    messages: [
      { role: 'user', blocks: [block.text('跑一下')] },
      { role: 'assistant', blocks: [block.toolCall('pwsh', { command: 'x' }, 'call-x')] },
    ],
  });

  const result = await getStore('deepseek-harness').import(makeEnv(home), conv, {
    workspace: 'C:\\work\\unpaired',
    dryRun: true,
  });
  assert.ok(result.losses.some((loss) => loss.kind === 'tools'));
});
