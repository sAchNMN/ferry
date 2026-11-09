#!/usr/bin/env node
/**
 * 生成单文件绿色版 exe（Node SEA）。
 *
 *   node scripts/build-exe.mjs [--out dist/Ferry.exe]
 *
 * 为什么不是 esbuild 打成一个 bundle：
 *   `src/adapters/_loader.js` 是靠**扫描目录**发现适配器的（约定见 docs/adapters.md），
 *   `src/server.js` 也要从磁盘读 `ui/*` 和 `assets/*`。所以单文件方案 =
 *   把 bin/src/assets/package.json 全部内联进 SEA 入口，启动时释放到
 *   %TEMP%/ferry-<构建指纹>/，再从磁盘 import。这样运行时行为和 `node bin/ferry.js` 完全一致。
 *
 * 产物体积 ≈ 当前 node.exe（约 88 MB）+ 源码（约 2 MB），因为里面就是一整个 Node 运行时；
 * 好处是目标机器不需要装 Node，也不写注册表、不留安装目录。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp', 'sea');
const DIST = path.join(ROOT, 'dist');

const INCLUDE_DIRS = ['bin', 'src', 'assets'];
const INCLUDE_FILES = ['package.json'];

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(ROOT, outArg > 0 && process.argv[outArg + 1] ? process.argv[outArg + 1] : path.join('dist', 'Ferry.exe'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function log(msg) {
  process.stdout.write(`› ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\n✖ ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1. 收集要内联的文件                                                 */
/* ------------------------------------------------------------------ */

function walk(dir, relDir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rel, out);
    else if (entry.isFile()) out.set(rel, fs.readFileSync(full));
  }
}

