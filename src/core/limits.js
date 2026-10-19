/**
 * 不可信输入的资源限制。
 *
 * 归档是**用户从别处拷来的文件**，必须按不可信输入处理：
 * 一个 1KB 的 gzip 可以解出几十 GB（zip bomb），一个 `../` 条目可以写到目标目录外。
 * Node 的 zlib 有 `maxOutputLength` 兜住解压体积，但条目数、总量、路径合法性要自己管。
 *
 * 所有上限都可通过 `opts.limits` 覆盖 —— 测试用小限额验证逻辑，用户在大归档场景可以调大。
 */
import { FerryError } from './util.js';

const KIB = 1024;

export const DEFAULT_LIMITS = {
  /** 归档内条目数上限（会话 + 附件 + manifest） */
  maxEntries: 20000,
  /** 单条解压后体积上限 */
  maxEntryBytes: 1024 * KIB * KIB, // 1 GiB
  /** 全部条目解压后总体积上限 */
  maxTotalBytes: 4 * 1024 * KIB * KIB, // 4 GiB
};

export function mergeLimits(overrides = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (typeof v === 'number' && v > 0 && k in out) out[k] = v;
  }
  return out;
}

export function formatLimit(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * 归档内条目名必须是一个"相对、无穿越"的路径。
 *
 * 拒绝：绝对路径（`/x`、`C:\x`）、UNC（`\\srv\share`）、任何 `..` 段、
 * 反斜杠（归档规范只允许 `/`）、NUL 字节、空名。
 */
export function assertSafeEntryName(name) {
  const bad = (reason) =>
    new FerryError(`归档内条目路径不安全（${reason}）：${JSON.stringify(String(name).slice(0, 80))}`, {
      code: 'EUNSAFEENTRY',
      hint: '这不是正常的 Ferry 归档，可能被构造过，建议不要解包。',
    });

  if (typeof name !== 'string' || !name.trim()) throw bad('空名称');
  if (name.includes('\0')) throw bad('含 NUL 字节');
  if (name.includes('\\')) throw bad('含反斜杠，归档路径必须用 /');
  if (name.startsWith('/')) throw bad('绝对路径');
  if (/^[a-zA-Z]:/.test(name)) throw bad('含盘符');
  if (name.split('/').some((seg) => seg === '..')) throw bad('路径穿越（..）');
  return name;
}

/** 内容寻址的附件名必须是 64 位小写十六进制 sha256。 */
export function assertSafeHash(hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new FerryError(`附件哈希不合法：${JSON.stringify(String(hash).slice(0, 80))}`, {
      code: 'EBADHASH',
      hint: '合法的附件名是 64 位十六进制的 sha256。',
    });
  }
  return hash;
}

/**
 * 预算计数器：边解析边扣额度，超了立刻失败，不等到全部解压完再发现。
 * @param {object} limits
 */
export function createBudget(limits) {
  let entries = 0;
  let bytes = 0;
  return {
    add(size, name = '') {
      const nextEntries = entries + 1;
      const nextBytes = bytes + size;
      if (nextEntries > limits.maxEntries) {
        throw new FerryError(`归档条目数超出上限（${nextEntries} > ${limits.maxEntries}）`, {
          code: 'ETOOLARGE',
          hint: '疑似压缩炸弹或异常归档。',
        });
      }
      if (size > limits.maxEntryBytes) {
        throw new FerryError(`单条体积超出上限：${name || '(未命名)'} ${formatLimit(size)} > ${formatLimit(limits.maxEntryBytes)}`, {
          code: 'ETOOLARGE',
        });
      }
      if (nextBytes > limits.maxTotalBytes) {
        throw new FerryError(`归档解压后总量超出上限（${formatLimit(nextBytes)} > ${formatLimit(limits.maxTotalBytes)}）`, {
          code: 'ETOOLARGE',
          hint: '疑似压缩炸弹；确实需要处理大归档时可用 limits.maxTotalBytes 调高。',
        });
      }
      entries = nextEntries;
      bytes = nextBytes;
    },
    get entries() {
      return entries;
    },
    get bytes() {
      return bytes;
    },
  };
}
