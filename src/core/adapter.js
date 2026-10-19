/**
 * 适配器框架。
 *
 * 两类扩展点：
 *   Store     本机 Agent 的会话仓库（可 scan / read / 可选 import）
 *   Importer  外部导出文件（.zip / .json / .jsonl），只读
 *
 * 约定：适配器永远不直接读 process.env，也不假设 os.homedir()，一律通过 env 参数，
 * 这样测试可以把 fixtures 目录伪装成一台电脑。
 */
import { FerryError } from './util.js';

export const CATEGORIES = {
  cli: '命令行 Agent',
  ide: 'IDE / 编辑器',
  desktop: '桌面客户端',
  chat: '聊天 / 网页',
  framework: 'Agent 框架',
};

/**
 * @typedef {object} ScanRef
 * @property {string} id          会话在该 Agent 内的唯一 id
 * @property {string} title
 * @property {string} path        本地文件路径（或逻辑位置）
 * @property {string} [updatedAt]
 * @property {string} [createdAt]
 * @property {number} [messages]
 * @property {number} [bytes]
 * @property {string} [workspace]
 * @property {string} [preview]
 */

export function defineStore(spec) {
  for (const key of ['id', 'name', 'scan', 'read']) {
    if (!spec[key]) throw new Error(`Store 适配器缺少 ${key}`);
  }
  return {
    kind: 'store',
    vendor: '',
    category: 'cli',
    region: 'global',
    capabilities: {
      scan: true,
      export: true,
      import: false,
      resume: false,
      attachments: false,
      tools: false,
      ...spec.capabilities,
    },
    /** 目标端「怎么接着用」的提示，会在导入完成后展示 */
    resumeHint(conv) {
      return spec.capabilities?.resume ? '打开应用即可在历史里看到该会话。' : '该 Agent 不支持原生导入，已导出为交接包。';
    },
    ...spec,
  };
}

export function defineImporter(spec) {
  for (const key of ['id', 'name', 'read']) {
    if (!spec[key]) throw new Error(`Importer 缺少 ${key}`);
  }
  return {
    kind: 'importer',
    vendor: '',
    extensions: ['.zip', '.json'],
    ...spec,
  };
}

/** 统一的"读取失败"包装，避免一个坏会话弄崩整次导出。 */
export async function safeRead(adapter, env, ref, ctx) {
  try {
    const conv = await adapter.read(env, ref, ctx);
    if (!conv) throw new Error('适配器没有返回会话');
    return { ok: true, conv };
  } catch (err) {
    return {
      ok: false,
      ref,
      error: new FerryError(`读取会话失败：${ref.title || ref.id || ref.path}`, {
        code: 'EREAD',
        hint: err.message,
        cause: err,
      }),
    };
  }
}
