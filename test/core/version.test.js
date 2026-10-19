/**
 * 版本号一致性。
 *
 * 版本号曾有两处来源：`package.json` 与 `src/core/util.js` 的 VERSION 常量。
 * 发版时只改一处、另一处忘了改，`ferry --version` 就会和 npm 元数据对不上。
 * 这里把两者钉在一起：改一处不改另一处，测试立刻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { VERSION } from '../../src/core/util.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('版本：src/core/util.js 的 VERSION 必须与 package.json 一致', () => {
  assert.equal(
    VERSION,
    pkg.version,
    `版本号不一致：util.js=${VERSION}，package.json=${pkg.version}。发版时两处都要改。`,
  );
});

test('版本：形如 x.y.z', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
