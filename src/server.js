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
import { VERSION, createLogger, ensureDir, exists, formatBytes, nowIso, uid } from './core/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

export async function startServer({ env, port = 7099, log = createLogger() }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const uploads = new Map();
  const uploadDir = path.join(env.ferryHome, 'uploads');
  const exportDir = path.join(env.ferryHome, 'exports');
  await ensureDir(uploadDir);
  await ensureDir(exportDir);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`${req.method} ${req.url} → ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message, hint: err.hint });
      else res.end();
    });
  });

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
    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
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
        const collected = await collectForExport(env, {
          agents,
          since: opts.since,
          limit: Number(opts.limit) || 0,
          redact: opts.redact !== false,
          log,
        });
        if (!collected.conversations.length) {
          return sendJson(res, 400, { error: '所选范围没有会话', hint: '先扫描，或放宽时间范围。' });
        }
        const file = path.join(exportDir, `ferry-${stamp()}-${uid().slice(0, 6)}.ferrypack`);
        const written = await writePack(file, {
          conversations: collected.conversations,
          blobs: collected.blobs,
          password,
          meta: { label: opts.label || undefined },
        });
        const sum = summarizeExport(collected.conversations, collected.blobs);
        return sendJson(res, 200, {
          file: path.basename(file),
          bytes: written.bytes,
          summary: sum,
          stats: written.manifest.stats,
          errors: collected.errors,
          conversations: collected.conversations.map((c) => ({
            id: c.id,
            title: c.title,
            source: c.source.name,
            messages: c.stats.messages,
          })),
        });
      }

      case 'GET /api/download': {
        const name = path.basename(url.searchParams.get('file') || '');
        const file = path.join(exportDir, name);
        if (!(await exists(file))) return sendJson(res, 404, { error: '文件不存在' });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
          'content-length': (await fsp.stat(file)).size,
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      case 'POST /api/upload': {
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
        const result = await importConversations(env, conversations, {
          target: opts.target,
          workspace: opts.workspace || undefined,
          map: compileMappings(opts.map || []),
          into: opts.into || undefined,
          dryRun: Boolean(opts.dryRun),
          backup: opts.backup !== false,
          blobs: pack.blobs,
          log,
        });
        return sendJson(res, 200, {
          target: target.id,
          backup: result.backup?.id || null,
          results: result.results,
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
