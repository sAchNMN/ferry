/**
 * 项目快照：仅打包会话引用的工作区，并排除常见依赖、Git 数据与凭据。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createIgnoreMatcher, readProjectIgnores } from './ignore.js';
import { assertSafeEntryName } from './limits.js';
import { samePath } from './paths.js';
import { isWindowsDeviceName, safeName, sha256 } from './util.js';

const MAX_PROJECT_FILES = 18000;
const MAX_PROJECT_BYTES = 2 * 1024 ** 3;

function isCredentialFile(name) {
  const lower = name.toLowerCase();
  return (
    lower === '.env' ||
    (lower.startsWith('.env.') && !lower.endsWith('.example')) ||
    lower === '.npmrc' ||
    lower === '.pypirc' ||
    lower === 'credentials' ||
    lower.startsWith('credentials.') ||
    lower.startsWith('id_rsa') ||
    lower.startsWith('id_ed25519') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key')
  );
}

/**
 * @param {object[]} conversations
 * @param {{excludes?: string[]}} [options] 追加的排除 glob（.ferryignore 之外）
 * @returns {Promise<{projects: object[], warnings: string[], excludedFiles: number, failedProjects: object[], report: object}>}
 */
export async function collectProjectSnapshots(conversations, options = {}) {
  const extraExcludes = Array.isArray(options.excludes) ? options.excludes : [];
  const sessionCount = Array.isArray(conversations) ? conversations.length : 0;
  const roots = new Map();
  let sessionsWithWorkspace = 0;
  for (const conv of conversations || []) {
    const originalPath = conv.workspace?.cwd || conv.workspace?.roots?.[0];
    if (!originalPath) continue;
    sessionsWithWorkspace++;
    const fullPath = path.resolve(originalPath);
    const key = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    if (!roots.has(key)) roots.set(key, { fullPath, originalPath });
  }

  const projects = [];
  const warnings = [];
  let excludedFiles = 0;
  let totalBytes = 0;
  let totalFiles = 0;
  const failedProjects = [];

  for (const { fullPath, originalPath } of roots.values()) {
    let stat;
    try {
      stat = await fsp.lstat(fullPath);
    } catch (err) {
      failedProjects.push({ path: originalPath, reason: err.message });
      warnings.push(`项目目录不可读取，已跳过：${originalPath}（${err.message}）`);
      continue;
    }
    if (!stat.isDirectory()) {
      failedProjects.push({ path: originalPath, reason: '路径不是目录' });
      warnings.push(`项目路径不是目录，已跳过：${originalPath}`);
      continue;
    }

    const ignore = await readProjectIgnores(fullPath);
    for (const warning of ignore.warnings) warnings.push(warning);
    const isIgnored = createIgnoreMatcher({ rules: ignore.rules, extra: extraExcludes });

    const files = [];
    let rootBytes = 0;
    let rootExcluded = 0;
    async function walk(dir, relative = '') {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          rootExcluded++;
          continue;
        }
        const isDirectory = entry.isDirectory();
        if (isIgnored(childRelative, isDirectory)) {
          rootExcluded++;
          continue;
        }
        if (isDirectory) {
          await walk(path.join(dir, entry.name), childRelative);
          continue;
        }
        if (!entry.isFile()) {
          rootExcluded++;
          continue;
        }
        if (isCredentialFile(entry.name)) {
          rootExcluded++;
          continue;
        }

        const relativePath = childRelative.split(path.sep).join('/');
        assertSafeEntryName(relativePath);
        const data = await fsp.readFile(path.join(dir, entry.name));
        if (totalFiles + files.length + 1 > MAX_PROJECT_FILES || totalBytes + rootBytes + data.length > MAX_PROJECT_BYTES) {
          throw new Error(`项目快照超过上限（${MAX_PROJECT_FILES} 个文件 / 2 GiB）`);
        }
        files.push({ path: relativePath, data, bytes: data.length, sha256: sha256(data) });
        rootBytes += data.length;
      }
    }

    try {
      await walk(fullPath);
    } catch (err) {
      failedProjects.push({ path: originalPath, reason: err.message });
      warnings.push(`项目目录未能完整读取，已跳过：${originalPath}（${err.message}）`);
      continue;
    }

    const id = `p${projects.length + 1}`;
    projects.push({
      id,
      name: safeName(path.basename(fullPath), 'project'),
      originalPath,
      files,
    });
    totalFiles += files.length;
    totalBytes += rootBytes;
    excludedFiles += rootExcluded;
  }

  return {
    projects,
    warnings,
    excludedFiles,
    failedProjects,
    report: {
      sessionCount,
      sessionsWithWorkspace,
      sessionsWithoutWorkspace: sessionCount - sessionsWithWorkspace,
      workspaceCount: roots.size,
      projectsPacked: projects.length,
      projectFiles: totalFiles,
      projectBytes: totalBytes,
      excludedFiles,
      failedProjects: failedProjects.length,
    },
  };
}

/** 在写盘前检查项目文件名和文件/目录冲突，保留源文件名，不静默改名。 */
export function validateProjectFiles(files, platform = process.platform) {
  const paths = new Set();
  for (const file of files || []) {
    assertSafeEntryName(file.path);
    const parts = file.path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`项目文件相对路径不安全：${file.path}`);
    }
    if (platform === 'win32' && parts.some((part) =>
      /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || part.length > 255 || isWindowsDeviceName(part),
    )) {
      throw new Error(`项目文件名不能在 Windows 恢复：${file.path}`);
    }
    const key = platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (paths.has(key)) throw new Error(`项目文件路径重复：${file.path}`);
    paths.add(key);
  }
  for (const filePath of paths) {
    const parents = filePath.split('/');
    parents.pop();
    while (parents.length) {
      const parent = parents.join('/');
      if (paths.has(parent)) throw new Error(`项目文件与目录冲突：${parent}`);
      parents.pop();
    }
  }
}

/** 计算项目解包位置和旧路径到新路径的映射，不写盘。 */
export async function planProjectRestore(projects, conversations, directory) {
  if (!directory) throw new Error('恢复项目文件需要指定目标目录');
  const workspaces = (conversations || [])
    .map((conv) => conv.workspace?.cwd || conv.workspace?.roots?.[0])
    .filter(Boolean);
  const selected = (projects || []).filter((project) =>
    workspaces.some((workspace) => samePath(workspace, project.originalPath)),
  );
  const base = path.resolve(directory);
  const targets = [];
  const mappings = [];
  const destinations = new Set();

  for (const project of selected) {
    const id = String(project.id || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`项目编号不安全：${id}`);
    const name = safeName(project.name, 'project');
    const target = path.join(base, `${id}-${name}`);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (destinations.has(key)) throw new Error(`项目目标目录重复：${target}`);
    destinations.add(key);
    try {
      await fsp.lstat(target);
      throw new Error(`项目目标已存在，不会覆盖：${target}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    validateProjectFiles(project.files);
    targets.push({ ...project, target });
    mappings.push({ from: project.originalPath, to: target });
  }

  return { base, projects: targets, mappings };
}

/** 按计划恢复项目文件；使用 wx 保证不覆盖文件。 */
export async function restoreProjectSnapshots(plan) {
  await fsp.mkdir(plan.base, { recursive: true });
  const restored = [];
  for (const project of plan.projects) {
    await fsp.mkdir(project.target, { recursive: false });
    for (const file of project.files || []) {
      const target = path.join(project.target, ...file.path.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.data, { flag: 'wx' });
    }
    restored.push({ id: project.id, name: project.name, path: project.target, files: project.files?.length || 0 });
  }
  return restored;
}
