#!/usr/bin/env node
// Ferry 入口。保持极薄：真正的逻辑在 src/cli.js。
import { FerryError, supportsNodeVersion } from '../src/core/util.js';

try {
  if (!supportsNodeVersion()) throw new FerryError('需要 Node.js 22.15+（22.x）或 23.8+，当前为 ' + process.version);
  const { main } = await import('../src/cli.js');
  await main(process.argv.slice(2));
} catch (err) {
  // CLI 层的错误已经格式化过；这里只是兜底，避免堆栈吓到用户。
  if (err && err.ferry) {
    process.stderr.write(`\n✖ ${err.message}\n`);
    if (err.hint) process.stderr.write(`  ${err.hint}\n`);
  } else {
    process.stderr.write(`\n✖ 未预期的错误：${err && err.stack ? err.stack : err}\n`);
  }
  process.exitCode = 1;
}
