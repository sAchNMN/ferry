import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import codex from '../../../src/adapters/codex.js';
import { openDb } from '../../../src/core/sqlite.js';
import { createConversation, block } from '../../../src/core/ucm.js';
import { freshDir, makeEnv } from '../../helpers.js';

test('Codex Windows 索引：已带扩展路径前缀的 HOME 不应被重复加前缀', { skip: process.platform !== 'win32' }, async () => {
  const home = path.toNamespacedPath(await freshDir('codex-extended-home'));
  const dbFile = path.join(home, '.codex', 'state_5.sqlite');
  await fsp.mkdir(path.dirname(dbFile), { recursive: true });
  const db = await openDb(dbFile, { readOnly: false });
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run('seed', path.join(home, 'old.jsonl'));
  db.close();
  const conv = createConversation({ title: '路径测试', messages: [{ role: 'user', blocks: [block.text('继续')] }] });
  const imported = await codex.import(makeEnv(home), conv, {});
  const rollout = imported.writes.find((write) => write.kind === 'codex-rollout').path;
  const checkDb = await openDb(dbFile);
  const row = checkDb.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(imported.sessionId);
  checkDb.close();
  assert.ok(row, imported.notes.join('\n'));
  assert.equal(row.rollout_path, path.toNamespacedPath(rollout));
  assert.equal(await fsp.readFile(row.rollout_path, 'utf8'), await fsp.readFile(rollout, 'utf8'));
});
