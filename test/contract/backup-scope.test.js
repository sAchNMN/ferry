/**
 * 契约测试：导入前的备份范围解析。
 *
 * 背景：备份范围原本写在 migrate.js 的 switch 里，每加一个平台就要改核心文件，
 * 是并行开发的一个隐性冲突点。现在改为"适配器声明优先、switch 回落"。
 * 这里锁住三件事：声明优先、回落不变、未知平台不越权（返回空而不是猜路径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { scopeFromStore, importScope } from '../../src/core/migrate.js';
import { getStore } from '../../src/core/registry.js';

const env = {
  home: path.join('/home', 'u'),
  platform: 'linux',
  cwd: '/work',
  codeUser: (app) => path.join('/home', 'u', '.config', app, 'User'),
  globalStorage: (app) => path.join('/home', 'u', '.config', app, 'User', 'globalStorage'),
};

test('备份范围：适配器声明优先于核心 switch', () => {
  const store = { id: 'codex', backupScope: () => ['/custom/a', '/custom/b'] };
  assert.deepEqual(scopeFromStore(store, env), ['/custom/a', '/custom/b']);
});

test('备份范围：声明返回空数组时不回落到 switch（明确表示不备份任何东西）', () => {
  const store = { id: 'codex', backupScope: () => [] };
  assert.deepEqual(scopeFromStore(store, env), []);
});

test('备份范围：声明返回非法值时不猜测，视为空', () => {
  assert.deepEqual(scopeFromStore({ id: 'x', backupScope: () => 'oops' }, env), []);
  assert.deepEqual(scopeFromStore({ id: 'x', backupScope: () => [null, '', '/good'] }, env), ['/good']);
});

test('备份范围：未声明的老平台走 switch 回落，路径不变', () => {
  const codex = scopeFromStore(getStore('codex'), env);
  assert.ok(codex.includes(path.join(env.home, '.codex', 'session_index.jsonl')));

  const cursor = scopeFromStore(getStore('cursor'), env);
  assert.equal(cursor.length, 2);
  assert.ok(cursor.every((p) => p.endsWith(path.join('globalStorage', 'state.vscdb'))));

  const copilot = scopeFromStore(getStore('copilot'), env); // 别名 → vscode-copilot
  assert.ok(copilot[0].endsWith(path.join('github.copilot-chat', 'session-store.db')));
});

test('备份范围：未知/不支持导入的平台返回空，不猜路径', () => {
  assert.deepEqual(scopeFromStore(null, env), []);
  assert.deepEqual(scopeFromStore({ id: 'no-such-agent' }, env), []);
  assert.deepEqual(scopeFromStore(getStore('aider'), env), []);
});

test('备份范围：importScope 与 scopeFromStore 结果一致', () => {
  assert.deepEqual(importScope('codex', env), scopeFromStore(getStore('codex'), env));
  assert.deepEqual(importScope('does-not-exist', env), []);
});
