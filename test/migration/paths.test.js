/**
 * 跨平台路径映射。
 *
 * 这是"换电脑"最容易出错的一环：路径改写错了，会话能导进去但一打开就提示目录不存在，
 * 用户会认为迁移失败。所以这里按边界情况逐条钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileMappings,
  mapPath,
  normalizeMap,
  resolveWorkspace,
  basenameAny,
} from '../../src/core/migrate.js';
import { normalizePath, samePath, relativeTo, toWsl, fromWsl, pathKind, splitPath } from '../../src/core/paths.js';

test('规范化：统一分隔符、去掉尾斜杠与 . 段', () => {
  assert.equal(normalizePath('C:\\work\\demo\\'), 'C:/work/demo');
  assert.equal(normalizePath('C:/work//demo'), 'C:/work/demo');
  assert.equal(normalizePath('/home/u/./proj/'), '/home/u/proj');
  assert.equal(normalizePath('C:\\'), 'C:/');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('a/b/../c'), 'a/c');
  assert.equal(normalizePath('../x'), '../x');
  assert.equal(normalizePath('/a/../..'), '/');
});

test('形态识别：drive / unc / wsl / posix', () => {
  assert.equal(pathKind('C:\\work'), 'drive');
  assert.equal(pathKind('\\\\server\\share\\dir'), 'unc');
  assert.equal(pathKind('/mnt/c/work'), 'wsl');
  assert.equal(pathKind('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\work'), 'wsl');
  assert.equal(pathKind('/home/u'), 'posix');
  assert.equal(pathKind('rel/path'), 'relative');
});

test('相对关系：子路径 / 相等 / 不相交 / 大小写', () => {
  assert.deepEqual(relativeTo('C:\\work\\demo\\src', 'C:\\work\\demo'), ['src']);
  assert.deepEqual(relativeTo('C:\\work\\demo', 'C:\\work\\demo'), []);
  assert.deepEqual(relativeTo('C:\\WORK\\Demo\\SRC', 'c:\\work\\demo'), ['SRC']);
  assert.equal(relativeTo('C:\\work\\other', 'C:\\work\\demo'), null);
  assert.equal(relativeTo('C:\\work', 'C:\\work\\demo'), null);
  assert.equal(relativeTo('/home/u/a', 'C:\\home\\u'), null, '不同形态（盘符 vs POSIX）不应误判');
});

test('映射：Windows → POSIX，子路径保持目标分隔符', () => {
  const maps = compileMappings(['C:\\work\\demo=/home/u/demo']);
  assert.equal(mapPath('C:\\work\\demo', maps), '/home/u/demo');
  assert.equal(mapPath('C:\\work\\demo\\src\\auth.ts', maps), '/home/u/demo/src/auth.ts');
  assert.ok(!mapPath('C:\\work\\demo\\src', maps).includes('\\'), '映射到 POSIX 后不应残留反斜杠');
});

test('映射：POSIX → Windows，输出反斜杠且不混合', () => {
  const maps = compileMappings(['/home/u/demo=D:\\proj']);
  assert.equal(mapPath('/home/u/demo', maps), 'D:\\proj');
  assert.equal(mapPath('/home/u/demo/src/a.ts', maps), 'D:\\proj\\src\\a.ts');
});

test('映射：大小写不敏感，盘符也兼容', () => {
  const maps = compileMappings(['C:\\Work\\Demo=/data/demo']);
  assert.equal(mapPath('c:\\work\\demo\\x', maps), '/data/demo/x');
});

test('映射：未命中时原样返回，不改写任何路径', () => {
  const maps = compileMappings(['C:\\work\\demo=/home/u/demo']);
  assert.equal(mapPath('D:\\other\\place', maps), 'D:\\other\\place');
  assert.equal(mapPath('C:\\work\\demo2\\x', maps), 'C:\\work\\demo2\\x', '前缀相似但不是子目录，不能误匹配');
  assert.equal(mapPath(undefined, maps), undefined);
});

test('映射：最长前缀优先', () => {
  const maps = compileMappings(['C:\\work=/a', 'C:\\work\\demo=/b']);
  assert.equal(mapPath('C:\\work\\demo\\x', maps), '/b/x');
  assert.equal(mapPath('C:\\work\\other', maps), '/a/other');
});

test('映射：也接受 => 分隔符（路径里可能有 =）', () => {
  const maps = compileMappings(['C:\\work\\a=b => /target']);
  assert.equal(maps[0].to, '/target');
  assert.equal(mapPath('C:\\work\\a=b\\x', maps), '/target/x');
});

test('映射：同一 from 重复时以最后一条为准', () => {
  const maps = compileMappings(['C:\\a=/one', 'C:\\a=/two']);
  assert.equal(maps.length, 1);
  assert.equal(mapPath('C:\\a\\x', maps), '/two/x');
});

test('映射：中文与空格路径', () => {
  const maps = compileMappings(['D:\\工作 目录\\项目=/Users/子辰/项目']);
  assert.equal(mapPath('D:\\工作 目录\\项目\\笔记.md', maps), '/Users/子辰/项目/笔记.md');
});

test('映射：根盘符映射', () => {
  const maps = compileMappings(['C:\\=/data/win']);
  assert.equal(mapPath('C:\\work\\demo', maps), '/data/win/work/demo');
});

test('WSL：正反向转换与往返', () => {
  assert.equal(toWsl('C:\\work\\demo'), '/mnt/c/work/demo');
  assert.equal(toWsl('D:\\a'), '/mnt/d/a');
  assert.equal(fromWsl('/mnt/c/work/demo'), 'C:\\work\\demo');
  assert.equal(fromWsl('/mnt/d/a'), 'D:\\a');
  assert.equal(toWsl('/home/u'), '/home/u', '非 Windows 路径原样返回');
  assert.equal(fromWsl('C:\\work'), 'C:/work', '非 WSL 路径规范化后返回');
  for (const p of ['C:\\work\\demo', 'D:\\中文\\项目']) {
    assert.ok(samePath(fromWsl(toWsl(p)), p), `往返失败：${p}`);
  }
});

test('WSL：\\wsl.localhost 形态也识别为 wsl', () => {
  const parts = splitPath('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\work');
  assert.equal(parts.kind, 'wsl');
  assert.equal(parts.root, '/mnt/c');
  assert.deepEqual(parts.parts, ['work']);
});

test('工作区决策：映射规则生效，并说明来源', () => {
  const env = { cwd: '/work' };
  const conv = { workspace: { cwd: 'C:\\work\\demo' } };
  const ws = resolveWorkspace(conv, { map: compileMappings(['C:\\work\\demo=/home/u/demo']) }, env);
  assert.equal(ws.cwd, '/home/u/demo');
  assert.equal(ws.reason, 'map');
  assert.equal(ws.original, 'C:\\work\\demo');
});

test('工作区决策：没有原路径时落到 env.cwd', () => {
  const ws = resolveWorkspace({}, {}, { cwd: '/work' });
  assert.equal(ws.cwd, '/work');
  assert.equal(ws.reason, 'cwd');
});

test('basenameAny：Windows 与 POSIX 路径都能取到末段', () => {
  assert.equal(basenameAny('C:\\work\\demo'), 'demo');
  assert.equal(basenameAny('/home/u/demo'), 'demo');
  assert.equal(basenameAny('/home/u/demo/'), 'demo');
  assert.equal(basenameAny(''), 'project');
});

test('normalizeMap 与 compileMappings 一致', () => {
  const rules = ['C:\\a=/b'];
  assert.deepEqual(normalizeMap(rules), compileMappings(rules));
});
