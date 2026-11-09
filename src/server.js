/**
 * Ferry 本地 Web 服务。
 * 只监听 127.0.0.1，并用每次启动随机生成的 token 校验 API，
 * 防止同机其他网页/进程偷偷调用本地接口读取你的会话。
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { adapterSummary, getStore, scanStores } from './core/registry.js';
import { collectForExport, compileMappings, importConversations, summarizeExport } from './core/migrate.js';
import { readPack, writePack } from './core/archive.js';
import { renderMarkdown } from './core/ucm.js';
import { listBackups, rollback } from './core/backup.js';
import { loadConfig, saveConfig, backupsDir } from './core/env.js';
import { VERSION, createLogger, ensureDir, formatBytes, nowIso, uid } from './core/util.js';
import { collectProjectSnapshots, planProjectRestore, restoreProjectSnapshots } from './core/projects.js';
import { openFolder as defaultOpenFolder } from './core/open-folder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');
const ICON_DIR = path.join(__dirname, '..', 'assets');
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

/** 把 EPERM/EACCES 这类系统错误换成用户能照着做的说明。 */
function describeFsError(err) {
  if (!err || !['EPERM', 'EACCES', 'EROFS'].includes(err.code)) return err;
  const where = err.path ? ` ${err.path}` : '';
  const wrapped = new Error(
    `没有权限写入${where}（${err.code}）。如果 Ferry 放在项目目录、只读盘或受限目录里，请换到桌面等普通文件夹再运行；也检查安全软件是否拦截了它。`,
  );
  wrapped.statusCode = 500;
  return wrapped;
}

