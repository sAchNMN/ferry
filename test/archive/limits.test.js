/**
 * 归档的资源限制与路径安全。
 *
 * 归档是"用户从别处拷来的文件"，必须按不可信输入处理。这里覆盖四类攻击面：
 *   1. 解压炸弹（gzip 压缩比极高 / 条目极多 / 单条极大）
 *   2. 路径穿越（`../`、绝对路径、盘符）
 *   3. 附件名注入（sha256 位置塞 `../` 让写入逃出目录）
 *   4. 正常归档不能被这些限制误伤
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { createTar } from '../../src/core/tar.js';
import { readPackBuffer, unpackTo, writePack } from '../../src/core/archive.js';
import { assertSafeEntryName, assertSafeHash, createBudget, mergeLimits, DEFAULT_LIMITS } from '../../src/core/limits.js';
import { createConversation, block } from '../../src/core/ucm.js';
import { freshDir } from '../helpers.js';

/** 拼一个最小可读归档（未加密 gzip + tar）。 */
function buildPack(entries, manifestOver = {}) {
  const manifest = Buffer.from(
    JSON.stringify({
      format: 'ferrypack/1',
      ucm: 'ferry.conversation/1',
      createdAt: new Date().toISOString(),
      stats: { conversations: 0, messages: 0, chars: 0 },
      conversations: [],
      blobs: [],
      ...manifestOver,
    }),
    'utf8',
  );
  const tar = createTar([
    { name: 'manifest.json', data: manifest, mtime: new Date() },
    ...entries.map((e) => ({ name: e.name, data: Buffer.from(e.data), mtime: new Date() })),
  ]);
  return zlib.gzipSync(tar);
}

function sampleConversation() {
  return createConversation({
    id: 'c1',
    title: '测试会话',
    source: { adapter: 'codex', name: 'Codex' },
    messages: [{ role: 'user', blocks: [block.text('你好')] }],
  });
}

test('限制：默认值合理，覆盖只接受正数', () => {
  const l = mergeLimits({ maxTotalBytes: 1024, maxEntries: 0, bogus: 9 });
  assert.equal(l.maxTotalBytes, 1024);
  assert.equal(l.maxEntries, DEFAULT_LIMITS.maxEntries, '非法值（0）不应生效');
  assert.equal('bogus' in l, false);
});

test('限制：条目名拒绝穿越、绝对路径、盘符、反斜杠、NUL', () => {
  for (const bad of ['../evil', 'a/../../b', '/etc/passwd', 'C:\\x', 'c:/x', 'a\\b', 'a\0b', '']) {
    assert.throws(() => assertSafeEntryName(bad), `应拒绝：${JSON.stringify(bad)}`);
  }
  for (const ok of ['manifest.json', 'conversations/a.json', 'blobs/deadbeef']) {
    assert.equal(assertSafeEntryName(ok), ok);
  }
});

test('限制：附件哈希必须是 64 位十六进制', () => {
  assert.equal(assertSafeHash('a'.repeat(64)), 'a'.repeat(64));
  for (const bad of ['../evil', 'A'.repeat(64), 'a'.repeat(63), '', null]) {
    assert.throws(() => assertSafeHash(bad), `应拒绝：${String(bad)}`);
  }
});

test('限制：预算逐条扣减，超条目数立即失败', () => {
  const budget = createBudget(mergeLimits({ maxEntries: 2 }));
  budget.add(1, 'a');
  budget.add(1, 'b');
  assert.throws(() => budget.add(1, 'c'), /条目数超出上限/);
  assert.equal(budget.entries, 2, '失败后计数不应继续累加');
});

test('限制：预算拦住单条超限与总量超限', () => {
  const single = createBudget(mergeLimits({ maxEntryBytes: 100 }));
  assert.throws(() => single.add(101, 'big'), /单条体积超出上限/);

  const total = createBudget(mergeLimits({ maxTotalBytes: 100, maxEntryBytes: 1000 }));
  total.add(60, 'a');
  assert.throws(() => total.add(60, 'b'), /总量超出上限/);
});

test('限制：gzip 炸弹在解压阶段被拦住', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < 64 * 1024, '构造的炸弹压缩后应当很小');
  assert.throws(
    () => readPackBuffer(bomb, { limits: { maxTotalBytes: 1024 * 1024 } }),
    /解压失败或体积超出上限/,
  );
});

test('限制：条目数超限的归档被拒绝', () => {
  const raw = buildPack(Array.from({ length: 6 }, (_, i) => ({ name: `conversations/c${i}.json`, data: '{}' })));
  assert.throws(() => readPackBuffer(raw, { limits: { maxEntries: 3 } }), /条目数超出上限/);
});

test('限制：含路径穿越条目的归档被拒绝', () => {
  const raw = buildPack([{ name: '../../evil.txt', data: 'pwn' }]);
  assert.throws(() => readPackBuffer(raw), /路径不安全/);
});

test('限制：绝对路径条目被拒绝', () => {
  // createTar 会剥掉开头的斜杠，所以这里直接改字节，模拟一个真正恶意的归档
  const tar = createTar([{ name: 'etc/shadowx', data: Buffer.from('pwn'), mtime: new Date() }]);
  Buffer.from('/etc/shadow').copy(tar, 0); // 等长覆盖，保持 tar 头结构
  assert.throws(() => readPackBuffer(zlib.gzipSync(tar)), /绝对路径/);
});

test('限制：manifest 里的附件名不能带穿越', () => {
  const raw = buildPack([{ name: 'blobs/x', data: 'x' }], {
    blobs: [{ sha256: '../../escape', file: 'blobs/x', bytes: 1, mime: 'text/plain' }],
  });
  assert.throws(() => readPackBuffer(raw), /附件哈希不合法/);
});

test('限制：正常归档不受这些限制影响', async () => {
  const dir = await freshDir('limits-ok');
  const conv = sampleConversation();
  const file = `${dir}/ok.ferrypack`;
  await writePack(file, { conversations: [conv], blobs: new Map(), password: 'pw-123456' });

  const pack = readPackBuffer(await import('node:fs').then((m) => m.readFileSync(file)), { password: 'pw-123456' });
  assert.equal(pack.conversations.length, 1);
  assert.equal(pack.conversations[0].title, '测试会话');

  const out = await freshDir('limits-unpack');
  const res = await unpackTo(file, out, { password: 'pw-123456' });
  assert.equal(res.conversations, 1);
});
