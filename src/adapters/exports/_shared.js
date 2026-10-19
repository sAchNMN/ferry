/**
 * 导出包解析的公共工具。
 *
 * 只放"多个厂商都会用到"的东西：从 zip/json 里取出会话数组。
 * 一旦某个函数只有一家在用，就应该搬回那家的文件里 —— 避免这里变成新的公共大杂烩。
 */
import { readZip } from '../../core/zip.js';

function entriesToJson(entries, matcher) {
  const hit = entries.find((e) => matcher(e.name));
  if (!hit) return null;
  try {
    return JSON.parse(hit.data.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 从官方导出包里取出原始会话数组。
 * 支持：ChatGPT 的 zip（内含 conversations.json）、解压后的 .json、裸 .json。
 * @param {Buffer} buf
 * @param {string} [filename]
 * @returns {Array|object}
 */
export function extractConversations(buf, filename = '') {
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) {
    const entries = readZip(buf);
    const json =
      entriesToJson(entries, (n) => n === 'conversations.json') ||
      entriesToJson(entries, (n) => n.endsWith('/conversations.json')) ||
      entriesToJson(entries, (n) => n.endsWith('.json') && !n.includes('/__'));
    if (!json) throw new Error('ZIP 中找不到 conversations.json');
    return json;
  }
  if (/\.json$/i.test(filename) || buf.length) {
    return JSON.parse(buf.toString('utf8'));
  }
  throw new Error('无法识别的文件');
}

/** 把 read() 的输入统一成数组。 */
export function asArray(data) {
  return Array.isArray(data) ? data : [data];
}
