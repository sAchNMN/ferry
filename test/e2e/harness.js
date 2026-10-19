/**
 * 端到端测试脚手架：造两台"电脑"，跑完整迁移链路。
 *
 * 与 test/helpers.js 的分工：
 *   helpers.js  提供单机夹具（seedCodex / makeEnv），被所有测试共用；
 *   本文件     只提供"跨机器"所需的额外能力（快照、蜜罐、链路封装）。
 *
 * 设计原则：这里不做断言，只搭台子。断言全部留在 *.test.js，方便按验收项逐条阅读。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { freshDir, makeEnv } from '../helpers.js';

/** 造一台干净的"电脑"：独立 home + env。 */
export async function mintMachine(label) {
  const home = await freshDir(label);
  return { label, home, env: makeEnv(home) };
}

/** 目录内容快照：相对路径 → 内容哈希。用于证明"零写盘"。 */
export async function snapshotTree(root) {
  const out = new Map();
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.set(`${rel}/`, 'dir');
        await walk(abs, rel);
      } else if (e.isFile()) {
        const buf = await fsp.readFile(abs);
        out.set(rel, crypto.createHash('sha256').update(buf).digest('hex'));
      }
    }
  }
  await walk(root, '');
  return out;
}

/** 比较两份快照，返回新增/删除/改动的路径列表。 */
export function diffSnapshots(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  return { added, removed, changed };
}

/**
 * 蜜罐主目录：把 HOME / USERPROFILE 指向一个空目录。
 *
 * 用途：任何绕过 `env` 直接读 `os.homedir()` 的适配器，都会在这个目录里留下痕迹。
 * 返回的 `assertClean()` 会检查目录是否仍为空。
 */
export async function withHoneypotHome() {
  const dir = await freshDir('honeypot-home');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  return {
    dir,
    async assertClean() {
      const entries = await fsp.readdir(dir);
      return entries;
    },
    restore() {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.USERPROFILE;
    },
  };
}

/** 读文件原始字节，用于检查归档里是否残留明文。 */
export async function readBytes(file) {
  return fsp.readFile(file);
}

/** 断言某个目录存在（导入类测试常用）。 */
export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export { fs, fsp, path };
