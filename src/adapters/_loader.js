/**
 * 适配器自动发现。
 *
 * 约定（契约见 docs/contract/adapter-interface.md）：
 *   - `src/adapters/` 下每个 `.js` 文件可导出任意个适配器对象，default 导出或命名导出都行；
 *   - 判定依据是对象自身的 `kind` 字段（`defineStore` / `defineImporter` 会写入），
 *     不依赖文件名、不依赖导出变量名；
 *   - `_` 前缀的文件与 `index.js` 不参与发现（前者是内部实现，后者是聚合出口）。
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

/**
 * @param {string} [dir] 适配器目录，测试时可指向临时目录
 * @returns {Promise<{stores: object[], importers: object[], origin: Map<string,string>}>}
 *   `origin` 是 id → 文件名，用于报错定位与文档生成。
 */
export async function discoverAdapters(dir = HERE) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_') && e.name !== 'index.js')
    .map((e) => e.name)
    .sort();

  const stores = [];
  const importers = [];
  const origin = new Map();

  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(dir, file)).href);
    } catch (err) {
      throw new Error(`适配器模块加载失败：${file} → ${err.message}`);
    }

    for (const value of Object.values(mod)) {
      if (!isAdapter(value)) continue;
      if (origin.has(value.id)) {
        throw new Error(
          `适配器 id 重复：「${value.id}」同时出现在 ${origin.get(value.id)} 与 ${file}。id 是全局主键，必须唯一。`,
        );
      }
      origin.set(value.id, file);
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
