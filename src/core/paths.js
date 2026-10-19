/**
 * 跨平台路径工具。
 *
 * 换电脑最常出问题的地方：Windows 的 `C:\work\proj` 到了 macOS 是 `/Users/x/proj`，
 * 到了 WSL 是 `/mnt/c/work/proj`。迁移时必须把会话里记录的工作区路径改写成目标机器的形态，
 * 否则目标 Agent 打开会话会提示"目录不存在"。
 *
 * 设计取舍：
 *   - **纯文本处理，不碰文件系统**。路径映射发生在导入计划阶段，那时目标机可能还没这个目录。
 *   - **比较一律大小写不敏感**。Windows/macOS 默认不区分大小写，Linux 区分；
 *     为了让 `C:\Work` 与 `C:\work` 都能命中同一条映射，这里统一按不敏感比较。
 *     代价是 Linux 上 `src/App` 与 `src/app` 两个真实不同的目录会被视作同一个 —— 已知且接受。
 *   - **保留目标形态的分隔符**。映射到 `C:\x` 就输出反斜杠，映射到 `/home/x` 就输出正斜杠，
 *     不混用（混用会让目标应用认不出路径）。
 */

const SEP_ALT = /\\/g;

/** 把任意分隔符统一成 `/`，并压掉尾部斜杠（根路径除外）。 */
export function toPosix(p) {
  if (p === undefined || p === null) return '';
  let s = String(p).replace(SEP_ALT, '/');
  s = s.replace(/\/{2,}/g, (m, off) => (off === 0 || /^[a-zA-Z]:\/$/.test(s.slice(0, off)) ? m : '/'));
  if (s.length > 1 && s.endsWith('/') && !/^[a-zA-Z]:\/$/.test(s) && s !== '/') s = s.replace(/\/+$/, '');
  return s;
}

/**
 * 拆解路径形态。
 * @returns {{kind:'drive'|'unc'|'wsl'|'posix'|'relative', root:string, parts:string[]}}
 */
export function splitPath(p) {
  const s = toPosix(p);
  if (!s) return { kind: 'relative', root: '', parts: [] };

  let m = /^([a-zA-Z]):(?:\/(.*))?$/.exec(s);
  if (m) return { kind: 'drive', root: `${m[1].toUpperCase()}:`, parts: splitParts(m[2]) };

  // \\wsl.localhost\Ubuntu\mnt\c\... 先于 UNC 判断，否则会被当成普通网络共享
  m = /^\/\/(?:wsl(?:\.localhost)?|wsl\$)\/[^/]+\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(s);
  if (m) return { kind: 'wsl', root: `/mnt/${m[1].toLowerCase()}`, parts: splitParts(m[2]) };

  m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(s);
  if (m) return { kind: 'wsl', root: `/mnt/${m[1].toLowerCase()}`, parts: splitParts(m[2]) };

  m = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(s);
  if (m) return { kind: 'unc', root: `//${m[1]}/${m[2]}`, parts: splitParts(m[3]) };

  if (s.startsWith('/')) return { kind: 'posix', root: '/', parts: splitParts(s.slice(1)) };

  return { kind: 'relative', root: '', parts: splitParts(s) };
}

function splitParts(rest) {
  if (!rest) return [];
  return rest.split('/').filter((x) => x && x !== '.');
}

/** 规范化：统一分隔符、去掉 `.` 与多余斜杠、处理 `..`（纯文本，不解析符号链接）。 */
export function normalizePath(p) {
  const { kind, root, parts } = splitPath(p);
  const out = [];
  for (const seg of parts) {
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (kind === 'relative') out.push('..');
      // 绝对路径的 .. 越过根就丢弃
    } else out.push(seg);
  }
  if (kind === 'drive') return out.length ? `${root}/${out.join('/')}` : `${root}/`;
  if (kind === 'unc') return out.length ? `${root}/${out.join('/')}` : root;
  if (kind === 'posix') return `/${out.join('/')}`;
  if (kind === 'wsl') return out.length ? `${root}/${out.join('/')}` : root;
  return out.join('/');
}

/** 两个路径是否指向同一位置（大小写不敏感，比较前先规范化）。 */
export function samePath(a, b) {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/** `child` 是否在 `parent` 之下（含相等）。返回剩余段，不匹配返回 null。 */
export function relativeTo(child, parent) {
  const c = splitPath(child);
  const p = splitPath(parent);
  const cRoot = c.root.toLowerCase();
  const pRoot = p.root.toLowerCase();
  if (cRoot !== pRoot) return null;
  const cw = c.parts.map((x) => x.toLowerCase());
  const pw = p.parts.map((x) => x.toLowerCase());
  if (pw.length > cw.length) return null;
  for (let i = 0; i < pw.length; i++) if (cw[i] !== pw[i]) return null;
  return c.parts.slice(pw.length);
}

/** 用目标形态的分隔符拼接。 */
function joinLike(target, segments) {
  if (!segments.length) return target;
  const sep = String(target).includes('\\') ? '\\' : '/';
  const base = String(target).replace(/[\\/]+$/, '');
  return `${base}${sep}${segments.join(sep)}`;
}

/**
 * 按映射规则改写路径。
 * @param {string} p
 * @param {{from:string,to:string}[]} mappings 已按 from 长度降序排好
 * @returns {string} 未命中任何规则时原样返回
 */
export function mapPath(p, mappings = []) {
  if (!p) return p;
  for (const { from, to } of mappings) {
    if (!from || !to) continue;
    const rest = relativeTo(p, from);
    if (rest === null) continue;
    return joinLike(to, rest);
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Win ↔ WSL                                                           */
/* ------------------------------------------------------------------ */

/** `C:\work\x` → `/mnt/c/work/x`（已是 WSL 形态则原样返回）。 */
export function toWsl(p) {
  const { kind, root, parts } = splitPath(p);
  if (kind === 'wsl') return normalizePath(p);
  if (kind === 'drive') return `/mnt/${root[0].toLowerCase()}/${parts.join('/')}`.replace(/\/$/, '');
  return normalizePath(p);
}

/** `/mnt/c/work/x` → `C:\work\x`（不是 WSL 形态则原样返回）。 */
export function fromWsl(p) {
  const { kind, root, parts } = splitPath(p);
  if (kind !== 'wsl') return normalizePath(p);
  const drive = `${root.slice(5).toUpperCase()}:`;
  return parts.length ? `${drive}\\${parts.join('\\')}` : `${drive}\\`;
}

/** 推断路径形态，供 UI 提示"这个路径看起来来自 Windows / WSL / POSIX"。 */
export function pathKind(p) {
  return splitPath(p).kind;
}
