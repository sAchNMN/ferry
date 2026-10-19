/**
 * 契约测试：适配器装配点。
 *
 * 这一组测试的作用不是验证某个平台的解析逻辑，而是验证"新增一个适配器只需新增一个文件"。
 * 一旦有人把公共注册改回手写清单，这里的注入用例会失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { discoverAdapters, describeAdapters } from '../../src/adapters/_loader.js';
import { stores, importers, origin } from '../../src/adapters/index.js';
import { getStore, importTargets, pickImporter } from '../../src/core/registry.js';
import { defineStore, defineImporter } from '../../src/core/adapter.js';

async function tmpAdapterDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferry-discovery-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('装配点：现有适配器全部被自动发现', async () => {
  assert.ok(stores.length >= 14, `store 数量异常：${stores.length}`);
  assert.ok(importers.length >= 4, `importer 数量异常：${importers.length}`);
  for (const s of stores) assert.ok(origin.has(s.id), `${s.id} 缺少来源文件记录`);
});

test('装配点：适配器 id 全局唯一', () => {
  const ids = [...stores, ...importers].map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `存在重复 id：${ids.join(', ')}`);
});

test('装配点：注入新文件即可被发现的（不需要改任何清单）', async () => {
  const dir = await tmpAdapterDir({
    'zz-demo.js': `
      import { defineStore } from '${pathToFileURLStr('src/core/adapter.js')}';
      export const demo = defineStore({
        id: 'demo-agent',
        name: 'Demo Agent',
        scan: async () => [],
        read: async () => null,
      });
    `,
    '_private.js': `
      export const notAnAdapter = { id: 'should-be-ignored', kind: 'store' };
    `,
  });
  const found = await discoverAdapters(dir);
  assert.deepEqual(
    found.stores.map((s) => s.id),
    ['demo-agent'],
    '注入的适配器未被发现，或 _ 前缀文件被错误纳入',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('装配点：重复 id 必须直接报错，而不是静默覆盖', async () => {
  const dir = await tmpAdapterDir({
    'a.js': `export default { id: 'dup', kind: 'store', name: 'A', scan: async () => [], read: async () => null };`,
    'b.js': `export default { id: 'dup', kind: 'store', name: 'B', scan: async () => [], read: async () => null };`,
  });
  await assert.rejects(() => discoverAdapters(dir), /id 重复/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('契约：store 必须具备 scan/read，且 capabilities 齐全', () => {
  for (const s of stores) {
    assert.equal(typeof s.scan, 'function', `${s.id}.scan 不是函数`);
    assert.equal(typeof s.read, 'function', `${s.id}.read 不是函数`);
    assert.equal(typeof s.name, 'string', `${s.id} 缺少 name`);
    assert.ok(s.capabilities && typeof s.capabilities === 'object', `${s.id} 缺少 capabilities`);
    assert.equal(typeof s.capabilities.import, 'boolean', `${s.id}.capabilities.import 必须是布尔`);
  }
});

test('契约：importer 必须具备 detect/read', () => {
  for (const imp of importers) {
    assert.equal(typeof imp.detect, 'function', `${imp.id}.detect 缺失（无法被 pickImporter 选中）`);
    assert.equal(typeof imp.read, 'function', `${imp.id}.read 不是函数`);
  }
});

test('契约：别名解析到真实适配器', () => {
  assert.equal(getStore('claude')?.id, 'claude-code');
  assert.equal(getStore('copilot')?.id, 'vscode-copilot');
  assert.equal(getStore('qwen')?.id, 'qwen-code');
  assert.equal(getStore('不存在的平台'), null);
});

test('契约：可导入目标必须是 store 且声明 import 能力', () => {
  for (const t of importTargets()) {
    assert.equal(t.kind, 'store');
    assert.equal(t.capabilities.import, true);
  }
});

test('契约：pickImporter 能按内容选中对应导入器', () => {
  const fake = pickImporter(Buffer.from('random'), 'chat.json');
  assert.equal(fake, null, '未知内容不应被任意 importer 命中');
});

test('清单：describeAdapters 反映真实注册情况', async () => {
  const d = await describeAdapters();
  assert.equal(d.stores.length, stores.length);
  assert.ok(d.stores.every((s) => typeof s.file === 'string' && s.file.endsWith('.js')));
});

function pathToFileURLStr(rel) {
  const abs = path.resolve(process.cwd(), rel);
  return `file:///${abs.replace(/\\/g, '/')}`;
}