export async function startServer({ env, port = 7099, log = createLogger(), openFolder = defaultOpenFolder }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const uploads = new Map();
  const pendingExports = new Set();
  let activePosts = 0;
  let clearingCache = false;
  const uploadDir = path.join(env.ferryHome, 'uploads');
  const exportDir = path.join(env.ferryHome, 'exports');
  await ensureDir(uploadDir);
  await ensureDir(exportDir);

  const server = http.createServer((req, res) => {
    if (req.method === 'POST') activePosts++;
    handle(req, res).catch((err) => {
      const shown = describeFsError(err);
      log.error(`${req.method} ${req.url} → ${shown.message}`);
      if (!res.headersSent) sendJson(res, shown.statusCode || 500, { error: shown.message, hint: shown.hint });
      else if (res.getHeader('content-type') === 'application/x-ndjson') {
        res.end(JSON.stringify({ type: 'error', error: shown.message, hint: shown.hint }) + '\n');
      } else res.end();
    }).finally(() => {
      if (req.method === 'POST') activePosts--;
    });
  });

  async function checkDirectory(directory) {
    if ((await fsp.lstat(directory)).isSymbolicLink()) {
      throw Object.assign(new Error('存储目录不能是符号链接'), { statusCode: 400 });
    }
    // Windows 的 junction 不会被 lstat 认成符号链接，只能比较真实路径。
    // 只跟直接父目录比，避免把祖先目录上的合法重定向（如漫游配置）误判。
    const parent = fs.realpathSync.native(path.dirname(directory));
    const actual = fs.realpathSync.native(directory);
    const expected = path.join(parent, path.basename(directory));
    const same = process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
    if (!same) throw Object.assign(new Error('存储目录不能是符号链接'), { statusCode: 400 });
  }

  async function managedFiles(directory) {
    await checkDirectory(directory);
    const items = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.lstat(path.join(directory, entry.name));
        if (stat.isFile()) items.push({ file: entry.name, bytes: stat.size, createdAt: stat.mtime.toISOString() });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return items;
  }

  async function exportFile(name) {
    if (typeof name !== 'string' || /[\\/:]/.test(name) || !name.endsWith('.ferrypack')) {
      throw Object.assign(new Error('无效的导出包文件名'), { statusCode: 400 });
    }
    if (pendingExports.has(name)) throw Object.assign(new Error('导出包仍在写入，请稍后重试'), { statusCode: 409 });
    const items = await managedFiles(exportDir);
    if (!items.some((item) => item.file === name)) throw Object.assign(new Error('导出包不存在或已删除'), { statusCode: 404 });
    return path.join(exportDir, name);
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || pathname === '/index.html') {
      const html = await fsp.readFile(path.join(UI_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html.replace('__FERRY_BOOT_TOKEN__', token));
      return;
    }
    if (pathname === '/assets/app.js' || pathname === '/assets/style.css') {
      const file = path.join(UI_DIR, pathname === '/assets/app.js' ? 'app.js' : 'style.css');
      const type = pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (pathname === '/favicon.ico' || pathname === '/assets/ferry.ico') {
      const iconFile = path.join(ICON_DIR, 'ferry.ico');
      try {
        await fsp.access(iconFile);
      } catch {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=86400' });
      fs.createReadStream(iconFile).pipe(res);
      return;
    }
    if (pathname === '/assets/ferry-icon.png') {
      const iconFile = path.join(ICON_DIR, 'ferry-icon.png');
      try {
        await fsp.access(iconFile);
      } catch {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      fs.createReadStream(iconFile).pipe(res);
      return;
    }

    if (!pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // API 鉴权
    const provided = req.headers['x-ferry-token'];
    if (provided !== token) {
      sendJson(res, 403, { error: '无效的会话令牌，请从 Ferry 启动时打印的地址重新打开页面' });
      return;
    }

    const method = req.method.toUpperCase();
    if (method === 'POST' && clearingCache) return sendJson(res, 409, { error: '正在清理缓存，请稍后重试' });
    const body = method === 'POST' ? await readBody(req) : null;
    const json = () => (body ? JSON.parse(body.toString('utf8') || '{}') : {});

    switch (`${method} ${pathname}`) {
      case 'GET /api/state': {
        const config = await loadConfig(env);
        return sendJson(res, 200, {
          version: VERSION,
          platform: env.platform,
          home: env.home,
          ferryHome: env.ferryHome,
          node: process.version,
          targets: adapterSummary(),
          config,
        });
      }

      case 'GET /api/scan': {
        const res2 = await scanStores(env, { log });
        return sendJson(res, 200, {
          total: res2.totalSessions,
          ms: res2.ms,
          results: res2.results.map((r) => ({
            adapter: r.adapter,
            name: r.name,
            vendor: r.vendor,
            category: r.category,
            region: r.region,
            installed: r.installed,
            error: r.error,
            count: r.sessions.length,
            bytes: r.sessions.reduce((a, s) => a + (s.bytes || 0), 0),
            last: r.sessions.map((s) => s.updatedAt).filter(Boolean).sort().at(-1) || null,
            sessions: r.sessions.slice(0, 200).map((s) => ({
              id: s.id,
              title: s.title,
              updatedAt: s.updatedAt,
              workspace: s.workspace,
              bytes: s.bytes,
            })),
          })),
        });
      }

      case 'POST /api/export': {
        const opts = json();
        const agents = Array.isArray(opts.agents) ? opts.agents : [];
        const password = opts.password || undefined;
        const streaming = req.headers.accept === 'application/x-ndjson';
        const progress = (data) => {
          if (streaming && !res.destroyed) res.write(JSON.stringify({ type: 'progress', ...data }) + '\n');
        };
        if (streaming) {
          res.setHeader('content-type', 'application/x-ndjson');
          res.writeHead(200, { 'cache-control': 'no-store' });
          res.flushHeaders();
        }
        progress({ message: '正在扫描所选 Agent…' });
        const collected = await collectForExport(env, {
          agents,
          since: opts.since,
          limit: Number(opts.limit) || 0,
          redact: opts.redact !== false,
          onProgress: ({ done, total }) => progress({ message: `正在读取会话 ${done} / ${total}`, done, total }),
          log,
        });
        if (!collected.conversations.length) {
          throw Object.assign(new Error('所选范围没有会话，请先扫描或放宽时间范围。'), { statusCode: 400 });
        }
        progress({ message: opts.projects ? '正在收集项目文件…' : '正在准备归档…' });
        const projectSnapshot = opts.projects
          ? await collectProjectSnapshots(collected.conversations, { excludes: await exportExcludes(env, opts) })
          : { projects: [], warnings: [], excludedFiles: 0, failedProjects: [], report: null };
        const file = path.join(exportDir, `ferry-${stamp()}-${uid().slice(0, 6)}.ferrypack`);
        await checkDirectory(exportDir);
        pendingExports.add(path.basename(file));
        let written;
        try {
          written = await writePack(file, {
            conversations: collected.conversations,
            blobs: collected.blobs,
            projects: projectSnapshot.projects,
            password,
            onProgress: progress,
            meta: { label: opts.label || undefined, notes: projectSnapshot.warnings, projectReport: projectSnapshot.report },
          });
        } catch (err) {
          await fsp.unlink(file).catch(() => {});
          throw err;
        } finally {
          pendingExports.delete(path.basename(file));
        }
        const sum = summarizeExport(collected.conversations, collected.blobs);
        const result = {
          file: path.basename(file),
          directory: exportDir,
          bytes: written.bytes,
          summary: sum,
          stats: written.manifest.stats,
          errors: collected.errors,
          projectWarnings: projectSnapshot.warnings,
          projectExcluded: projectSnapshot.excludedFiles,
          projectReport: projectSnapshot.report,
          projectFailures: projectSnapshot.failedProjects,
          projects: projectSnapshot.projects.map((p) => ({ id: p.id, name: p.name, originalPath: p.originalPath, files: p.files.length, bytes: p.files.reduce((a, f) => a + f.bytes, 0) })),
          conversations: collected.conversations.map((c) => ({
            id: c.id,
            title: c.title,
            source: c.source.name,
            messages: c.stats.messages,
          })),
        };
        if (streaming) return res.end(JSON.stringify({ type: 'result', result }) + '\n');
        return sendJson(res, 200, result);
      }

      case 'GET /api/exports': {
        const items = (await managedFiles(exportDir))
          .filter((item) => item.file.endsWith('.ferrypack') && !pendingExports.has(item.file))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJson(res, 200, { dir: exportDir, items });
      }

      case 'POST /api/exports/open': {
        const file = await exportFile(json().file);
        await openFolder(path.dirname(file));
        return sendJson(res, 200, { dir: exportDir });
      }

      case 'POST /api/exports/delete': {
        const file = await exportFile(json().file);
        await fsp.unlink(file);
        return sendJson(res, 200, { deleted: path.basename(file) });
      }

      case 'GET /api/cache': {
        const files = await managedFiles(uploadDir);
        return sendJson(res, 200, { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) });
      }

      case 'POST /api/cache/clear': {
        if (activePosts > 1) return sendJson(res, 409, { error: '有导出、上传或导入等操作正在进行，请完成后再清理缓存' });
        clearingCache = true;
        try {
          const files = await managedFiles(uploadDir);
          for (const item of files) await fsp.unlink(path.join(uploadDir, item.file));
          uploads.clear();
          return sendJson(res, 200, { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) });
        } finally {
          clearingCache = false;
        }
      }

      case 'POST /api/upload': {
        await checkDirectory(uploadDir);
        if (!body) return sendJson(res, 400, { error: '空文件' });
        const name = String(url.searchParams.get('name') || 'upload.bin').replace(/[^\w.\-\u4e00-\u9fa5 ]+/g, '_');
        const t = uid().replace(/-/g, '').slice(0, 16);
        const file = path.join(uploadDir, `${t}-${name}`);
        await fsp.writeFile(file, body);
        uploads.set(t, { file, name, size: body.length });
        return sendJson(res, 200, { token: t, name, size: body.length });
      }

      case 'POST /api/inspect': {
        const { token: t, password } = json();
        const up = uploads.get(t);
        if (!up) return sendJson(res, 404, { error: '上传已过期，请重新选择文件' });
        let pack;
        try {
          pack = await readPack(up.file, { password });
        } catch (err) {
          if (err.code === 'ENOPASS' || err.code === 'EBADPASS') {
            return sendJson(res, 401, { error: err.message, code: err.code, needsPassword: true });
          }
          throw err;
        }
        return sendJson(res, 200, {
          manifest: pack.manifest,
          encrypted: pack.encrypted,
          warnings: pack.warnings,
          conversations: pack.conversations.map((c) => ({
            id: c.id,
            title: c.title,
            source: c.source.name,
            adapter: c.source.adapter,
            messages: c.stats.messages,
            workspace: c.workspace?.cwd || null,
            updatedAt: c.updatedAt,
          })),
          projects: (pack.projects || []).map((p) => ({
            id: p.id,
            name: p.name,
            originalPath: p.originalPath,
            files: p.files?.length || 0,
            bytes: p.bytes || 0,
          })),
        });
      }

      case 'POST /api/preview': {
        const { token: t, id, password } = json();
        const up = uploads.get(t);
        if (!up) return sendJson(res, 404, { error: '上传已过期' });
        const pack = await readPack(up.file, { password });
        const conv = pack.conversations.find((c) => c.id === id) || pack.conversations[0];
        if (!conv) return sendJson(res, 404, { error: '会话不存在' });
        return sendJson(res, 200, { id: conv.id, title: conv.title, markdown: renderMarkdown(conv), stats: conv.stats });
      }

      case 'POST /api/import': {
        const opts = json();
        const up = uploads.get(opts.token);
        if (!up) return sendJson(res, 404, { error: '上传已过期，请重新选择文件' });
        const pack = await readPack(up.file, { password: opts.password });
        let conversations = pack.conversations;
        if (Array.isArray(opts.ids) && opts.ids.length) {
          conversations = conversations.filter((c) => opts.ids.includes(c.id));
        }
        const target = getStore(opts.target);
        if (!target) return sendJson(res, 400, { error: `未知目标：${opts.target}` });
        if (!target.capabilities.import) {
          return sendJson(res, 400, { error: `${target.name} 不支持原生导入`, hint: '请选择其它目标，或使用"交接包"导出。' });
        }
        if (opts.restoreProjects && !pack.projects?.length) {
          return sendJson(res, 400, { error: '归档里没有项目文件', hint: '导出时勾选“包含项目文件”。' });
        }
        const projectPlan = opts.restoreProjects && pack.projects?.length
          ? await planProjectRestore(pack.projects, conversations, opts.restoreProjects)
          : null;
        const mappings = [...(projectPlan?.mappings || []), ...compileMappings(opts.map || [])];
        if (projectPlan && !opts.dryRun) await restoreProjectSnapshots(projectPlan);
        const result = await importConversations(env, conversations, {
          target: opts.target,
          workspace: opts.workspace || undefined,
          map: mappings,
          into: opts.into || undefined,
          dryRun: Boolean(opts.dryRun),
          backup: opts.backup !== false,
          blobs: pack.blobs,
          log,
        });
        return sendJson(res, 200, {
          target: target.id,
          backup: result.backup?.id || null,
          losses: result.losses || [],
          results: result.results,
          projects: projectPlan ? projectPlan.projects.map((p) => ({ id: p.id, name: p.name, path: p.target, files: p.files.length })) : [],
          resumeHint: target.resumeHint?.(null, result.results.find((r) => r.resume)?.resume),
        });
      }

      case 'GET /api/backups': {
        const list = await listBackups(env);
        return sendJson(res, 200, {
          dir: backupsDir(env),
          items: list.map((b) => ({
            id: b.id,
            createdAt: b.createdAt,
            target: b.target,
            note: b.note,
            files: b.files?.length || 0,
            bytes: b.totalBytes,
          })),
        });
      }

      case 'POST /api/rollback': {
        const { id } = json();
        const result = await rollback(env, id);
        return sendJson(res, 200, { id: result.manifest.id, results: result.results });
      }

      case 'GET /api/config': {
        return sendJson(res, 200, await loadConfig(env));
      }

      case 'POST /api/config': {
        const patch = json();
        const next = await saveConfig(env, patch);
        return sendJson(res, 200, next);
      }

      default:
        return sendJson(res, 404, { error: `未知接口：${method} ${pathname}` });
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/`,
    token,
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ------------------------------------------------------------------ */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new Error('文件超过 2GB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 项目快照的追加排除：config.json 的 excludePaths + 导出请求里的 excludePaths。 */
async function exportExcludes(env, opts = {}) {
  let config = {};
  try {
    config = await loadConfig(env);
  } catch {
    // 配置损坏不该挡住导出：只用请求里带的规则。
  }
  const fromConfig = Array.isArray(config.excludePaths) ? config.excludePaths : [];
  const fromRequest = Array.isArray(opts.excludePaths) ? opts.excludePaths : [];
  return [...fromConfig, ...fromRequest].filter((rule) => typeof rule === 'string' && rule.trim());
}
