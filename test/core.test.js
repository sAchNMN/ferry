import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { createTar, parseTar } from '../src/core/tar.js';
import { readZip } from '../src/core/zip.js';
import { encryptBuffer, decryptBuffer, isEncrypted } from '../src/core/crypto.js';
import {
  createConversation,
  validateConversation,
  redactConversation,
  renderMarkdown,
  renderHandoff,
  conversationStats,
  block,
  msg,
  deriveTitle,
} from '../src/core/ucm.js';
import { writePack, readPack, createBlobStore, unpackTo, verifyPack } from '../src/core/archive.js';
import {
  collectForExport,
  compileMappings,
  dedupeConversations,
  mapPath,
  planImport,
  resolveWorkspace,
} from '../src/core/migrate.js';
import { makeZip, freshDir, makeEnv, seedCodex } from './helpers.js';

/* ------------------------------------------------------------------ */

test('tar：往返保留中文名、超长路径与二进制内容', () => {
  const longName = 'conversations/' + 'x'.repeat(160) + '/会话.json';
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}') },
    { name: 'blobs/abc', data: Buffer.from([0, 1, 2, 255, 254]) },
    { name: longName, data: Buffer.from('中文内容', 'utf8') },
    { name: 'dir/', dir: true },
  ];
  const buf = createTar(entries);
  const parsed = parseTar(buf);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'manifest.json');
  assert.deepEqual([...parsed[1].data], [0, 1, 2, 255, 254]);
  const hit = parsed.find((p) => p.name === longName);
  assert.ok(hit, '超长路径应通过 PAX 头保留');
  assert.equal(hit.data.toString('utf8'), '中文内容');
});

test('zip：读取 deflate 压缩的导出包', async () => {
  const zip = makeZip({
    'conversations.json': JSON.stringify([{ title: 'hi' }]),
    'user.json': JSON.stringify({ email: 'x@y.z' }),
  });
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  const conv = entries.find((e) => e.name === 'conversations.json');
  assert.deepEqual(JSON.parse(conv.data.toString('utf8')), [{ title: 'hi' }]);
});

test('crypto：AES-GCM 往返 + 错误密码/篡改必须失败', () => {
  const data = Buffer.from('这是一个需要保护的会话'.repeat(100), 'utf8');
  const enc = encryptBuffer(data, 'correct horse battery staple');
  assert.ok(isEncrypted(enc));
  assert.equal(decryptBuffer(enc, 'correct horse battery staple').toString('utf8'), data.toString('utf8'));
  assert.throws(() => decryptBuffer(enc, 'wrong password'), /密码不正确|篡改/);
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 20] ^= 0xff;
  assert.throws(() => decryptBuffer(tampered, 'correct horse battery staple'));
});

/* ------------------------------------------------------------------ */

function sampleConversation() {
  return createConversation({
    id: 'c1',
    title: '迁移测试',
    source: { adapter: 'codex', name: 'Codex' },
    workspace: { cwd: 'C:\\work\\demo' },
    model: { id: 'gpt-5' },
    messages: [
      msg.user('帮我看看 sk-abcdefghijklmnopqrstuvwxyz012345 这个 key 为什么失效'),
      msg.assistant([
        block.thinking('先检查环境变量'),
        block.text('我来检查。'),
        block.toolCall('shell', { command: 'echo $OPENAI_API_KEY' }, 'call_1'),
      ]),
      { id: 'm3', role: 'tool', blocks: [block.toolResult('call_1', 'sk-live-abcdefghijklmnopqrstuvwxyz')] },
      msg.assistant('已定位：环境变量里是旧 key。'),
    ],
  });
}

