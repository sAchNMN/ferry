/**
 * 归档加密：scrypt 派生密钥 + AES-256-GCM。
 *
 * 文件布局：
 *   "FERRYENC1" | 4 字节大端 header 长度 | header JSON | 密文 | 16 字节 GCM tag
 *
 * 之所以自己定义容器而不是用 zip 加密：GCM 可以整体认证，任何一位被篡改都会在解封时失败，
 * 而不是悄悄解出一份被改过的历史。
 */
import crypto from 'node:crypto';
import { FerryError } from './util.js';

export const MAGIC = Buffer.from('FERRYENC1', 'ascii');
const TAG_LEN = 16;

const KDF = { name: 'scrypt', N: 1 << 15, r: 8, p: 1 };

export function isEncrypted(buf) {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function deriveKey(password, salt, params = KDF) {
  return crypto.scryptSync(password, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/**
 * @param {Buffer} data
 * @param {string} password
 * @returns {Buffer}
 */
export function encryptBuffer(data, password) {
  if (!password) throw new FerryError('加密需要密码', { code: 'ENOPASS' });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.from(
    JSON.stringify({
      v: 1,
      cipher: 'aes-256-gcm',
      kdf: { ...KDF, salt: salt.toString('base64') },
      iv: iv.toString('base64'),
      createdAt: new Date().toISOString(),
    }),
    'utf8',
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC, len, header, ciphertext, tag]);
}

/**
 * @param {Buffer} buf
 * @param {string} password
 * @returns {Buffer}
 */
export function decryptBuffer(buf, password) {
  if (!isEncrypted(buf)) throw new FerryError('文件未加密，无需解密', { code: 'ENOTENC' });
  if (!password) throw new FerryError('该归档已加密，需要提供密码', { code: 'ENOPASS' });

  const headerLen = buf.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  let header;
  try {
    header = JSON.parse(buf.toString('utf8', headerStart, headerStart + headerLen));
  } catch {
    throw new FerryError('加密归档头损坏', { code: 'EBADHEADER' });
  }
  if (header.v !== 1 || header.cipher !== 'aes-256-gcm') {
    throw new FerryError(`不支持的加密版本：${header.cipher} v${header.v}`, { code: 'EUNSUPPORTED' });
  }

  const salt = Buffer.from(header.kdf.salt, 'base64');
  const iv = Buffer.from(header.iv, 'base64');
  const key = deriveKey(password, salt, header.kdf);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(headerStart + headerLen, buf.length - TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new FerryError('密码不正确，或归档已被篡改', {
      code: 'EBADPASS',
      hint: '请确认密码；Ferry 使用 AES-256-GCM，密码错误与文件损坏都会导致校验失败。',
    });
  }
}

/** 简单的密码强度提示，不强制（本地备份场景下弱密码也可能是有意为之）。 */
export function passwordStrength(password) {
  const s = String(password || '');
  let score = 0;
  if (s.length >= 8) score++;
  if (s.length >= 12) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/\d/.test(s)) score++;
  if (/[^\w]/.test(s)) score++;
  return { score, label: ['很弱', '弱', '一般', '较强', '强', '很强'][Math.min(score, 5)] };
}
