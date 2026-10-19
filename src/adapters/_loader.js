/**
 * 适配器自动发现。
 *
 * 约定（契约见 docs/contract/adapter-interface.md）：
 *   - `src/adapters/` 下（含一层子目录，如 `exports/`）每个 `.js` 可导出任意个适配器对象，
 *     default 导出或命名导出都行；
 *   - 判定依据是对象自身的 `kind` 字段（`defineStore` / `defineImporter` 会写入），
 *     不依赖文件名、不依赖导出变量名；
 *   - `_` 前缀的文件/目录与任意层级的 `index.js` 不参与发现
 *     （前者是内部实现，后者是聚合出口）；
 *   - 同一个适配器对象被多个文件 re-export 不算重复（按引用判定），
 *     不同对象用同一个 id 则直接报错。
 *
 * 这样新增一个平台 = 新增一个文件，不需要改任何公共清单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function isAdapter(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    (value.kind === 'store' || value.kind === 'importer')
  );
}

/** 收集待加载文件，返回相对路径（含一层子目录）。 */
function collectFiles(root) {
  const out = [];
  const walk = (dir, prefix, depth) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name === 'index.js') continue;
      if (e.isFile() && e.name.endsWith('.js')) out.push(path.join(prefix, e.name));
      else if (e.isDirectory() && depth > 0) walk(path.join(dir, e.name), path.join(prefix, e.name), depth - 1);
    }
  };
  walk(root, '', 1);
  // 统一用 / 分隔，保证 Windows 与 POSIX 下 origin 的写法一致（文档与测试都依赖它）
  return out.sort().map((p) => p.split(path.sep).join('/'));
}

/**
 * @param {string} [dir] 适配器目录，测试时可指向临时目录
 * @returns {Promise<{stores: object[], importers: object[], origin: Map<string,string>}>}
 *   `origin` 是 id → 相对文件名，用于报错定位与文档生成。
 */
export async function discoverAdapters(dir = HERE) {
  const files = collectFiles(dir);

  const stores = [];
  const importers = [];
  const origin = new Map();
  const seen = new Map();

  for (const rel of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(dir, rel)).href);
    } catch (err) {
      throw new Error(`适配器模块加载失败：${rel} → ${err.message}`);
    }

    for (const value of Object.values(mod)) {
      if (!isAdapter(value)) continue;

      const known = seen.get(value.id);
      if (known) {
        if (known.ref === value) continue; // 同一对象的 re-export，跳过
        throw new Error(
          `适配器 id 重复：「${value.id}」同时出现在 ${known.file} 与 ${rel}。id 是全局主键，必须唯一。`,
        );
      }
      seen.set(value.id, { ref: value, file: rel });
      origin.set(value.id, rel);

      if (value.kind === 'store') stores.push(value);
      else importers.push(value);
    }
  }

  return { stores, importers, origin };
}

/** 给人看的清单，供 CLI `targets` 与文档生成使用。 */
export async function describeAdapters(dir = HERE) {
  const { stores, importers, origin } = await discoverAdapters(dir);
  return {
    stores: stores.map((s) => ({
      id: s.id,
      name: s.name,
      vendor: s.vendor,
      category: s.category,
      region: s.region,
      importable: Boolean(s.capabilities?.import),
      file: origin.get(s.id) || null,
    })),
    importers: importers.map((i) => ({
      id: i.id,
      name: i.name,
      extensions: i.extensions,
      file: origin.get(i.id) || null,
    })),
  };
}
