/**
 * 适配器聚合出口。
 *
 * 这里是唯一的公共注册点，由自动发现填充 —— 不再手写 import 与数组。
 * 新增平台请新增 `src/adapters/<name>.js`，不要改本文件（见 docs/contract/ownership.md）。
 */
import { discoverAdapters } from './_loader.js';

const { stores, importers, origin } = await discoverAdapters();

export { stores, importers, origin };
export default { stores, importers };