test('ucm：校验、统计、标题、脱敏', () => {
  const conv = sampleConversation();
  assert.equal(conv.stats.messages, 4);
  assert.equal(conv.stats.toolCalls, 1);
  assert.ok(deriveTitle(conv).startsWith('帮我看看 sk-'), '标题取自首条用户消息');
  assert.ok(deriveTitle(conv).endsWith('…'), '过长的标题会被截断');

  const { conversation: safe, hits } = redactConversation(conv);
  assert.ok(hits.openai >= 1);
  const text = JSON.stringify(safe);
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(text.includes('[REDACTED:openai]'));

  const { conversation: fixed, issues } = validateConversation({ ...conv, schema: 'old/0', messages: conv.messages });
  assert.equal(fixed.schema, 'ferry.conversation/1');
  assert.ok(issues.length >= 1);
});

test('ucm：Markdown 与交接包渲染', () => {
  const conv = sampleConversation();
  const md = renderMarkdown(conv);
  assert.match(md, /# 迁移测试/);
  assert.match(md, /## 🧑 用户/);
  assert.match(md, /调用：shell/);
  assert.match(md, /<details><summary>思考<\/summary>/);

  const hand = renderHandoff(conv);
  assert.match(hand, /会话交接包/);
  assert.match(hand, /接着最后的进度继续工作/);
  assert.match(hand, /\[tool:shell\]/);
});

/* ------------------------------------------------------------------ */

test('archive：加密归档往返 + 校验和 + 篡改检测', async () => {
  const dir = await freshDir('archive');
  const file = path.join(dir, 'backup.ferrypack');
  const blobs = createBlobStore();
  const sha = blobs.add(Buffer.from('fake png bytes'), { mime: 'image/png', name: 'a.png' });

  const conv = sampleConversation();
  conv.messages[1].blocks.push(block.image(sha, 'image/png', 'a.png'));

  const { manifest } = await writePack(file, { conversations: [conv], blobs, password: 'pw-123456789' });
  assert.equal(manifest.stats.conversations, 1);
  assert.equal(manifest.encryption.enabled, true);
  assert.ok(manifest.stats.archiveBytes > 0);

  const pack = await readPack(file, { password: 'pw-123456789' });
  assert.equal(pack.conversations.length, 1);
  assert.equal(pack.conversations[0].title, '迁移测试');
  assert.equal(pack.blobs.size, 1);
  assert.equal(pack.blobs.get(sha).mime, 'image/png');

  await assert.rejects(() => readPack(file, { password: 'nope' }), /密码不正确|篡改/);

  const ok = await verifyPack(file, { password: 'pw-123456789' });
  assert.equal(ok.ok, true);

  const out = path.join(dir, 'unpacked');
  const res = await unpackTo(file, out, { password: 'pw-123456789' });
  assert.equal(res.conversations, 1);
  const onDisk = await fsp.readdir(path.join(out, 'conversations'));
  assert.equal(onDisk.length, 1);
});

test('archive：未加密归档可直接读取', async () => {
  const dir = await freshDir('archive-plain');
  const file = path.join(dir, 'plain.ferrypack');
  await writePack(file, { conversations: [sampleConversation()], blobs: new Map() });
  const pack = await readPack(file);
  assert.equal(pack.encrypted, false);
  assert.equal(pack.conversations[0].workspace.cwd, 'C:\\work\\demo');
});

/* ------------------------------------------------------------------ */

test('migrate：路径映射与工作区决策', async () => {
  const maps = compileMappings(['C:\\old\\proj=D:\\new\\proj', 'C:\\old=D:\\root']);
  // 期望值是 Windows 目标路径，必须用字面量：宿主 path.join 在 POSIX 上会拼出混合分隔符。
  assert.equal(mapPath('C:\\old\\proj\\src\\a.ts', maps), 'D:\\new\\proj\\src\\a.ts');
  assert.equal(mapPath('C:\\old\\other', maps), 'D:\\root\\other');
  assert.equal(mapPath('C:\\unrelated', maps), 'C:\\unrelated');

  const home = await freshDir('migrate-home');
  const env = makeEnv(home);
  const conv = createConversation({ title: 'x', workspace: { cwd: 'C:\\old\\proj' }, messages: [msg.user('hi')] });

  const r1 = resolveWorkspace(conv, { map: maps }, env);
  assert.equal(r1.reason, 'map');
  assert.equal(r1.cwd, 'D:\\new\\proj');

  const r2 = resolveWorkspace(conv, { workspace: 'E:\\explicit' }, env);
  assert.equal(r2.cwd, 'E:\\explicit');

  const r3 = resolveWorkspace(conv, { into: 'E:\\all' }, env);
  assert.equal(r3.cwd, path.join('E:\\all', 'proj'));
});

test('migrate：重复会话去重', () => {
  const a = sampleConversation();
  const b = sampleConversation();
  assert.equal(dedupeConversations([a, b]).length, 1);
});

test('migrate：ImportPlan 默认包装器零写盘并声明写入/备份/锁范围', async () => {
  const homeA = await freshDir('plan-src');
  const homeB = await freshDir('plan-dst');
  await seedCodex(homeA, 'C:\\old\\proj');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);
  const collected = await collectForExport(envA, { agents: ['codex'], redact: false });

  const plan = await planImport(envB, collected.conversations[0], {
    target: 'codex',
    map: ['C:\\old=D:\\new'],
  });

  assert.equal(plan.version, 1);
  assert.equal(plan.fidelity, 'inferred');
  assert.equal(plan.target.id, 'codex');
  assert.ok(plan.writes.length >= 1);
  assert.ok(plan.backupScope.some((p) => p.endsWith(path.join('.codex', 'session_index.jsonl'))));
  assert.ok(plan.locks.includes(plan.writes[0].path));
  assert.equal(plan.stateDigest.length, 64);
  assert.equal(
    await fsp.access(path.join(homeB, '.codex')).then(() => true).catch(() => false),
    false,
    '生成计划不能创建目标目录',
  );
  assert.match(plan.writes[0].path, /sessions/);
});

test('migrate：ImportPlan 路径映射保持零写盘', async () => {
  const homeA = await freshDir('plan-map-src');
  const homeB = await freshDir('plan-map-dst');
  await seedCodex(homeA, 'C:\\old\\proj');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);
  const collected = await collectForExport(envA, { agents: ['codex'], redact: false });
  const plan = await planImport(envB, collected.conversations[0], {
    target: 'claude-code',
    map: ['C:\\old=D:\\new'],
    backup: false,
  });

  assert.match(plan.writes[0].path, /D--new-proj/);
  assert.equal(plan.workspace, 'D:\\new\\proj');
  assert.equal(
    await fsp.access(path.join(homeB, '.claude')).then(() => true).catch(() => false),
    false,
    '计划生成不能创建目标目录',
  );
});

