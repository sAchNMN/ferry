import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writePack, unpackTo } from '../../src/core/archive.js';
import { createConversation, block } from '../../src/core/ucm.js';
import { freshDir } from '../helpers.js';

test('CLI 转换：同名和清洗后重名的会话全部保留，不覆盖已有文件', async () => {
  const dir = await freshDir('convert-file-collisions');
  const input = path.join(dir, 'source.json');
  const output = path.join(dir, 'output');
  await fsp.mkdir(output);
  await fsp.writeFile(path.join(output, 'Demo.md'), 'keep-existing');
  const names = ['Demo', 'Demo', 'demo', 'a:b', 'a?b', 'NUL', '...'];
  const conversations = names.map((name, i) => ({
    uuid: 'c-' + i, name, chat_messages: [{ sender: 'human', text: 'unique-content-' + i }],
  }));
  await fsp.writeFile(input, JSON.stringify(conversations));
  const result = spawnSync(process.execPath, [path.resolve('bin/ferry.js'), 'convert', input, '--to', 'markdown', '--out', output, '--home', dir], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /已转换 7 个会话/);
  const files = await fsp.readdir(output);
  assert.equal(files.length, names.length + 1);
  assert.equal(await fsp.readFile(path.join(output, 'Demo.md'), 'utf8'), 'keep-existing');
  const texts = await Promise.all(files.map((file) => fsp.readFile(path.join(output, file), 'utf8')));
  for (let i = 0; i < names.length; i++) assert.ok(texts.some((text) => text.includes('unique-content-' + i)));
  assert.ok(files.includes('_NUL.md'));
});

test('归档解包：清洗后同名的会话 ID 不会相互覆盖', async () => {
  const dir = await freshDir('unpack-file-collisions');
  const pack = path.join(dir, 'source.ferrypack');
  const conversations = ['a:b', 'a?b'].map((id, i) => createConversation({
    id, messages: [{ role: 'user', blocks: [block.text('message-' + i)] }],
  }));
  await writePack(pack, { conversations });
  const output = path.join(dir, 'output');
  await unpackTo(pack, output);
  const files = await fsp.readdir(path.join(output, 'conversations'));
  assert.equal(files.length, 2);
  const unpacked = await Promise.all(files.map(async (file) => JSON.parse(await fsp.readFile(path.join(output, 'conversations', file), 'utf8'))));
  assert.deepEqual(unpacked.map((conv) => conv.id).sort(), ['a:b', 'a?b'].sort());
});
