/**
 * 契约测试：UCM 分层依赖方向。
 *
 * 规则（违反即架构退化）：
 *   model   → 无内部依赖
 *   text    → model
 *   render  → 无内部依赖（只依赖 util）
 *   redact  → 无内部依赖
 *   identity→ text
 *   ucm.js  → 只做 re-export
 *
 * 这条测试读源码文本而不是运行时，因为运行时看不出"谁 import 了谁"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CORE = path.join(process.cwd(), 'src', 'core');

const ALLOWED = {
  'ucm-model.js': [],
  'ucm-text.js': ['ucm-model.js'],
  'ucm-render.js': [],
  'ucm-redact.js': [],
  'ucm-identity.js': ['ucm-text.js'],
};

function importsOf(file) {
  const src = fs.readFileSync(path.join(CORE, file), 'utf8');
  return [...src.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map((m) => m[1]);
}

test('分层：UCM 各层只允许按约定方向依赖', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    const actual = importsOf(file).filter((p) => p.startsWith('ucm'));
    assert.deepEqual(
      actual.sort(),
      [...allowed].sort(),
      `${file} 的 UCM 内部依赖不符合约定，实际 import：${actual.join(', ') || '（无）'}`,
    );
  }
});

test('分层：ucm.js 只做 re-export，不含逻辑', () => {
  const src = fs.readFileSync(path.join(CORE, 'ucm.js'), 'utf8');
  assert.ok(!/function\s|const\s+\w+\s*=/.test(src), 'ucm.js 出现了实现代码，应只保留 export *');
  const reexports = [...src.matchAll(/export \* from '\.\/(ucm-[\w-]+\.js)'/g)].map((m) => m[1]);
  assert.equal(reexports.length, 5, `应 re-export 5 个层，实际 ${reexports.length}`);
});

test('分层：UCM 各层不超过 250 行，避免职责重新粘连', () => {
  const oversized = fs
    .readdirSync(CORE)
    .filter((f) => /^ucm[\w-]*\.js$/.test(f))
    .map((f) => ({ f, n: fs.readFileSync(path.join(CORE, f), 'utf8').split('\n').length }))
    .filter((x) => x.n > 250);
  assert.deepEqual(
    oversized.map((x) => `${x.f}:${x.n}`),
    [],
    'UCM 某层超过 250 行，说明职责又开始粘连',
  );
});
