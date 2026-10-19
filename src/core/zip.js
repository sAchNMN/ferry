/**
 * ZIP 读取（deflate / store），用于直接读取 ChatGPT、Claude 等官方的 .zip 导出包。
 * 只读，不写 ZIP —— Ferry 自己的归档用 tar.gz，更容易做流式加密。
 */
import zlib from 'node:zlib';
import { FerryError } from './util.js';

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/**
 * @param {Buffer} buf
 * @returns {{name:string, data:Buffer, mtime:Date, method:number}[]}
 */
export function readZip(buf) {
  const eocdOffset = findEocd(buf);
  if (eocdOffset < 0) throw new FerryError('不是有效的 ZIP 文件（找不到目录结尾）', { code: 'EBADZIP' });

  let count = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let cdSize = buf.readUInt32LE(eocdOffset + 12);

  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locator = eocdOffset - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === SIG_ZIP64_LOCATOR) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) === SIG_ZIP64_EOCD) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;

  for (let i = 0; i < count && p + 46 <= end && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== SIG_CD) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    // Zip64 扩展字段
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      const z = parseZip64Extra(extra);
      if (z.uncompSize !== undefined) uncompSize = z.uncompSize;
      if (z.compSize !== undefined) compSize = z.compSize;
      if (z.localOffset !== undefined) localOffset = z.localOffset;
    }

    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new FerryError(`ZIP 内文件已加密，无法读取：${name}`, { code: 'EZIPCRYPT' });
    if (localOffset + 30 > buf.length) continue;
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) continue;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = Buffer.from(comp);
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(comp, { maxOutputLength: 1024 * 1024 * 1024 });
      } catch (err) {
        throw new FerryError(`ZIP 解压失败：${name}（${err.message}）`, { code: 'EZIPINFLATE' });
      }
    } else {
      throw new FerryError(`不支持的 ZIP 压缩算法 ${method}：${name}`, { code: 'EZIPMETHOD' });
    }

    entries.push({ name, data, mtime: dosToDate(date, time), method });
  }

  return entries;
}

function parseZip64Extra(extra) {
  const out = {};
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    if (id === 0x0001) {
      let q = i + 4;
      if (q + 8 <= i + 4 + size) {
        out.uncompSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (q + 8 <= i + 4 + size) {
        out.compSize = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (q + 8 <= i + 4 + size) {
        out.localOffset = Number(extra.readBigUInt64LE(q));
      }
      return out;
    }
    i += 4 + size;
  }
  return out;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function dosToDate(date, time) {
  const d = ((date >> 9) & 0x7f) + 1980;
  const m = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hh = (time >> 11) & 0x1f;
  const mm = (time >> 5) & 0x3f;
  const ss = (time & 0x1f) * 2;
  return new Date(d, Math.max(0, m), day || 1, hh, mm, ss);
}
