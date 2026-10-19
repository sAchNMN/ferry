/**
 * 导入前备份 / 回滚。
 *
 * 这是 scope.md §4 第 7 条的执行者：**回滚必须能把目标目录还原到导入前的样子**。
 * 在此之前 `rollback` 零测试覆盖，只有一次人工点验的打算。
 *
 * 这里不测适配器，只测回滚语义本身：
 *   - 被覆盖的文件，回滚后内容必须与备份时刻逐字节一致；
 *   - 导入新建的文件，回滚后必须消失（不能留一堆孤儿会话）；
 *   - 导入时不存在、导入后由应用自己产生的 SQLite 边车文件，回滚后也不能留
 *     （否则旧主库配上新 WAL，SQLite 打开时会把迁移数据再应用一遍）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createBackup, listBackups, rollback } from '../../src/core/backup.js';
import { freshDir, makeEnv } from '../helpers.js';

async function write(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return file;
}

const read = (file) => fsp.readFile(file, 'utf8');
const exists = (file) => fsp.access(file).then(() => true, () => false);

test('回滚：被覆盖的文件恢复到备份时刻的内容', async () => {
  const home = await freshDir('rb-overwrite');
  const env = makeEnv(home);
  const db = await write(path.join(home, 'target', 'library.db'), 'ORIGINAL-CONTENT');

  const backup = await createBackup(env, { target: 'demo', writes: [{ path: db, kind: 'index' }] });

  // 模拟导入：把原文件改写
  await fsp.writeFile(db, 'MIGRATED-CONTENT-WITH-MORE-DATA');
  assert.equal(await read(db), 'MIGRATED-CONTENT-WITH-MORE-DATA');

  const res = await rollback(env, backup.id);
  assert.equal(await read(db), 'ORIGINAL-CONTENT', '回滚后必须与备份时刻逐字节一致');
  assert.deepEqual(
    res.results.filter((r) => r.action === 'failed'),
    [],
    '不应有任何失败项',
  );
});

test('回滚：导入新建的文件被删除，原有文件不受影响', async () => {
  const home = await freshDir('rb-created');
  const env = makeEnv(home);
  const existing = await write(path.join(home, 'target', 'keep.jsonl'), 'OLD-SESSION');
  const added = path.join(home, 'target', 'projects', 'new-session.jsonl');

  const backup = await createBackup(env, { target: 'demo', writes: [{ path: existing, kind: 'index' }] });

  // 模拟 importConversations：新建会话文件后补进清单（kind: 'created'）
  await write(added, 'NEW-SESSION');
  const manifestPath = path.join(backup.dir, 'backup.json');
  const manifest = JSON.parse(await read(manifestPath));
  manifest.files.push({ path: added, existed: false, backup: null, bytes: 0, kind: 'created' });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));

  const res = await rollback(env, backup.id);
  assert.equal(await exists(added), false, '导入新建的会话文件必须被删掉');
  assert.ok(res.results.some((r) => r.path === added && r.action === 'removed'));
  assert.equal(await read(existing), 'OLD-SESSION');
});

test('回滚：备份时就不存在的文件，回滚后仍然不存在', async () => {
  const home = await freshDir('rb-absent');
  const env = makeEnv(home);
  const future = path.join(home, 'target', 'not-yet.db');

  // createBackup 对"主文件不存在"会记一条 existed:false，回滚时按删除处理
  const backup = await createBackup(env, { target: 'demo', writes: [{ path: future, kind: 'index' }] });
  await write(future, 'CREATED-DURING-IMPORT');

  await rollback(env, backup.id);
  assert.equal(await exists(future), false, '导入期间凭空出现的文件，回滚后必须消失');
});

/**
 * 最容易漏的一种：`workbuddy.db` 关闭时没有 WAL，导入后用户启动应用，
 * 应用自己造出 `-wal` / `-shm`。回滚恢复旧主库却留下新 WAL，
 * SQLite 下次打开会把 WAL 里的事务再应用一遍 —— 等于回滚没生效。
 */
