/**
 * 项目快照的排除规则。
 *
 * 三层叠加，同一路径只要被任一层判定为排除就不打包：
 * 1. 内置目录名（版本控制、依赖、语言与构建缓存）——始终排除；
 * 2. 项目根的 `.ferryignore`；
 * 3. 调用方追加的 glob（CLI `--exclude-path`、界面"额外排除"、`config.json` 的 `excludePaths`）。
 *
 * 语法是 `.gitignore` 的子集：
 * - 空行与 `#` 开头是注释；
 * - `!` 开头取消前面规则的排除（后出现的规则优先）；
 * - 结尾 `/` 只匹配目录；
 * - 不含 `/` 的规则匹配任意层级的同名文件或目录；
 * - `*` 不跨 `/`，`**` 跨 `/`，`?` 匹配单个非 `/` 字符。
 *
 * 已知差异：被排除的目录不会被重新进入，所以 `!` 无法把已排除目录里的文件捞回来
 * （与 git 一致）。`dist/`、`build/`、`target/` 这类可能是交付物的目录**不在**内置
 * 名单里，需要的话写进 `.ferryignore`。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export const IGNORE_FILE = '.ferryignore';

/** 忽略文件本身也是项目内容，但不能大到影响快照；超过就整份忽略并告警。 */
const MAX_IGNORE_BYTES = 256 * 1024;

export const DEFAULT_EXCLUDED_DIRS = new Set([
  // 版本控制
  '.git',
  '.hg',
  '.svn',
  // 依赖
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  '.venv',
  'venv',
  // 语言缓存
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.cache',
  // 构建与测试缓存
  '.tmp',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.output',
  '.parcel-cache',
  '.turbo',
  '.nyc_output',
  'coverage',
]);

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 把一行规则编译成匹配器；注释、空行和只有 `!`/`/` 的行返回 null。
 * @param {string} raw
 * @returns {{pattern: string, negate: boolean, dirOnly: boolean, regex: RegExp}|null}
 */
export function compileIgnoreRule(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.startsWith('#')) return null;
  let pattern = text;
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }
  pattern = pattern.replace(/^\/+/, '');
  if (!pattern) return null;
  const anchored = pattern.includes('/');
  const body = globToRegex(pattern);
  return {
    pattern: text,
    negate,
    dirOnly,
    regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
  };
}

/** @param {string} text `.ferryignore` 全文 */
export function parseIgnoreRules(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(compileIgnoreRule)
    .filter(Boolean);
}

/**
 * 生成判断函数。路径一律用 `/` 分隔、相对项目根。
 * @param {{dirNames?: Set<string>, rules?: object[], extra?: string[]}} [options]
 * @returns {(relativePath: string, isDirectory?: boolean) => boolean}
 */
export function createIgnoreMatcher({ dirNames = DEFAULT_EXCLUDED_DIRS, rules = [], extra = [] } = {}) {
  const patterns = [...rules, ...(extra || []).map(compileIgnoreRule).filter(Boolean)];
  return function isIgnored(relativePath, isDirectory = false) {
    const normalized = String(relativePath);
    const base = (normalized.split('/').pop() || '').toLowerCase();
    if (isDirectory && dirNames.has(base)) return true;
    let ignored = false;
    for (const rule of patterns) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(normalized)) ignored = !rule.negate;
    }
    return ignored;
  };
}

/**
 * 读取项目根的 `.ferryignore`。读不到不算错误（大多数项目没有这个文件），
 * 但内容异常时返回告警，让导出报告能说清楚为什么某些文件没进包。
 * @param {string} rootDir
 * @returns {Promise<{rules: object[], warnings: string[]}>}
 */
export async function readProjectIgnores(rootDir) {
  const file = path.join(rootDir, IGNORE_FILE);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { rules: [], warnings: [] };
    return { rules: [], warnings: [`无法读取 ${IGNORE_FILE}，已忽略：${file}（${err.message}）`] };
  }
  if (!stat.isFile()) return { rules: [], warnings: [] };
  if (stat.size > MAX_IGNORE_BYTES) {
    return { rules: [], warnings: [`${IGNORE_FILE} 超过 ${MAX_IGNORE_BYTES} 字节，已忽略：${file}`] };
  }
  try {
    return { rules: parseIgnoreRules(await fsp.readFile(file, 'utf8')), warnings: [] };
  } catch (err) {
    return { rules: [], warnings: [`无法读取 ${IGNORE_FILE}，已忽略：${file}（${err.message}）`] };
  }
}