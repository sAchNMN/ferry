/**
 * UCM 统一出口（兼容层）。
 *
 * 实现已按职责拆成五层：
 *   ucm-model.js     结构定义 / 构造 / 校验 / 统计   ← 契约，改动需 RFC
 *   ucm-text.js      会话 → 纯文本
 *   ucm-render.js    Markdown / 交接包
 *   ucm-redact.js    密钥打码
 *   ucm-identity.js  指纹 / 内容哈希
 *
 * 本文件只做 re-export，不含任何逻辑。
 * 新代码请直接从对应的层 import；保留本文件是为了让既有 17 个导入方零改动。
 */
export * from './ucm-model.js';
export * from './ucm-text.js';
export * from './ucm-render.js';
export * from './ucm-redact.js';
export * from './ucm-identity.js';
