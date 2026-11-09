import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { collectProjectSnapshots } from '../../src/core/projects.js';
import { createIgnoreMatcher, parseIgnoreRules } from '../../src/core/ignore.js';
import { createConversation, block } from '../../src/core/ucm.js';
import { freshDir } from '../helpers.js';

function convFor(root) {
  return createConversation({
    id: 'c-ignore',
    title: '排除规则',
    source: { adapter: 'codex', name: 'Codex' },
    workspace: { cwd: root },
    messages: [{ role: 'user', blocks: [block.text('继续项目')] }],
  });
}

test('项目快照：默认排除 .tmp 等缓存目录', async () => {
  const root = await freshDir('ignore-defaults');
  await fsp.mkdir(path.join(root, '.tmp', 'deep'), { recursive: true });
  await fsp.writeFile(path.join(root, '.tmp', 'deep', 'a.txt'), 'x');
  await fsp.writeFile(path.join(root, 'app.js'), 'code');

  const collected = await collectProjectSnapshots([convFor(root)]);
  assert.deepEqual(collected.projects[0].files.map((file) => file.path), ['app.js']);
  assert.equal(collected.excludedFiles, 1);
});

test('项目快照：.ferryignore 支持目录、通配与取反', async () => {
  const root = await freshDir('ignore-file');
  await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
  await fsp.mkdir(path.join(root, 'src', 'gen'), { recursive: true });
  await fsp.writeFile(path.join(root, 'dist', 'bundle.js'), 'b');
  await fsp.writeFile(path.join(root, 'src', 'gen', 'api.js'), 'g');
  await fsp.writeFile(path.join(root, 'src', 'main.js'), 'm');
  await fsp.writeFile(path.join(root, 'debug.log'), 'l');
  await fsp.writeFile(path.join(root, 'keep.log'), 'k');
  await fsp.writeFile(
    path.join(root, '.ferryignore'),
    ['# 构建产物', 'dist/', '/src/gen/', '*.log', '!keep.log', ''].join('\n'),
  );

  const collected = await collectProjectSnapshots([convFor(root)]);
  assert.deepEqual(collected.projects[0].files.map((file) => file.path).sort(), [
    '.ferryignore',
    'keep.log',
    'src/main.js',
  ]);
});

test('项目快照：调用方追加的排除规则', async () => {
  const root = await freshDir('ignore-extra');
  await fsp.mkdir(path.join(root, 'build'), { recursive: true });
  await fsp.writeFile(path.join(root, 'build', 'out.txt'), 'o');
  await fsp.writeFile(path.join(root, 'README.md'), '#');

  const collected = await collectProjectSnapshots([convFor(root)], { excludes: ['build/'] });
  assert.deepEqual(collected.projects[0].files.map((file) => file.path), ['README.md']);
});

test('排除规则：glob 语义与内置目录', () => {
  const isIgnored = createIgnoreMatcher({ rules: parseIgnoreRules('dist/\n*.log\n!keep.log\nsrc/**/tmp\n') });
  assert.equal(isIgnored('dist', true), true);
  assert.equal(isIgnored('dist', false), false, '结尾 / 只匹配目录');
  assert.equal(isIgnored('a/b/debug.log', false), true, '不含 / 的规则匹配任意层级');
  assert.equal(isIgnored('keep.log', false), false, '! 取消排除');
  assert.equal(isIgnored('src/x/tmp', false), true, '** 跨目录');
  assert.equal(isIgnored('node_modules', true), true, '内置目录名');
  assert.equal(isIgnored('src/app.js', false), false);
});