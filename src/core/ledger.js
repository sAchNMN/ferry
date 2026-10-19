/**
 * 导入台账：记录"哪个会话已经导入到哪个目标"，用于幂等。
 *
 * 为什么需要台账，而不是"导入前扫一遍目标比对指纹"：
 *   导入会重写 sessionId（目标应用要求自己的 id 空间），导入后的会话指纹与源端对不上，
 *   扫描比对无法直接匹配。要匹配就得存一张"源指纹 → 目标 id"的映射 —— 那本质就是台账，
 *   只是藏得更深。所以这里直接做台账，位置和格式都显式。
 *
 * 台账是**缓存，不是真相**：
 *   - 用户在目标应用里删掉了会话，台账不会自动感知 → 提供 --force 强制重导；
 *   - 台账损坏或版本不认识 → 按空处理并告警，绝不因为台账坏了就阻断迁移。
 *
 * 位置：`<ferryHome>/imported.json`（默认 `~/.ferry/imported.json`）
 */
import path from 'node:path';
import { existsSync, nowIso, readJson, writeJson } from './util.js';

export const LEDGER_VERSION = 1;

export function ledgerPath(env) {
  return path.join(env.ferryHome || path.join(env.home, '.ferry'), 'imported.json');
}

/** 读台账。坏文件不抛错，返回空台账并告警。 */
export async function readLedger(env, { log } = {}) {
  const file = ledgerPath(env);
  const empty = { version: LEDGER_VERSION, targets: {} };
  if (!existsSync(file)) return empty;

  let raw;
  try {
    raw = await readJson(file, null);
  } catch (err) {
    log?.warn?.(`导入台账读取失败，按空处理：${err.message}`);
    return empty;
  }
  if (!raw || typeof raw !== 'object' || !raw.targets || typeof raw.targets !== 'object') {
    log?.warn?.(`导入台账格式异常，按空处理：${file}`);
    return empty;
  }
  return { version: raw.version || LEDGER_VERSION, targets: raw.targets };
}

/** 查某个指纹在某个目标下是否已导入过。 */
export function lookupImport(ledger, target, fingerprint) {
  return ledger?.targets?.[target]?.[fingerprint] || null;
}

/**
 * 批量登记一次导入的结果。
 * @param {object} env
 * @param {string} target 目标适配器 id
 * @param {Record<string, object>} entries 指纹 → { sessionId, writes, at }
 */
export async function recordImports(env, target, entries) {
  const keys = Object.keys(entries || {});
  if (!keys.length) return null;
  const ledger = await readLedger(env);
  ledger.targets[target] = { ...(ledger.targets[target] || {}), ...entries };
  ledger.version = LEDGER_VERSION;
  ledger.updatedAt = nowIso();
  await writeJson(ledgerPath(env), ledger);
  return ledger;
}
