/**
 * SQLite 薄封装（基于 Node 内置 node:sqlite，零依赖）。
 * 很多 Agent 用 SQLite 存会话：Cursor、Windsurf、Copilot Chat、Codex 的索引库……
 * 这里只做"读表结构 + 宽松写入"，把版本差异挡在适配器之外。
 */
import { FerryError } from './util.js';

let sqliteModule;

async function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  try {
    sqliteModule = await import('node:sqlite');
  } catch (err) {
    throw new FerryError('当前 Node 不支持内置 SQLite（需要 Node >= 22.5）', {
      code: 'ENOSQLITE',
      hint: '请升级 Node.js 到 22.5 以上，或使用 Ferry 自带的 Node 运行时。',
      cause: err,
    });
  }
  return sqliteModule;
}

export async function openDb(file, { readOnly = true } = {}) {
  const { DatabaseSync } = await loadSqlite();
  try {
    const db = new DatabaseSync(file, { readOnly });
    try {
      db.exec('PRAGMA busy_timeout = 4000');
    } catch {
      /* 只读库上也无妨 */
    }
    return db;
  } catch (err) {
    throw new FerryError(`打不开数据库：${file}`, {
      code: 'EDBOPEN',
      hint: '如果对应应用正在运行，请先退出它再试。',
      cause: err,
    });
  }
}

export function tableExists(db, table) {
  const row = db.prepare("select name from sqlite_master where type='table' and name=?").get(table);
  return Boolean(row);
}

export function listTables(db) {
  try {
    return db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  } catch {
    return [];
  }
}

export function columns(db, table) {
  return db.prepare(`pragma table_info("${table.replace(/"/g, '""')}")`).all();
}

/**
 * 宽松插入：列名/类型随版本变化时仍能工作。
 * - 未提供的列：有默认值就交给 SQLite
 * - NOT NULL 且无默认值：按类型补 0 / ''
 * - 提供 template（库中已有的一行）时，优先沿用该行的同名列，保证枚举值合法
 */
export function insertLoose(db, table, row, template = null) {
  const cols = columns(db, table);
  if (!cols.length) throw new FerryError(`表不存在：${table}`, { code: 'ENOTABLE' });
  const names = [];
  const values = [];
  const json = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);

  for (const c of cols) {
    if (row[c.name] !== undefined) {
      names.push(c.name);
      values.push(json(row[c.name]));
      continue;
    }
    if (template && template[c.name] !== undefined) {
      names.push(c.name);
      values.push(json(template[c.name]));
      continue;
    }
    if (c.dflt_value !== null) continue; // 交给默认值
    if (c.notnull) {
      names.push(c.name);
      const type = String(c.type || '').toUpperCase();
      values.push(/INT|REAL|NUM|BOOL/.test(type) ? 0 : '');
    }
  }

  const sql = `INSERT INTO "${table.replace(/"/g, '""')}" (${names
    .map((n) => `"${n.replace(/"/g, '""')}"`)
    .join(',')}) VALUES (${names.map(() => '?').join(',')})`;
  const stmt = db.prepare(sql);
  return stmt.run(...values);
}

/** 取一行作为模板（列齐全），空表返回 null。 */
export function sampleRow(db, table) {
  try {
    return db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 1`).get() || null;
  } catch {
    return null;
  }
}

export function countRows(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM "${table.replace(/"/g, '""')}"`).get().c;
  } catch {
    return 0;
  }
}

export function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}
