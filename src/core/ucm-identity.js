/**
 * UCM 身份层：会话指纹与内容哈希。
 *
 * 这一层决定"什么是同一个会话"，直接影响跨机去重和增量导入的正确性。
 * 规则：
 *   - 有源 sessionId 就用 adapter + sessionId 做稳定指纹（换机器、换标题都不变）；
 *   - 没有就用标题 + 前 3 条消息文本 + 消息数做内容指纹（会比实际更脆弱，属已知降级）。
 * 标题**不能**单独作主键 —— 同名会话太常见。
 */
import { sha256, shortHash, stableStringify } from './util.js';
import { messageText } from './ucm-text.js';

/** 会话指纹：用于跨机去重。 */
export function conversationFingerprint(conv) {
  if (conv.source?.sessionId) {
    return shortHash(`${conv.source.adapter}:${conv.source.sessionId}`, 24);
  }
  const pieces = conv.messages.slice(0, 3).map((m) => messageText(m));
  return shortHash(stableStringify({ t: conv.title, p: pieces, n: conv.messages.length }), 24);
}

/** 整份会话内容的哈希，用于完整性校验与"内容是否变化"判断。 */
export function contentHash(conv) {
  return sha256(stableStringify(conv));
}
