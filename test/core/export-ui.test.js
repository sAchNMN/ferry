import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { startServer } from '../../src/server.js';
import { readPack } from '../../src/core/archive.js';
import { openFolder } from '../../src/core/open-folder.js';
import { freshDir, makeEnv, seedCodex, write } from '../helpers.js';

async function setup(t, options = {}) {
  const home = await freshDir('export-ui');
  const env = makeEnv(home);
  const opened = [];
  const server = await startServer({ env, port: 0, log: { error() {} }, openFolder: async (dir) => opened.push(dir), ...options });
  t.after(() => server.close());
  const request = (route, { body, auth = true, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(new URL(route, server.url), {
    method,
    headers: { ...(auth ? { 'x-ferry-token': server.token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { home, env, server, request, opened };
}

test('导出：分阶段实时进度、加密项目归档以及成功结果', async (t) => {
  const { home, env, request } = await setup(t);
  const project = path.join(home, 'project');
  await write(path.join(project, 'demo.txt'), 'project-content');
  await seedCodex(home, project);
  const res = await request('/api/export', { body: { agents: ['codex'], projects: true, password: 'test-password' }, headers: { accept: 'application/x-ndjson' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"type":"progress"/);
  const chunks = [first.value];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const events = Buffer.concat(chunks).toString().trim().split('\n').map((line) => JSON.parse(line));
  const progress = events.filter((item) => item.type === 'progress');
  assert.ok(progress.some((item) => item.done === 1 && item.total === 1));
  for (const stage of ['扫描', '收集项目', '压缩', '加密', '保存']) assert.ok(progress.some((item) => item.message.includes(stage)), stage);
  assert.equal(events.at(-1).type, 'result');
  const result = events.at(-1).result;
  assert.equal(result.summary.conversations, 1);
  assert.equal(result.directory, path.join(env.ferryHome, 'exports'));
  const pack = await readPack(path.join(result.directory, result.file), { password: 'test-password' });
  assert.equal(pack.conversations.length, 1);
  assert.equal(pack.projects[0].files[0].data.toString(), 'project-content');
  const list = await (await request('/api/exports')).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].bytes, result.bytes);
});

test('导出：项目快照支持请求体与 config.json 里的额外排除', async (t) => {
  const { home, env, request } = await setup(t);
  const project = path.join(home, 'project');
  await write(path.join(project, 'keep.txt'), 'keep');
  await write(path.join(project, 'drop.log'), 'drop');
  await seedCodex(home, project);

  const first = await (await request('/api/export', { body: { agents: ['codex'], projects: true, excludePaths: ['*.log'] } })).json();
  const packA = await readPack(path.join(first.directory, first.file));
  assert.deepEqual(packA.projects[0].files.map((file) => file.path), ['keep.txt']);

  await write(path.join(env.ferryHome, 'config.json'), JSON.stringify({ excludePaths: ['keep.txt'] }));
  const second = await (await request('/api/export', { body: { agents: ['codex'], projects: true } })).json();
  const packB = await readPack(path.join(second.directory, second.file));
  assert.deepEqual(packB.projects[0].files.map((file) => file.path), ['drop.log']);
});

test('导出：兼容 JSON 响应；空范围通过流报告错误且不生成包', async (t) => {
  const { home, request } = await setup(t);
  const empty = await request('/api/export', { body: { agents: ['codex'] }, headers: { accept: 'application/x-ndjson' } });
  const events = (await empty.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error, /没有会话/);
  assert.equal((await (await request('/api/exports')).json()).items.length, 0);
  assert.equal((await request('/api/export', { body: { agents: ['codex'] } })).status, 400);
  await seedCodex(home);
  const result = await request('/api/export', { body: { agents: ['codex'] } });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).summary.conversations, 1);
});

test('导出包：历史列表、资源管理器打开、删除以及路径边界', async (t) => {
  const { env, request, opened } = await setup(t);
  const directory = path.join(env.ferryHome, 'exports');
  await write(path.join(directory, 'old.ferrypack'), 'old');
  await write(path.join(directory, 'keep.txt'), 'keep');
  await fsp.mkdir(path.join(directory, 'directory.ferrypack'));
  await write(path.join(env.ferryHome, 'backups', 'keep.ferrypack'), 'backup');
  const list = await (await request('/api/exports')).json();
  assert.deepEqual(list.items.map((item) => item.file), ['old.ferrypack']);
  assert.equal((await request('/api/exports/open', { body: { file: 'old.ferrypack' } })).status, 200);
  assert.deepEqual(opened, [directory]);
  for (const file of ['../keep.ferrypack', '..\\keep.ferrypack', 'C:\\keep.ferrypack', 'x:keep.ferrypack', 'keep.txt', '', null, 1]) {
    for (const action of ['open', 'delete']) assert.equal((await request('/api/exports/' + action, { body: { file } })).status, 400, String(file));
  }
  assert.equal((await request('/api/exports/delete', { body: { file: 'directory.ferrypack' } })).status, 404);
  assert.equal((await request('/api/exports/delete', { body: { file: 'old.ferrypack' } })).status, 200);
  assert.equal((await request('/api/exports/delete', { body: { file: 'old.ferrypack' } })).status, 404);
  assert.equal((await request('/api/exports/open', { body: { file: 'old.ferrypack' } })).status, 404);
  assert.equal(await fsp.readFile(path.join(env.ferryHome, 'backups', 'keep.ferrypack'), 'utf8'), 'backup');
});

test('缓存：清理上传临时文件、过期上传令牌，但保留包/备份/配置/导入记录/原始数据', async (t) => {
  const { home, env, request } = await setup(t);
  const preserved = ['exports/keep.ferrypack', 'backups/keep.json', 'config.json', 'imported.json'];
  for (const file of preserved) await write(path.join(env.ferryHome, file), 'keep');
  const original = await write(path.join(home, '.codex', 'keep.jsonl'), 'original');
  await write(path.join(env.ferryHome, 'uploads', 'stale.json'), 'stale');
  const upload = await (await request('/api/upload?name=example.json', { body: { test: 'data' } })).json();
  const before = await (await request('/api/cache')).json();
  assert.equal(before.files, 2);
  assert.ok(before.bytes > 5);
  assert.deepEqual(await (await request('/api/cache/clear', { body: {} })).json(), before);
  assert.deepEqual(await (await request('/api/cache')).json(), { files: 0, bytes: 0 });
  assert.equal((await request('/api/inspect', { body: { token: upload.token } })).status, 404);
  for (const file of preserved) assert.equal(await fsp.readFile(path.join(env.ferryHome, file), 'utf8'), 'keep');
  assert.equal(await fsp.readFile(original, 'utf8'), 'original');
  assert.deepEqual(await (await request('/api/cache/clear', { body: {} })).json(), { files: 0, bytes: 0 });
  assert.equal((await request('/api/upload?name=new.json', { body: {} })).status, 200);
});

test('管理接口均校验令牌，不允许无权限打开、删除或清理', async (t) => {
  const { env, request, opened } = await setup(t);
  await write(path.join(env.ferryHome, 'exports', 'keep.ferrypack'), 'keep');
  await write(path.join(env.ferryHome, 'uploads', 'keep.json'), 'keep');
  for (const route of ['/api/exports', '/api/cache']) assert.equal((await request(route, { auth: false })).status, 403);
  for (const route of ['/api/exports/open', '/api/exports/delete', '/api/cache/clear']) {
    assert.equal((await request(route, { auth: false, body: { file: 'keep.ferrypack' } })).status, 403);
  }
  assert.equal(opened.length, 0);
  assert.equal(await fsp.readFile(path.join(env.ferryHome, 'exports', 'keep.ferrypack'), 'utf8'), 'keep');
  assert.equal((await (await request('/api/cache')).json()).files, 1);
});

test('有其他操作时禁止清理，操作结束后恢复；文件管理器启动错误可见', async (t) => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { env, request } = await setup(t, { openFolder: async () => { entered(); await gate; throw new Error('无法启动文件管理器'); } });
  await write(path.join(env.ferryHome, 'exports', 'keep.ferrypack'), 'keep');
  const opening = request('/api/exports/open', { body: { file: 'keep.ferrypack' } });
  await waiting;
  try {
    const response = await request('/api/cache/clear', { body: {} });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /正在进行/);
  } finally {
    release();
  }
  const failed = await opening;
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /无法启动/);
  assert.equal((await request('/api/cache/clear', { body: {} })).status, 200);
});

test('安全：拒绝被替换为目录链接的上传和导出目录，不触及目录外文件', async (t) => {
  const { home, env, request } = await setup(t);
  const outside = path.join(home, 'outside');
  await write(path.join(outside, 'keep.ferrypack'), 'keep');
  for (const name of ['exports', 'uploads']) {
    const directory = path.join(env.ferryHome, name);
    await fsp.rmdir(directory);
    await fsp.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  }
  assert.equal((await request('/api/exports')).status, 400);
  assert.equal((await request('/api/exports/delete', { body: { file: 'keep.ferrypack' } })).status, 400);
  assert.equal((await request('/api/cache/clear', { body: {} })).status, 400);
  assert.equal((await request('/api/upload?name=outside.json', { body: {} })).status, 400);
  assert.deepEqual(await fsp.readdir(outside), ['keep.ferrypack']);
  assert.equal(await fsp.readFile(path.join(outside, 'keep.ferrypack'), 'utf8'), 'keep');
});

function fakeSpawn({ codes = [], errors = [] } = {}) {
  const calls = [];
  const spawnProcess = (cmd, args, options) => {
    const index = calls.length;
    const call = { cmd, args, options, killed: false };
    calls.push(call);
    const child = new EventEmitter();
    let unref = false;
    child.unref = () => { unref = true; };
    child.wasUnref = () => unref;
    child.kill = () => { call.killed = true; };
    if (codes[index] !== 'hang') {
      queueMicrotask(() => {
        if (errors[index]) child.emit('error', errors[index]);
        else child.emit('exit', codes[index] ?? 0, null);
      });
    }
    return child;
  };
  return { calls, spawnProcess };
}

test('打开文件夹：GUI 启动器不带 windowsHide，explorer 失败回退 PowerShell，超时不算成功', async () => {
  const directory = 'C:\\含 空格 & test\\exports';

  // 正常路径：explorer.exe 返回 1 也算成功，只启动一次。
  {
    const { calls, spawnProcess } = fakeSpawn({ codes: [1] });
    await openFolder(directory, { platform: 'win32', spawnProcess });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'explorer.exe');
    assert.deepEqual(calls[0].args, [directory]);
    // windowsHide 会让 libuv 传 SW_HIDE，导致窗口被创建成不可见（本次 bug 的根因）。
    assert.equal(calls[0].options.windowsHide, undefined);
    assert.equal(calls[0].options.shell, undefined);
    assert.ok(calls[0].options.detached);
  }

  // explorer 若一直存活，说明是“这次由它充当 shell”的极端情况，窗口已出现，按成功处理。
  {
    const { calls, spawnProcess } = fakeSpawn({ codes: ['hang'] });
    await openFolder(directory, { platform: 'win32', spawnProcess, timeoutMs: 20 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].killed, false);
  }

  // 0xC0000142：explorer 起不来，回退到 PowerShell Start-Process，而不是假装成功。
  {
    const { calls, spawnProcess } = fakeSpawn({ codes: [0xc0000142, 0] });
    await openFolder(directory, { platform: 'win32', spawnProcess });
    assert.equal(calls.length, 2);
    assert.match(calls[1].cmd, /powershell(\.exe)?$/i);
    assert.deepEqual(calls[1].args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const command = Buffer.from(calls[1].args.at(-1), 'base64').toString('utf16le');
    // 单引号包裹，路径里的引号字符必须翻倍，避免命令注入。
    assert.ok(command.includes(`Start-Process '${directory}'`));
    assert.equal(calls[1].options.windowsHide, undefined);
    assert.equal(calls[1].options.shell, undefined);
  }

  // 兜底命令挂住不退出：杀掉并按失败上报，绝不把它当成功。
  {
    const { calls, spawnProcess } = fakeSpawn({ codes: [0xc0000142, 'hang'] });
    await assert.rejects(
      openFolder(directory, { platform: 'win32', spawnProcess, timeoutMs: 20, fallbackTimeoutMs: 20 }),
      /无法打开文件夹/,
    );
    assert.equal(calls[1].killed, true);
  }

  // 两种方式都失败：抛错并带上路径与排查提示，让前端如实报错。
  {
    const { spawnProcess } = fakeSpawn({ codes: [0xc0000142, 1] });
    await assert.rejects(openFolder(directory, { platform: 'win32', spawnProcess }), (err) => {
      assert.match(err.message, /无法打开文件夹/);
      assert.ok(err.message.includes(directory));
      assert.match(err.message, /管理员/);
      return true;
    });
  }

  for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open']]) {
    const { calls, spawnProcess } = fakeSpawn({ codes: [0] });
    await openFolder(directory, { platform, spawnProcess });
    assert.equal(calls[0].cmd, command);
    assert.deepEqual(calls[0].args, [directory]);
    assert.equal(calls[0].options.windowsHide, undefined);
    assert.equal(calls[0].options.shell, undefined);

    const failing = fakeSpawn({ codes: [3] });
    await assert.rejects(openFolder(directory, { platform, spawnProcess: failing.spawnProcess }), /无法打开文件夹/);
  }

  await assert.rejects(openFolder('/tmp/example', { platform: 'linux', spawnProcess: fakeSpawn({ errors: [new Error('ENOENT')] }).spawnProcess }), /ENOENT/);
});

test('前端：处理跨块中文/多行进度、错误流和连接中断', async () => {
  const source = await fsp.readFile(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('async function exportWithProgress'), source.indexOf('function showExportProgress'));
  const progress = [];
  const run = (text, status = 200) => {
    const data = new TextEncoder().encode(text);
    const body = new ReadableStream({ start(controller) {
      for (let i = 0; i < data.length; i += 7) controller.enqueue(data.slice(i, i + 7));
      controller.close();
    } });
    const context = vm.createContext({ TOKEN: 'test-token', TextDecoderStream, fetch: async (_, opts) => {
      assert.equal(opts.headers['x-ferry-token'], 'test-token');
      assert.equal(opts.headers.accept, 'application/x-ndjson');
      return new Response(body, { status });
    } });
    const fn = vm.runInContext(functionSource + '; exportWithProgress;', context);
    return fn({}, (event) => progress.push(event));
  };
  const result = await run('{"type":"progress","message":"正在压缩"}\n{"type":"result","result":{"file":"test.ferrypack"}}');
  assert.equal(result.file, 'test.ferrypack');
  assert.equal(progress[0].message, '正在压缩');
  await assert.rejects(run('{"type":"error","error":"导出失败"}\n'), /导出失败/);
  await assert.rejects(run('{"type":"progress","message":"扫描中"}\n'), /连接中断/);
  await assert.rejects(run('{"error":"请稍后重试"}', 409), /请稍后重试/);
});
