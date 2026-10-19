/**
 * 迁移编排：导出（扫描 → 归一化 → 归档）与导入（解包 → 路径映射 → 原生写入）。
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getStore, scanStores } from './registry.js';
import { safeRead } from './adapter.js';
import { createBlobStore } from './archive.js';
import { createConversation, conversationStats, redactConversation, validateConversation } from './ucm.js';
import { createBackup } from './backup.js';
import { existsSync, nowIso, pathKey, readJson, writeJson } from './util.js';

/* ------------------------------------------------------------------ */
/* 路径映射                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析 "旧路径=新路径" 规则。
 * @returns {{from:string,to:string}[]}
 */
export function compileMappings(rules = []) {
  const out = [];
  for (const rule of rules) {
    if (!rule) continue;
    const idx = rule.indexOf('=');
    if (idx <= 0) continue;
    const from = rule.slice(0, idx).trim();
    const to = rule.slice(idx + 1).trim();
    if (from && to) out.push({ from, to });
  }
  return out.sort((a, b) => b.from.length - a.from.length);
}

export function mapPath(p, mappings = []) {
  if (!p) return p;
  const norm = String(p).replace(/\//g, '\\');
  for (const { from, to } of mappings) {
    const f = from.replace(/\//g, '\\').replace(/\\+$/, '');
    const n = norm.replace(/\\+$/, '');
    if (n === f || n.toLowerCase() === f.toLowerCase()) return to;
    if (n.toLowerCase().startsWith(f.toLowerCase() + '\\')) {
      const rest = norm.slice(from.replace(/\//g, '\\').replace(/\\+$/, '').length + 1);
      return path.join(to, rest);
    }
  }
  return p;
}

export function basenameAny(p) {
  if (!p) return 'project';
  return String(p).includes('\\') ? path.win32.basename(p) : path.basename(p);
}

/** 决定这次导入要落到哪个项目目录。 */
export function resolveWorkspace(conv, opts, env) {
  const original = conv.workspace?.cwd || conv.workspace?.roots?.[0];
  const explicit = opts.workspace;
  if (original && opts.map?.length) {
    const mapped = mapPath(original, opts.map);
    if (mapped !== original) return { cwd: mapped, reason: 'map', original };
  }
  if (explicit) return { cwd: explicit, reason: 'workspace', original };
  if (original && existsSync(original)) return { cwd: original, reason: 'same-machine', original };
  if (original && opts.into) return { cwd: path.join(opts.into, basenameAny(original)), reason: 'into', original };
  if (original) return { cwd: original, reason: 'unverified', original };
  return { cwd: env.cwd, reason: 'cwd', original };
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function parseSince(since) {
  if (!since) return null;
  const m = /^(\d+)\s*([dhwm])$/i.exec(String(since).trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[unit];
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} env
 * @param {object} opts
 * @param {string[]} [opts.agents]
 * @param {string[]} [opts.ids]        会话 id / 标题关键字
 * @param {string} [opts.since]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.redact]
 * @param {boolean} [opts.includeSidechain]
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function collectForExport(env, opts = {}) {
  const { log, onProgress } = opts;
  const scan = await scanStores(env, { only: opts.agents || [], log });
  const picked = [];
  for (const r of scan.results) {
    for (const s of r.sessions) {
      if (opts.agents?.length && !opts.agents.includes(r.adapter)) continue;
      if (opts.ids?.length) {
        const hit = opts.ids.some((q) => s.id === q || s.id.includes(q) || (s.title || '').includes(q));
        if (!hit) continue;
      }
      if (opts.since) {
        const t = parseSince(opts.since);
        if (t && s.updatedAt && new Date(s.updatedAt) < t) continue;
      }
      picked.push({ adapter: r.adapter, ref: s });
    }
  }
  picked.sort((a, b) => String(b.ref.updatedAt || '').localeCompare(String(a.ref.updatedAt || '')));
  if (opts.limit && picked.length > opts.limit) picked.length = opts.limit;

  if (!picked.length) {
    return {
      conversations: [],
      blobs: createBlobStore(),
      errors: scan.errors,
      scanned: scan.totalSessions,
      candidates: 0,
    };
  }

  const blobs = createBlobStore();
  const conversations = [];
  const errors = [...scan.errors];
  let processed = 0;

  for (const { adapter: adapterId, ref } of picked) {
    const store = getStore(adapterId);
    const ctx = { blobs, env, log, store };
    const r = await safeRead(store, env, ref, ctx);
    processed++;
    onProgress?.({ done: processed, total: picked.length, adapter: adapterId, title: ref.title });
    if (!r.ok) {
      errors.push({ adapter: adapterId, error: r.error.message, detail: r.error.hint, title: ref.title });
      continue;
    }
    let conv = r.conv;
    if (!opts.includeSidechain) {
      conv.messages = conv.messages.filter((m) => !m.meta?.sidechain);
    }
    if (opts.last && conv.messages.length > opts.last) {
      conv.messages = conv.messages.slice(-opts.last);
      conv.stats = conversationStats(conv);
    }
    conv.meta = {
      ...(conv.meta || {}),
      exportedAt: nowIso(),
      exporter: 'ferry',
      ...(ref.meta?.archived ? { archived: true } : {}),
    };
    if (opts.redact) {
      const red = redactConversation(conv);
      conv = red.conversation;
      const total = Object.values(red.hits).reduce((a, b) => a + b, 0);
      if (total) conv.meta.redacted = red.hits;
    }
    const { conversation } = validateConversation(conv);
    conversations.push(conversation);
  }

  return {
    conversations,
    blobs,
    errors,
    scanned: scan.totalSessions,
    candidates: picked.length,
  };
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 各适配器在导入时会"原地修改"的索引文件（需要备份）。新建的会话文件不需要。
 *
 * 迁移期策略：
 *   - 适配器若声明了 `backupScope(env)`，优先用它的声明；
 *   - 否则回落到下面的 switch（历史遗留，仅覆盖已有平台）。
 * 新平台**不要**往 switch 里加 case —— 在自己的适配器里声明 `backupScope` 即可，
 * 这样不会有人为了加平台而改本文件（见 docs/contract/ownership.md）。
 */
export function scopeFromStore(store, env) {
  if (!store) return [];
  if (typeof store.backupScope === 'function') {
    const declared = store.backupScope(env);
    return Array.isArray(declared) ? declared.filter(Boolean) : [];
  }
  return legacyBackupScope(store.id, env);
}

/** @deprecated 仅作回落，新平台请用适配器的 `backupScope` 声明。 */
function legacyBackupScope(adapterId, env) {
  const scope = [];
  const add = (p) => p && scope.push(p);
  switch (adapterId) {
    case 'codex': {
      add(path.join(env.home, '.codex', 'session_index.jsonl'));
      // state_N.sqlite 的版本号会随 Codex 升级变化，动态发现
      try {
        for (const f of fs.readdirSync(path.join(env.home, '.codex'))) {
          if (/^state_\d+\.sqlite$/.test(f)) add(path.join(env.home, '.codex', f));
        }
      } catch {
        /* 目录不存在时忽略 */
      }
      break;
    }
    case 'vscode-copilot': {
      add(path.join(env.codeUser('code'), 'globalStorage', 'github.copilot-chat', 'session-store.db'));
      break;
    }
    case 'cursor': {
      for (const host of ['cursor', 'cursorNightly']) {
        add(path.join(env.globalStorage(host), 'state.vscdb'));
      }
      break;
    }
    case 'continue': {
      add(path.join(env.home, '.continue', 'sessions.json'));
      break;
    }
    case 'gemini-cli': {
      add(path.join(env.home, '.gemini', 'projects.json'));
      break;
    }
    case 'qwen-code': {
      add(path.join(env.home, '.qwen', 'projects.json'));
      break;
    }
    case 'iflow': {
      add(path.join(env.home, '.iflow', 'projects.json'));
      break;
    }
    default:
      break;
  }
  return scope;
}

/**
 * 兼容旧入口：按适配器 id 解析备份范围。
 * 保留这个签名是为了不动 migrate.js 里既有的调用点。
 */
export function importScope(adapterId, env, convs = []) {
  return scopeFromStore(getStore(adapterId), env);
}

/**
 * @param {object} env
 * @param {object[]} conversations
 * @param {object} opts
 * @param {string} opts.target            目标适配器 id
 * @param {string} [opts.workspace]
 * @param {string[]} [opts.map]
 * @param {string} [opts.into]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.backup]
 * @param {Map<string,{data:Buffer,mime:string,name:string}>} [opts.blobs]
 */
export async function importConversations(env, conversations, opts = {}) {
  const { log, onProgress } = opts;
  const store = getStore(opts.target);
  if (!store) throw new Error(`未知的目标：${opts.target}`);
  if (!store.capabilities.import) {
    throw new Error(`${store.name} 暂不支持原生导入，可改用交接包（--to handoff）`);
  }

  const filtered = conversations.filter((c) => c.messages?.length);
  const results = [];
  let backupInfo = null;
  const knownPaths = new Set();
  const createdPaths = [];

  if (opts.backup !== false && !opts.dryRun) {
    const scope = importScope(store.id, env);
    backupInfo = await createBackup(env, {
      target: store.id,
      note: `导入 ${filtered.length} 个会话前自动备份`,
      writes: scope.map((p) => ({ path: p, kind: 'index' })),
    });
    for (const f of backupInfo.manifest.files || []) knownPaths.add(f.path);
  }

  let i = 0;
  for (const conv of filtered) {
    i++;
    const ws = resolveWorkspace(conv, opts, env);
    const notes = [];
    if (ws.original && ws.reason === 'unverified' && !existsSync(ws.cwd)) {
      notes.push(`原项目路径在本机不存在：${ws.original}（会话会记录该路径，打开时可能提示找不到目录）`);
    }
    if (ws.original && ws.reason === 'map') notes.push(`路径已映射：${ws.original} → ${ws.cwd}`);
    try {
      const res = await store.import(
        env,
        conv,
        {
          workspace: ws.cwd,
          blobs: opts.blobs,
          dryRun: opts.dryRun,
          log,
          agent: opts.agentVariant,
        },
      );
      results.push({
        title: conv.title,
        source: conv.source.name,
        workspace: ws.cwd,
        writes: res.writes || [],
        notes: [...notes, ...(res.notes || [])],
        resume: res.resume,
        error: null,
      });
      // 记录本次新建的文件，回滚时删除（UUID 命名，不会覆盖已有会话）
      for (const w of res.writes || []) {
        if (!w.path || knownPaths.has(w.path)) continue;
        knownPaths.add(w.path);
        createdPaths.push(w.path);
      }
    } catch (err) {
      results.push({
        title: conv.title,
        source: conv.source.name,
        workspace: ws.cwd,
        writes: [],
        notes,
        error: err.message,
      });
    }
    onProgress?.({ done: i, total: filtered.length, title: conv.title });
  }

  if (backupInfo && createdPaths.length) {
    // 把"本次新建"的文件补进备份清单，rollback 时删除它们
    const manifestPath = path.join(backupInfo.dir, 'backup.json');
    const manifest = (await readJson(manifestPath, null)) || backupInfo.manifest;
    manifest.files = manifest.files || [];
    for (const p of createdPaths) {
      manifest.files.push({ path: p, existed: false, backup: null, bytes: 0, kind: 'created' });
    }
    await writeJson(manifestPath, manifest);
    backupInfo.manifest = manifest;
  }

  return { results, backup: backupInfo, target: store };
}

/* ------------------------------------------------------------------ */
/* 汇总信息                                                            */
/* ------------------------------------------------------------------ */

export function summarizeExport(conversations, blobs) {
  const messages = conversations.reduce((a, c) => a + (c.stats?.messages || 0), 0);
  const chars = conversations.reduce((a, c) => a + (c.stats?.chars || 0), 0);
  return {
    conversations: conversations.length,
    messages,
    chars,
    blobCount: blobs?.size || 0,
    blobBytes: blobs?.bytes ? blobs.bytes() : 0,
    text: `${conversations.length} 个会话 / ${messages} 条消息 / ${chars.toLocaleString('zh-CN')} 字符`,
  };
}

export function dedupeConversations(conversations) {
  const seen = new Set();
  const out = [];
  for (const c of conversations) {
    const key = `${c.source?.adapter}:${pathKey(c.workspace?.cwd || '')}:${c.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 从裸消息数组构造会话（供 handoff / 自定义输入使用）。 */
export function conversationFromMessages(title, messages, extra = {}) {
  return createConversation({ title, messages, ...extra });
}
