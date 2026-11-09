import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { planProjectRestore, restoreProjectSnapshots } from '../../src/core/projects.js';
import { readPack, unpackTo, writePack } from '../../src/core/archive.js';
import { createConversation } from '../../src/core/ucm.js';
import { safeName } from '../../src/core/util.js';
import { freshDir } from '../helpers.js';

const conversation = createConversation({ id: 'CON', workspace: { cwd: '/source/project' } });
const projectWith = (paths) => ({
  id: 'p1', name: '项目', originalPath: '/source/project',
  files: paths.map((file) => ({ path: file, data: Buffer.from(file) })),
});

test('Windows 文件名：安全名称避开设备名，并在截断后去掉尾部句点', () => {
  for (const name of ['CON', 'NUL.txt', 'aux.json', 'LPT1.log', 'COM¹.txt', 'CONIN$']) {
    assert.notEqual(safeName(name), name);
  }
  assert.equal(safeName('a'.repeat(79) + '.suffix'), 'a'.repeat(79));
  assert.equal(safeName('COM10.txt'), 'COM10.txt');
});

test('Windows 恢复预检：非法名称和大小写冲突在创建目录前被拒绝', { skip: process.platform !== 'win32' }, async () => {
  const base = await freshDir('windows-restore-preflight');
  const cases = [
    ['src/NUL.txt'], ['src/config:secret'], ['src/a?.js'], ['src/a*.js'], ['src/CONIN$'],
    ['src/trailing.'], ['src/trailing '], ['src/control\u0001.txt'], ['src/' + 'a'.repeat(256)],
    ['README.md', 'readme.md'], ['src', 'SRC/main.js'], ['src/main.js', 'SRC'],
  ];
  for (const paths of cases) {
    await assert.rejects(() => planProjectRestore([projectWith(paths)], [conversation], path.join(base, 'output')), undefined, paths.join(', '));
  }
  assert.deepEqual(await fsp.readdir(base), []);
});

test('项目恢复预检：重复路径和文件目录冲突在所有平台被拒绝', async () => {
  const base = await freshDir('restore-file-conflicts');
  for (const paths of [['src/a', 'src/a'], ['src', 'src/a'], ['src/a', 'src']]) {
    await assert.rejects(() => planProjectRestore([projectWith(paths)], [conversation], base));
  }
});

test('Windows 解包：非法项目路径不留下半解包目录', { skip: process.platform !== 'win32' }, async () => {
  const base = await freshDir('windows-unpack-preflight');
  const packFile = path.join(base, 'source.ferrypack');
  await writePack(packFile, { conversations: [conversation], projects: [projectWith(['ok.txt', 'src/config:secret'])] });
  assert.equal((await readPack(packFile)).projects.length, 1);
  const output = path.join(base, 'output');
  await assert.rejects(() => unpackTo(packFile, output));
  await assert.rejects(() => fsp.stat(output), { code: 'ENOENT' });
});

test('项目恢复：中文、空格和百分号文件名保留原文', async () => {
  const base = await freshDir('windows-valid-project');
  const filename = '源码 #100%/COM10.md';
  const plan = await planProjectRestore([projectWith([filename])], [conversation], base);
  const restored = await restoreProjectSnapshots(plan);
  assert.equal(await fsp.readFile(path.join(restored[0].path, filename), 'utf8'), filename);
});

test('Windows 解包：设备名会话 ID 转成可写文件名', { skip: process.platform !== 'win32' }, async () => {
  const base = await freshDir('windows-unpack-device');
  const packFile = path.join(base, 'source.ferrypack');
  await writePack(packFile, { conversations: [conversation] });
  const output = path.join(base, 'output');
  await unpackTo(packFile, output);
  assert.deepEqual(await fsp.readdir(path.join(output, 'conversations')), ['_CON.json']);
});
