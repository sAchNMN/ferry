/**
 * 打一个可移植包：dist/ferry-<version>.tar.gz
 * 目标机器只需要 Node.js >= 22.5，解压即可运行。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTar } from '../src/core/tar.js';
import { formatBytes } from '../src/core/util.js';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const INCLUDE = ['bin', 'src', 'docs', 'README.md', 'LICENSE', 'package.json', 'start.cmd', 'start.sh'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'dist', 'test']);

async function collect(rel) {
  const abs = path.join(root, rel);
  const st = await fsp.stat(abs);
  if (st.isFile()) return [{ name: `ferry-${pkg.version}/${rel.replace(/\\/g, '/')}`, abs }];
  const out = [];
  for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    out.push(...(await collect(path.join(rel, e.name))));
  }
  return out;
}

const files = [];
for (const rel of INCLUDE) {
  if (await fsp.stat(path.join(root, rel)).catch(() => null)) files.push(...(await collect(rel)));
}

const entries = [];
for (const f of files) {
  const isScript = f.name.endsWith('/start.sh');
  entries.push({ name: f.name, data: await fsp.readFile(f.abs), mtime: new Date(), mode: isScript ? 0o755 : 0o644 });
}
entries.push({ name: `ferry-${pkg.version}/`, dir: true });

const tar = createTar(entries);
const gz = zlib.gzipSync(tar, { level: 9 });
await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `ferry-${pkg.version}.tar.gz`);
await fsp.writeFile(out, gz);

console.log(`已生成 ${out}`);
console.log(`  ${files.length} 个文件，压缩后 ${formatBytes(gz.length)}（未压缩 ${formatBytes(tar.length)}）`);
console.log('  在目标机器： tar -xzf ferry-' + pkg.version + '.tar.gz && cd ferry-' + pkg.version + ' && ./start.sh');
