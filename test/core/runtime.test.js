import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshDir } from '../helpers.js';
import { openDb } from '../../src/core/sqlite.js';

test('CLI 运行时检查：在执行命令前拒绝缺少所需内置 API 的版本', async () => {
  const home = await freshDir('runtime-version');
  const preload = path.join(home, 'version.cjs');
  for (const [version, supported] of [['22.5.0', false], ['22.13.0', false], ['22.14.0', false], ['23.7.0', false], ['22.15.0', true], ['23.8.0', true]]) {
    await fsp.writeFile(preload, 'Object.defineProperty(process.versions, "node", { value: ' + JSON.stringify(version) + ' });');
    const result = spawnSync(process.execPath, ['--require', preload, path.resolve('bin/ferry.js'), '--version', '--home', home], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, supported ? 0 : 1, version + ': ' + result.stdout + result.stderr);
    if (!supported) assert.match(result.stderr, /22\.15.*23\.8/);
  }
});

test('SQLite 只读连接：拒绝写入并保持原始数据', async () => {
  const home = await freshDir('sqlite-readonly');
  const file = path.join(home, 'data.sqlite');
  const writable = await openDb(file, { readOnly: false });
  writable.exec("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('keep');");
  writable.close();
  const readonly = await openDb(file);
  try {
    assert.throws(() => readonly.exec("INSERT INTO data VALUES ('unexpected')"), /readonly|read-only/i);
    assert.deepEqual(readonly.prepare('SELECT value FROM data').all().map((row) => row.value), ['keep']);
  } finally {
    readonly.close();
  }
});
