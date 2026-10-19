/**
 * 极简 tar（ustar + GNU longname + PAX）读写，纯 Node 实现。
 * 只覆盖 Ferry 需要的场景：常规文件、目录；写入时用 PAX 处理超长路径。
 */
import { FerryError } from './util.js';

const BLOCK = 512;

function octal(value, length) {
  const s = Math.max(0, Math.floor(value)).toString(8);
  return s.padStart(length - 1, '0') + '\0';
}

function writeString(buf, offset, length, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function readString(b, start, len) {
  let end = start;
  while (end < start + len && b[end] !== 0) end++;
  return b.toString('utf8', start, end);
}

/** 把校验和写进 header（计算时该字段视为 8 个空格）。 */
function finalizeHeader(header) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, '0');
  writeString(header, 148, 6, chk);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function makeHeader({ name, prefix = '', size = 0, mtime, mode = 0o644, type = '0' }) {
  const header = Buffer.alloc(BLOCK, 0);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(mode & 0o7777, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(mtime, 12));
  header[156] = type.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'ferry');
  writeString(header, 297, 32, 'ferry');
  writeString(header, 345, 155, prefix);
  return finalizeHeader(header);
}

function splitName(name) {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= 100) return { name, prefix: '' };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(base, 'utf8') <= 100) {
      return { name: base, prefix };
    }
  }
  return null;
}

/** 生成一条 PAX 记录；长度字段包含自身，需要迭代到自洽。 */
function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  for (let i = 0; i < 5; i++) {
    const candidate = `${len} ${body}`;
    const actual = Buffer.byteLength(candidate, 'utf8');
    if (actual === len) return candidate;
    len = actual;
  }
  return `${Buffer.byteLength(body, 'utf8') + 3} ${body}`;
}

/**
 * @param {{name:string, data?:Buffer|string, mode?:number, mtime?:Date|number, dir?:boolean}[]} entries
 * @returns {Buffer}
 */
export function createTar(entries) {
  const chunks = [];
  const now = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const name = String(entry.name).replace(/\\/g, '/').replace(/^\/+/, '');
    const mtime = Math.floor(
      (entry.mtime instanceof Date ? entry.mtime.getTime() : Number(entry.mtime) || Date.now()) / 1000,
    ) || now;
    const isDir = Boolean(entry.dir) || name.endsWith('/');

    let header;
    const split = isDir ? null : splitName(name);
    if (!isDir && !split) {
      // 超长路径：PAX 扩展头 + 占位名
      const record = Buffer.from(paxRecord('path', name), 'utf8');
      const paxHeader = makeHeader({
        name: 'PaxHeader',
        size: record.length,
        mtime,
        type: 'x',
      });
      chunks.push(paxHeader, record, Buffer.alloc((BLOCK - (record.length % BLOCK)) % BLOCK, 0));
      header = makeHeader({
        name: name.slice(-90).replace(/[^\x20-\x7e]/g, '_'),
        size: data.length,
        mtime,
        mode: entry.mode ?? (isDir ? 0o755 : 0o644),
        type: '0',
      });
    } else {
      header = makeHeader({
        name: split ? split.name : name,
        prefix: split ? split.prefix : '',
        size: isDir ? 0 : data.length,
        mtime,
        mode: entry.mode ?? (isDir ? 0o755 : 0o644),
        type: isDir ? '5' : '0',
      });
    }

    chunks.push(header);
    if (!isDir) {
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }

  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const len = parseInt(data.toString('ascii', pos, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    // len 是字节数，含结尾换行；用 Buffer 偏移切片，避免多字节字符错位
    const rec = data.toString('utf8', space + 1, pos + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/**
 * 解析 tar。为兼容外部输入，支持 GNU longname / PAX path。
 * @returns {{name:string, data:Buffer, mtime:Date, mode:number, dir:boolean}[]}
 */
export function parseTar(buf) {
  const entries = [];
  let offset = 0;
  let pendingPath = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((x) => x === 0)) break;

    const size = parseInt(readString(header, 124, 12).trim() || '0', 8);
    if (Number.isNaN(size) || size < 0 || size > buf.length) {
      throw new FerryError('归档文件损坏：tar 头部的长度字段非法', { code: 'EBADTAR' });
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const rawName = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    let name = prefix ? `${prefix}/${rawName}` : rawName;

    const dataStart = offset + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    const mtimeSec = parseInt(readString(header, 136, 12).trim() || '0', 8) || 0;
    const mode = parseInt(readString(header, 100, 8).trim() || '644', 8) || 0o644;

    if (type === 'L') {
      pendingPath = data.toString('utf8').replace(/\0+$/, '');
    } else if (type === 'x' || type === 'X') {
      const pax = parsePax(data);
      if (pax.path) pendingPath = pax.path;
    } else if (type === 'g') {
      // 全局 pax 头，忽略
    } else {
      if (pendingPath) {
        name = pendingPath;
        pendingPath = null;
      }
      const dir = type === '5' || name.endsWith('/');
      if (!dir) {
        entries.push({
          name,
          data: Buffer.from(data),
          mtime: new Date(mtimeSec * 1000),
          mode,
          dir: false,
        });
      }
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