test('migrate：优先调用适配器 planImport 并保留写入/锁/损失声明', async () => {
  const home = await freshDir('plan-adapter');
  const env = makeEnv(home);
  const conv = createConversation({
    id: 'source-1',
    title: '计划适配器',
    messages: [msg.user('hello')],
  });
  const planned = [];
  const store = {
    id: 'test-target',
    name: '测试目标',
    version: '2',
    capabilities: { import: true, tools: false, attachments: false },
    async planImport(_env, _conv, opts) {
      planned.push(opts);
      return {
        writes: [{ path: path.join(home, 'target.json'), kind: 'session', bytes: 12 }],
        backupScope: [path.join(home, 'index.json')],
        locks: [path.join(home, 'target.json')],
        losses: [{ kind: 'thinking', detail: '目标不保留思考块' }],
      };
    },
    async import() {
      assert.fail('实现 planImport 后不应调用旧 import');
    },
  };

  const plan = await planImport(env, conv, { store, workspace: path.join(home, 'project') });
  assert.equal(plan.fidelity, 'declared');
  assert.equal(plan.target.version, '2');
  assert.equal(plan.backupScope[0], path.join(home, 'index.json'));
  assert.ok(plan.locks.includes(path.join(home, 'target.json')));
  assert.equal(plan.losses[0].kind, 'thinking');
  assert.equal(planned[0].dryRun, true);
  assert.equal(planned[0].backup, false);
  assert.equal(await fsp.access(path.join(home, 'target.json')).then(() => true).catch(() => false), false);
});
