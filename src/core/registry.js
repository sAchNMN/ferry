/**
 * 适配器注册表：发现、扫描、匹配文件格式。
 */
import { stores, importers } from '../adapters/index.js';
import { mapLimit } from './util.js';

export function allStores() {
  return stores;
}

export function allImporters() {
  return importers;
}

export function getStore(id) {
  return stores.find((s) => s.id === id) || checkAlias(id);
}

const ALIASES = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  copilot: 'vscode-copilot',
  'github-copilot': 'vscode-copilot',
  vscode: 'vscode-copilot',
  roo: 'cline',
  kilo: 'cline',
  'roo-code': 'cline',
  'kilo-code': 'cline',
  qwen: 'qwen-code',
  gemini: 'gemini-cli',
  'iflow-cli': 'iflow',
  'open-code': 'opencode',
  aider: 'aider',
  block: 'goose',
  'trae-cn': 'trae',
  trae: 'trae',
  windsurf: 'vscode-chat',
  kiro: 'vscode-chat',
  vscodium: 'vscode-chat',
};

function checkAlias(id) {
  const real = ALIASES[id];
  if (real && real !== id) return stores.find((s) => s.id === real) || null;
  return null;
}

/** 可用于导入的目标（能力矩阵里的 "导入到" 列）。 */
export function importTargets() {
  return stores.filter((s) => s.capabilities.import);
}

export function getTarget(id) {
  const s = getStore(id);
  if (!s) return null;
  return s.capabilities.import ? s : null;
}

/**
 * 扫描所有（或指定）仓库。
 * @returns {Promise<{results: Array, totalSessions: number, errors: Array}>}
 */
export async function scanStores(env, opts = {}) {
  const { only = [], log } = opts;
  const selected = only.length ? only.map((id) => getStore(id)).filter(Boolean) : stores;
  const unknown = only.filter((id) => !getStore(id));

  const started = Date.now();
  const results = await mapLimit(selected, 4, async (store) => {
    const t0 = Date.now();
    try {
      const sessions = await store.scan(env);
      return {
        adapter: store.id,
        name: store.name,
        vendor: store.vendor,
        region: store.region,
        category: store.category,
        installed: sessions.length > 0,
        sessions,
        error: null,
        ms: Date.now() - t0,
      };
    } catch (err) {
      log?.warn?.(`扫描 ${store.name} 失败：${err.message}`);
      return {
        adapter: store.id,
        name: store.name,
        vendor: store.vendor,
        region: store.region,
        category: store.category,
        installed: false,
        sessions: [],
        error: err.message,
        ms: Date.now() - t0,
      };
    }
  });

  const totalSessions = results.reduce((a, r) => a + r.sessions.length, 0);
  return {
    results: results.sort((a, b) => b.sessions.length - a.sessions.length),
    totalSessions,
    errors: [
      ...results.filter((r) => r.error).map((r) => ({ adapter: r.adapter, error: r.error })),
      ...unknown.map((id) => ({ adapter: id, error: '未知的适配器 id' })),
    ],
    ms: Date.now() - started,
  };
}

/** 根据文件内容挑一个导入器。 */
export function pickImporter(buf, filename) {
  for (const imp of importers) {
    try {
      if (imp.detect?.(buf, filename)) return imp;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

export function adapterSummary() {
  return stores.map((s) => ({
    id: s.id,
    name: s.name,
    vendor: s.vendor,
    category: s.category,
    region: s.region,
    capabilities: s.capabilities,
    docs: s.docs,
  }));
}
