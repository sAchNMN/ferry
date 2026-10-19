/**
 * insertLoose 的模板语义：模板只用来满足 NOT NULL 约束。
 *
 * 背景（2026-10-19 真机复现）：WorkBuddy 写回时传的 template 是 `SELECT * ... LIMIT 1`，
 * 结果所有没显式赋值的列都被"随便那一行"的值填满 —— 迁移会话的 source_mode 从 craft
 * 变成 coding、permission_mode 从 fullAccess 变成 bypassPermissions。
 * 表结构随版本变可以理解，但复制业务字段不行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { insertLoose, sampleRow } from '../../src/core/sqlite.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source_mode TEXT,
      permission_mode TEXT,
      unread INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.prepare('INSERT INTO sessions (id,cwd,status,source_mode,permission_mode,unread) VALUES (?,?,?,?,?,?)')
    .run('old', 'C:/old', 'completed', 'coding', 'bypassPermissions', 0);
  return db;
}

test('insertLoose：模板不覆盖未提供的可空列', () => {
  const db = makeDb();
  const template = sampleRow(db, 'sessions');
  assert.equal(template.source_mode, 'coding', '前提：模板行确实带着别人的业务值');

  insertLoose(db, 'sessions', { id: 'new1', cwd: 'C:/new', status: 'completed' }, template);

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('new1');
  assert.equal(row.source_mode, null, 'source_mode 不该被模板污染');
  assert.equal(row.permission_mode, null, 'permission_mode 不该被模板污染');
});

test('insertLoose：NOT NULL 列仍由模板兜底，不会因缺列插入失败', () => {
  const db = makeDb();
  const template = sampleRow(db, 'sessions');

  // 只给主键，其余全靠模板与默认值 —— 必须不抛错
  assert.doesNotThrow(() => insertLoose(db, 'sessions', { id: 'new2' }, template));

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('new2');
  assert.equal(row.cwd, 'C:/old', 'NOT NULL 的 cwd 用模板值，避免约束失败');
  assert.equal(row.source_mode, null);
});

test('insertLoose：显式传 null 就是 null，模板不得改写', () => {
  const db = makeDb();
  const template = sampleRow(db, 'sessions');

  insertLoose(db, 'sessions', { id: 'new3', cwd: 'C:/new', status: 'completed', source_mode: null }, template);

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('new3');
  assert.equal(row.source_mode, null);
  assert.equal(row.permission_mode, null);
});