test('回滚：导入后应用产生的 SQLite 边车文件也要清掉', async () => {
  const home = await freshDir('rb-sidecar');
  const env = makeEnv(home);
  const db = await write(path.join(home, 'app', 'library.db'), 'DB-V1');
  const wal = path.join(home, 'app', 'library.db-wal');
  const shm = path.join(home, 'app', 'library.db-shm');

  // 备份时的真实状态：只有主库，没有边车（应用已正常退出）
  const backup = await createBackup(env, {
    target: 'demo',
    writes: [{ path: db, kind: 'index' }, { path: wal, kind: 'index' }, { path: shm, kind: 'index' }],
  });
  assert.equal(await exists(wal), false);

  // 导入 + 之后用户打开应用：主库被改写，并产生了 WAL / SHM
  await fsp.writeFile(db, 'DB-V2-AFTER-IMPORT');
  await write(wal, 'WAL-AFTER-IMPORT');
  await write(shm, 'SHM-AFTER-IMPORT');

  const res = await rollback(env, backup.id);
  assert.equal(await read(db), 'DB-V1');
  assert.equal(await exists(wal), false, '新产生的 WAL 必须删掉，否则会把迁移数据再应用回来');
  assert.equal(await exists(shm), false, '新产生的 SHM 同样要删掉');
  assert.deepEqual(
    res.results.filter((r) => r.action === 'failed'),
    [],
  );
});

/**
 * 纵深防御：调用方只声明主库时（例如新适配器忘了列边车），备份器也不能留尾巴。
 * 现在的实现只对"存在的"边车记录条目，"不存在的"直接跳过 ——
 * 于是导入后应用新造的 WAL 不会被清理，回滚就白做了。
 */
test('回滚：调用方只声明主库，备份器也要自己管边车文件', async () => {
  const home = await freshDir('rb-sidecar-implicit');
  const env = makeEnv(home);
  const db = await write(path.join(home, 'app', 'library.db'), 'DB-V1');
  const wal = `${db}-wal`;

  const backup = await createBackup(env, { target: 'demo', writes: [{ path: db, kind: 'index' }] });

  await fsp.writeFile(db, 'DB-V2');
  await write(wal, 'WAL-AFTER-IMPORT');

  await rollback(env, backup.id);
  assert.equal(await read(db), 'DB-V1');
  assert.equal(await exists(wal), false, '备份时不存在、导入后出现的 WAL 必须被清掉');
});

test('回滚：备份 ID 支持前缀，找不到时报清楚的错', async () => {
  const home = await freshDir('rb-lookup');
  const env = makeEnv(home);
  const file = await write(path.join(home, 'x.db'), 'A');
  const backup = await createBackup(env, { target: 'demo', writes: [{ path: file }] });

  const all = await listBackups(env);
  assert.equal(all.length, 1);
  await fsp.writeFile(file, 'B');

  await rollback(env, backup.id.slice(0, 6));
  assert.equal(await read(file), 'A', '只给前缀也要能定位到备份');

  await assert.rejects(() => rollback(env, 'no-such-backup'), /找不到备份/);
});

test('回滚：单个路径失败不影响其它文件，并把失败如实列出来', async () => {
  const home = await freshDir('rb-partial');
  const env = makeEnv(home);
  const good = await write(path.join(home, 'a.db'), 'GOOD-V1');
  // 一个目录冒充"导入新建的文件"：不带 recursive 的 rm 会失败
  const stuck = path.join(home, 'stuck');
  await fsp.mkdir(stuck, { recursive: true });
  await write(path.join(stuck, 'inner.txt'), 'x');

  const backup = await createBackup(env, { target: 'demo', writes: [{ path: good }] });
  await fsp.writeFile(good, 'GOOD-V2');

  const manifestPath = path.join(backup.dir, 'backup.json');
  const manifest = JSON.parse(await read(manifestPath));
  manifest.files = [{ path: stuck, existed: false, backup: null, bytes: 0, kind: 'created' }, ...manifest.files];
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));

  const res = await rollback(env, backup.id);
  assert.equal(await read(good), 'GOOD-V1', '前面的失败不能阻断后面的恢复');
  assert.ok(res.results.some((r) => r.path === stuck && r.action === 'failed'), '失败要如实记录');
});
