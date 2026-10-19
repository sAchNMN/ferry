/**
 * UCM 脱敏层。
 *
 * 原则：只替换高置信度的密钥模式，宁可漏也不误伤正常文本。
 * 所有命中都要计数上报 —— 用户有权知道"这次导出打了几处码"。
 *
 * 局限（必须对外说明）：无法识别所有秘密。自定义格式的密钥、短口令、内网地址都识别不了。
 */
const SECRET_PATTERNS = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'openai', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer', re: /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi },
  {
    kind: 'assignment',
    re: /\b((?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|token)\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi,
  },
  { kind: 'url-credential', re: /\b([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+:)([^@/\s]{6,})(@)/gi },
];

/**
 * 在文本中打码常见密钥。
 * @returns {{text: string, hits: string[]}}
 */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', hits: [] };
  let out = text;
  const hits = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      const groups = args.slice(0, -2);
      hits.push(kind);
      if (kind === 'bearer' || kind === 'assignment') {
        return `${groups[1]}[REDACTED:${kind}]`;
      }
      if (kind === 'url-credential') {
        return `${groups[1]}[REDACTED:${kind}]${groups[3]}`;
      }
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, hits };
}

/** 返回脱敏副本与命中统计，不修改原对象。 */
export function redactConversation(conv) {
  const hits = {};
  const clone = structuredClone(conv);
  const scrub = (text) => {
    const r = redactText(text);
    for (const h of r.hits) hits[h] = (hits[h] || 0) + 1;
    return r.text;
  };
  for (const m of clone.messages) {
    for (const b of m.blocks) {
      if (b.type === 'text' || b.type === 'thinking') b.text = scrub(b.text);
      else if (b.type === 'tool_result') b.output = scrub(b.output);
      else if (b.type === 'tool_call' && typeof b.input === 'string') b.input = scrub(b.input);
      else if (b.type === 'tool_call' && b.input && typeof b.input === 'object') {
        b.input = JSON.parse(scrub(JSON.stringify(b.input)));
      }
    }
  }
  return { conversation: clone, hits };
}
