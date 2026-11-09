import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshDir } from '../helpers.js';

async function launcherFixture() {
  const dir = path.join(await freshDir('launcher'), '启动 空格 & (路径) !bang!');
  await fsp.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fsp.copyFile(path.resolve('start.cmd'), path.join(dir, 'start.cmd'));
  await fsp.writeFile(path.join(dir, 'bin', 'ferry.js'), 'console.log(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)})); process.exitCode = 7;');
  return dir;
}

function launch(dir, args = '', extra = {}) {
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:on', '/s', '/c', 'start.cmd ' + args], {
    cwd: dir, windowsVerbatimArguments: true, env: { ...process.env, ...extra }, input: '\r\n', encoding: 'utf8', timeout: 15000,
  });
}

test('Windows 启动：含中文、空格和特殊符号的目录可启动，并保留参数与退出码', { skip: process.platform !== 'win32' }, async () => {
  const dir = await launcherFixture();
  const result = launch(dir, '--probe "D:\\中文 & (demo)"');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith('{')));
  assert.equal(output.cwd, dir);
  assert.deepEqual(output.args, ['--probe', 'D:\\中文 & (demo)']);
});

test('Windows 启动：检测到过旧的 Node 时给出版本提示', { skip: process.platform !== 'win32' }, async () => {
  const dir = await freshDir('launcher-old-node');
  await fsp.mkdir(path.join(dir, 'bin'));
  await fsp.copyFile(path.resolve('start.cmd'), path.join(dir, 'start.cmd'));
  await fsp.writeFile(path.join(dir, 'bin', 'ferry.js'), 'console.log("APP_STARTED")');
  for (const version of ['20.19.0', '22.5.0', '22.13.0', '22.14.0', '23.7.0']) {
    const preload = path.join(dir, 'old-node.cjs');
    await fsp.writeFile(preload, 'Object.defineProperty(process.versions, "node", { value: ' + JSON.stringify(version) + ' });');
    const result = launch(dir, '--probe', { NODE_OPTIONS: '--require="' + preload.replaceAll('\\', '/') + '"' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Node.js 22.15/, result.stderr);
    assert.ok(!result.stdout.includes('APP_STARTED'));
  }
});


test('Windows 启动：无参数启动 UI 后保留退出码', { skip: process.platform !== 'win32' }, async () => {
  const dir = await launcherFixture();
  const result = launch(dir);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith('{')));
  assert.equal(output.cwd, dir);
  assert.deepEqual(output.args, ['ui', '--open']);
});