function collectFiles() {
  const files = new Map();
  for (const dir of INCLUDE_DIRS) walk(path.join(ROOT, dir), dir, files);
  for (const rel of INCLUDE_FILES) files.set(rel, fs.readFileSync(path.join(ROOT, rel)));
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/* ------------------------------------------------------------------ */
/* 2. 生成 SEA 入口                                                    */
/* ------------------------------------------------------------------ */

const ENTRY_TEMPLATE = String.raw`'use strict';
// 由 scripts/build-exe.mjs 生成，请勿手改。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BUILD = __BUILD__;
const FILES = __FILES__;

function ensureFile(root, rel) {
  const target = path.join(root, rel);
  const buf = Buffer.from(FILES[rel], 'base64');
  try {
    if (fs.statSync(target).size === buf.length) return;
  } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
}

function candidates() {
  const list = [path.join(os.tmpdir(), 'ferry-' + BUILD)];
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Ferry', 'runtime', BUILD));
  list.push(path.join(path.dirname(process.execPath), '.ferry-runtime', BUILD));
  return list;
}

// 依次尝试：系统临时目录 → 本机应用数据 → exe 同目录（U 盘 / 受限环境）。
function extract() {
  let lastError;
  for (const root of candidates()) {
    try {
      for (const rel of Object.keys(FILES)) ensureFile(root, rel);
      return root;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// 顺手清掉三天前的旧版本残留，避免临时目录越积越多。
function cleanup() {
  let names;
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  const keep = 'ferry-' + BUILD;
  for (const name of names) {
    if (!/^ferry-[0-9a-f]{12}$/.test(name) || name === keep) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs < 3 * 864e5) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function userArgs() {
  const raw = process.argv.slice(1);
  if (raw.length && path.resolve(raw[0]) === path.resolve(process.execPath)) return raw.slice(1);
  return raw;
}

function writeFailureLog(err) {
  const body = [
    '[' + new Date().toISOString() + '] Ferry 启动失败',
    'exe: ' + process.execPath,
    'cwd: ' + process.cwd(),
    'argv: ' + JSON.stringify(process.argv),
    'node: ' + process.version + ' ' + process.arch,
    '',
    (err && err.stack) || String(err),
    '',
  ].join('\n');
  const dirs = [];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Ferry', 'logs'));
  dirs.push(os.tmpdir());
  dirs.push(path.dirname(process.execPath));
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'ferry-startup-error.log');
      fs.appendFileSync(file, body);
      return file;
    } catch {}
  }
  return null;
}

// 双击启动时如果失败，窗口会"闪一下就没"，所以停住等用户看清原因。
function waitEnter() {
  if (!process.stdin.isTTY) return;
  process.stderr.write('\n按回车键关闭窗口…');
  try {
    fs.readFileSync(0);
  } catch {}
}

(async () => {
  const args = userArgs();
  const interactive = args.length === 0;
  try {
    const root = extract();
    cleanup();
    const entry = path.join(root, 'bin', 'ferry.js');
    // 双击 = 打开界面；带参数 = 走命令行（ferry.exe scan / doctor / import ...）。
    process.argv = [process.execPath, entry, ...(args.length ? args : ['ui', '--open'])];
    await import(pathToFileURL(entry).href);
    if (process.exitCode && interactive) waitEnter();
  } catch (err) {
    const logFile = writeFailureLog(err);
    process.stderr.write('\n✖ Ferry 启动失败：' + ((err && err.stack) || err) + '\n');
    if (logFile) process.stderr.write('  日志：' + logFile + '\n');
    process.exitCode = 1;
    if (interactive) waitEnter();
  }
})();
`;

function buildId(files) {
  const hash = createHash('sha256');
  for (const [rel, buf] of files) hash.update(rel).update('\0').update(buf).update('\0');
  return hash.digest('hex').slice(0, 12);
}

function writeEntry(files) {
  const encoded = {};
  for (const [rel, buf] of files) encoded[rel] = buf.toString('base64');
  const entry = ENTRY_TEMPLATE.replace('__BUILD__', JSON.stringify(buildId(files))).replace('__FILES__', JSON.stringify(encoded));
  const entryPath = path.join(TMP, 'entry.cjs');
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(entryPath, entry);
  return entryPath;
}

/* ------------------------------------------------------------------ */
/* 3. 生成 blob 并注入 node.exe                                        */
/* ------------------------------------------------------------------ */

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const seaOk = major > 23 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);
  if (!seaOk) fail(`当前 Node ${process.version} 不支持 SEA 构建；请用 22.15+ / 23.8+。`);
  if (process.platform !== 'win32') fail('这个脚本只用于生成 Windows exe（需要 win32 上的 node.exe）。');

  log(`Ferry ${pkg.version} · Node ${process.version} · ${process.arch}`);

  const files = collectFiles();
  const bytes = [...files.values()].reduce((a, b) => a + b.length, 0);
  log(`内联 ${files.size} 个文件（源码 ${(bytes / 1024 / 1024).toFixed(2)} MB）`);

  const entryPath = writeEntry(files);
  const blobPath = path.join(TMP, 'sea-prep.blob');
  const configPath = path.join(TMP, 'sea-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ main: entryPath, output: blobPath, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2),
  );

  log('生成 SEA blob…');
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(OUT, { force: true });
  fs.copyFileSync(process.execPath, OUT);
  log(`复制运行时：${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB`);

  // 图标和版本信息要在注入 blob 之前写：rcedit 会重写资源段，放在后面会毁掉 SEA 资源。
  try {
    const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
    execFileSync(
      rcedit,
      [
        OUT,
        '--set-icon', path.join(ROOT, 'assets', 'ferry.ico'),
        '--set-file-version', `${pkg.version}.0`,
        '--set-product-version', `${pkg.version}.0`,
        '--set-version-string', 'ProductName', 'Ferry',
        '--set-version-string', 'FileDescription', 'Ferry · AI 会话摆渡',
        '--set-version-string', 'CompanyName', 'Ferry',
        '--set-version-string', 'OriginalFilename', 'Ferry.exe',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (err) {
    log(`图标/版本信息写入失败（不影响运行）：${err.message}`);
  }

  log('注入 blob…');
  const { inject } = await import('postject');
  await inject(OUT, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), { sentinelFuse: SENTINEL_FUSE });

  const size = fs.statSync(OUT).size;
  const sha = createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');

  log('自检：运行 --version');
  const version = execFileSync(OUT, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim();

  process.stdout.write(`\n✔ 已生成 ${path.relative(ROOT, OUT)}\n`);
  process.stdout.write(`  ${version}\n`);
  process.stdout.write(`  ${(size / 1024 / 1024).toFixed(1)} MB · sha256 ${sha}\n`);
  process.stdout.write(`  双击打开界面；或 ferry.exe scan / doctor / import x.ferrypack --to codex\n`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));