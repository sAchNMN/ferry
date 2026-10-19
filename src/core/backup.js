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
import { forgetImports } from './ledger.js';

/** 只对 SQLite 数据库文件派生 WAL / SHM 边车，避免给普通文本文件凭空造条目。 */
const SQLITE_EXT = new Set(['.db', '.sqlite', '.sqlite3']);

function sidecarsOf(file) {
  return SQLITE_EXT.has(path.extname(file).toLowerCase()) ? [`${file}-wal`, `${file}-shm`] : [];
}

export async function createBackup(env, { target, writes, note }) {
  const id = `${nowIso().replace(/[-:T]/g, '').slice(0, 14)}-${shortHash(String(Date.now()), 6)}`;
  const dir = path.join(backupsDir(env), id);
  const filesDir = path.join(dir, 'files');
  await ensureDir(filesDir);

  const entries = [];
  const seen = new Set();
  let i = 0;

  const capture = async (candidate, kind) => {
    // 调用方可能把边车也单独列进 writes（WorkBuddy 就是这么声明的），
    // 这里去重，避免同一个文件被备份两三份、回滚时重复拷贝。
    if (seen.has(candidate)) return;
    seen.add(candidate);
    const st = await fsp.stat(candidate).catch(() => null);
    if (st && !st.isFile()) return; // 目录之类不归备份器管，别在清单里留一条假的删除项
    if (!st) {
      // 不存在的路径也要记一条：回滚时按"删除"处理。
      // 这条对边车尤其重要 —— 导入前没有 WAL、导入后应用自己造了一个，
      // 只恢复旧主库却留下新 WAL，SQLite 打开时会把迁移数据再应用一遍。
      entries.push({ path: candidate, existed: false, backup: null, bytes: 0, kind });
      return;
    }
    const name = `${String(i++).padStart(3, '0')}-${path.basename(candidate).slice(0, 60)}`;
    const backup = path.join('files', name);
    await fsp.copyFile(candidate, path.join(dir, backup));
    entries.push({ path: candidate, existed: true, backup, bytes: st.size, kind });
  };

  for (const w of writes) {
    const file = w.path;
    if (!file) continue;
    const kind = w.kind || 'file';
    const mainSt = await fsp.stat(file).catch(() => null);
    await capture(file, kind);
    // 主文件本来就不存在时不会凭空长出边车，不用记
    if (!mainSt?.isFile()) continue;
    for (const sidecar of sidecarsOf(file)) await capture(sidecar, 'sqlite-sidecar');
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

/**
 * 从被删掉的路径里反推会话 id。
 *
 * 新备份的清单里有 `imported`（指纹 + sessionId），直接可用。
 * 但**旧备份没有这个字段**（2026-10-19 之前的版本），如果只认 imported，
 * 回滚旧备份后重导还是会被台账挡住。两种会话文件名都以 UUID 结尾，兜底从这里取：
 *   WorkBuddy  projects/<slug>/<uuid>.jsonl
 *   Codex      sessions/2026/10/19/rollout-2026-10-19T13-40-34-<uuid>.jsonl
 */
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function sessionIdsFromPaths(paths) {
  const ids = new Set();
  for (const p of paths) {
    const hit = UUID_RE.exec(path.basename(p));
    if (hit) ids.add(hit[1]);
  }
  return [...ids];
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

  // 台账跟着回滚：被删掉的会话如果还留在"已导入"名单里，下次导入会被幂等直接跳过，
  // 用户看到"已导入过"却找不到会话。旧备份没有 imported 字段，用文件名兜底反推。
  // imported 里也可能是 null（适配器曾漏返顶层 sessionId），过滤后再判断一次。
  const removedPaths = results.filter((r) => r.action === 'removed').map((r) => r.path);
  const fromManifest = (manifest.imported || []).map((entry) => entry.sessionId).filter(Boolean);
  const sessionIds = fromManifest.length ? fromManifest : sessionIdsFromPaths(removedPaths);
  const forgotten = await forgetImports(env, manifest.target, sessionIds);

  return { manifest, results, forgotten };
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
