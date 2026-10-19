/**
 * 导入前备份 / 回滚。
 *
 * 原生导入会写进别的软件的数据目录，必须可回滚：
 *   1. 覆盖前把原文件复制到 ~/.ferry/backups/<id>/files/
 *   2. 记录本次新建的文件，回滚时删除
 *   3. 导出 backup.json，ferry rollback <id> 一条命令恢复
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, formatBytes, nowIso, readJson, sha256, shortHash, writeJson } from './util.js';
import { backupsDir } from './env.js';

export async function createBackup(env, { target, writes, note }) {
  const id = `${nowIso().replace(/[-:T]/g, '').slice(0, 14)}-${shortHash(String(Date.now()), 6)}`;
  const dir = path.join(backupsDir(env), id);
  const filesDir = path.join(dir, 'files');
  await ensureDir(filesDir);

  const entries = [];
  let i = 0;
  for (const w of writes) {
    const file = w.path;
    if (!file) continue;
    // SQLite 的 WAL/SHM 也要一起备份，否则回滚可能丢掉最近写入
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      const existed = await exists(candidate);
      if (!existed) {
        if (candidate === file) entries.push({ path: file, existed: false, backup: null, bytes: 0, kind: w.kind || 'file' });
        continue;
      }
      const st = await fsp.stat(candidate).catch(() => null);
      if (!st?.isFile()) continue;
      const name = `${String(i++).padStart(3, '0')}-${path.basename(candidate).slice(0, 60)}`;
      const backup = path.join('files', name);
      await fsp.copyFile(candidate, path.join(dir, backup));
      entries.push({
        path: candidate,
        existed: true,
        backup,
        bytes: st.size,
        kind: candidate === file ? w.kind || 'file' : 'sqlite-sidecar',
      });
    }
  }

  const manifest = {
    id,
    createdAt: nowIso(),
    target,
    note: note || '',
    host: { platform: process.platform, home: env.home },
    files: entries,
    totalBytes: entries.reduce((a, e) => a + e.bytes, 0),
  };
  await writeJson(path.join(dir, 'backup.json'), manifest);
  return { id, dir, manifest };
}

export async function listBackups(env) {
  const root = backupsDir(env);
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = await readJson(path.join(root, e.name, 'backup.json'), null);
    if (manifest) out.push(manifest);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function rollback(env, id) {
  const root = backupsDir(env);
  let target = path.join(root, id);
  if (!(await exists(path.join(target, 'backup.json')))) {
    // 允许只给前缀
    const all = await listBackups(env);
    const hit = all.find((b) => b.id.startsWith(id));
    if (!hit) throw new Error(`找不到备份：${id}`);
    target = path.join(root, hit.id);
  }
  const manifest = await readJson(path.join(target, 'backup.json'));
  const results = [];
  for (const f of manifest.files || []) {
    try {
      if (f.existed && f.backup) {
        await ensureDir(path.dirname(f.path));
        await fsp.copyFile(path.join(target, f.backup), f.path);
        results.push({ path: f.path, action: 'restored' });
      } else if (!f.existed) {
        await fsp.rm(f.path, { force: true });
        results.push({ path: f.path, action: 'removed' });
      }
    } catch (err) {
      results.push({ path: f.path, action: 'failed', error: err.message });
    }
  }
  return { manifest, results };
}

export async function pruneBackups(env, keep = 10) {
  const all = await listBackups(env);
  const removed = [];
  for (const b of all.slice(keep)) {
    await fsp.rm(path.join(backupsDir(env), b.id), { recursive: true, force: true }).catch(() => {});
    removed.push(b.id);
  }
  return removed;
}

export function describeBackup(m) {
  return `${m.id}  ${formatBytes(m.totalBytes)}  ${m.files?.length || 0} 个文件  → ${m.target || '—'}`;
}

export function pathHash(p) {
  return sha256(p).slice(0, 12);
}
