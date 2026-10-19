/**
 * WorkBuddy 适配器：结构、取词、写回。
 *
 * 重点钉三件事：
 *   1. **目录 slug** —— 写错就落到别的项目目录里，应用侧栏看不到会话；
 *   2. **机器注入内容的剥离** —— WorkBuddy 每轮都把 `<system-reminder>` 塞进 user 消息，
 *      不剥离的话导出的是 8KB 系统提示、标题也是提示词原文（Codex 那边 47/112 中招）；
 *   3. **写回不产生副本** —— 同一归档导两次只能有一个会话（契约 §2 第 4 条）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { freshDir, makeEnv } from '../helpers.js';
import { getStore } from '../../src/core/registry.js';
import { collectForExport, importConversations } from '../../src/core/migrate.js';
import { createBlobStore } from '../../src/core/archive.js';
import { openDb, insertLoose, closeQuietly } from '../../src/core/sqlite.js';
import workbuddy, { projectSlug, cleanUserText } from '../../src/adapters/workbuddy.js';

const SESSION_ID = 'a4f7a33a-e647-468f-b88b-673ef55e91ec';
const CWD = 'C:\\work\\wb-demo';

const REMINDER = `<system-reminder data-role="user-context">
<user_info>
OS Version: win32
Workspace Folder: C:/work/wb-demo
</user_info>
</system-reminder>`;

/** 一条真实的 user 消息：注入上下文 + 真正的提问。 */
function userTurn(text, ts, { onlyInjection = false } = {}) {
  const body = onlyInjection ? REMINDER : `${REMINDER}\n<user_query>${text}</user_query>`;
  return {
    id: `m-user-${ts}`,
    timestamp: ts,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: body }],
    cwd: CWD,
    sessionId: SESSION_ID,
  };
}

function sessionLines({ title = '修复登录页报错' } = {}) {
  return [
    { type: 'session-meta', id: 'meta-1', sessionId: SESSION_ID, timestamp: 1792395000000, meta: { 'codebuddy.ai/hostKind': 'unopted' } },
    userTurn('帮我修复登录页的报错', 1792395001000),
    {
      id: 'rs-1',
      parentId: 'm-user-1792395001000',
      timestamp: 1792395002000,
      type: 'reasoning',
      content: [],
      rawContent: [{ type: 'reasoning_text', text: '先看登录页的实现。' }],
      cwd: CWD,
      sessionId: SESSION_ID,
      providerData: { agent: 'cli', model: 'deepseek-v4.1-flash' },
    },
    {
      id: 'fc-1',
      parentId: 'rs-1',
      timestamp: 1792395003000,
      type: 'function_call',
      name: 'Read',
      arguments: '{"file_path":"C:\\\\work\\\\wb-demo\\\\login.tsx"}',
      callId: 'call_1',
      message: 'Read',
      cwd: CWD,
      sessionId: SESSION_ID,
    },
    {
      id: 'fcr-1',
      parentId: 'fc-1',
      timestamp: 1792395004000,
      type: 'function_call_result',
      name: 'Read',
      callId: 'call_1',
      status: 'completed',
      output: { type: 'text', text: 'export const Login = () => null;' },
      cwd: CWD,
      sessionId: SESSION_ID,
    },
    {
      id: 'm-asst-1',
      parentId: 'fcr-1',
      timestamp: 1792395005000,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '已定位到空指针。' }],
      cwd: CWD,
      sessionId: SESSION_ID,
      providerData: { agent: 'cli', model: 'deepseek-v4.1-flash' },
    },
    // 只有注入内容的一轮：不该算"用户说过话"
    userTurn('', 1792395006000, { onlyInjection: true }),
    { type: 'ai-title', id: 'title-1', aiTitle: title, timestamp: 1792395007000, cwd: CWD, sessionId: SESSION_ID },
    { type: 'file-history-snapshot', id: 'snap-1', messageId: 'm-asst-1', timestamp: 1792395008000, snapshot: {}, cwd: CWD },
  ];
}

function writeSession(home, lines, { cwd = CWD, id = SESSION_ID } = {}) {
  const dir = path.join(home, '.workbuddy', 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

/** 造一个"装过 WorkBuddy"的用户目录：sessions 表 + 一行模板（user_id 必须沿用）。 */
async function seedDb(home, rows = []) {
  const file = path.join(home, '.workbuddy', 'workbuddy.db');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const db = await openDb(file, { readOnly: false });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT, custom_title TEXT,
      status TEXT NOT NULL DEFAULT 'Pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER NOT NULL DEFAULT 0,
      is_background_automation INTEGER, mode TEXT, model TEXT, expert_id TEXT, project_id TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL)`);
    for (const row of rows) insertLoose(db, 'sessions', row);
  } finally {
    closeQuietly(db);
  }
  return file;
}

const TEMPLATE_ROW = {
  id: 'existing-session',
  cwd: 'C:\\work\\old',
  user_id: 'b5e68213-42da-48a8-9808-e2e34c26aca2',
  title: '旧会话',
  status: 'completed',
  created_at: 1792000000000,
  updated_at: 1792000000000,
  is_playground: 0,
  mode: 'craft',
  model: 'deepseek-v4.1-flash',
};

/* ------------------------------------------------------------------ */

test('slug：盘符、UNC、盘根都按实测规则落目录名', () => {
  assert.equal(projectSlug('C:\\Users\\me\\Desktop\\Thdr'), 'c-Users-me-Desktop-Thdr');
  assert.equal(projectSlug('C:/Users/me/Desktop/Thdr'), 'c-Users-me-Desktop-Thdr');
  assert.equal(projectSlug('\\\\wsl.localhost\\Ubuntu\\home\\zc\\projects\\FinFlow'), 'wsl.localhost-Ubuntu-home-zc-projects-FinFlow');
  assert.equal(projectSlug('//wsl.localhost/Ubuntu/home/zc/WSL-Projects/hello'), 'wsl.localhost-Ubuntu-home-zc-WSL-Projects-hello');
  assert.equal(projectSlug('D:\\'), 'd');
  assert.equal(projectSlug('/home/u/proj'), 'home-u-proj');
  assert.equal(projectSlug(''), 'root');
});

test('剥离注入：只留 <user_query> 里的真实提问', () => {
  assert.equal(cleanUserText(`${REMINDER}\n<user_query>完成 workbuddy 的数据迁移</user_query>`), '完成 workbuddy 的数据迁移');
  assert.equal(cleanUserText('直接手打的提问'), '直接手打的提问');
  assert.equal(cleanUserText(REMINDER), '');
  assert.equal(cleanUserText(''), '');
});

test('扫描：标题取数据库，跳过已删除与空会话', async () => {
  const home = await freshDir('wb-scan');
  await seedDb(home, [
    TEMPLATE_ROW,
    { ...TEMPLATE_ROW, id: SESSION_ID, cwd: CWD, title: '数据库里的标题', created_at: 1792395000000, updated_at: 1792395009000 },
    { ...TEMPLATE_ROW, id: 'deleted-one', cwd: CWD, title: '已删除', deleted_at: 1792395000000 },
  ]);
  writeSession(home, sessionLines());
  // 删掉的会话文件还在，但不该出现
  writeSession(home, sessionLines(), { id: 'deleted-one' });
  // 打开过但一句话没发
  writeSession(home, [{ type: 'session-meta', id: 'x', sessionId: 'empty-one', timestamp: 1792395000000 }], { id: 'empty-one' });

  const env = makeEnv(home);
  const refs = await workbuddy.scan(env);
  assert.equal(refs.length, 1, `扫描结果应只有 1 个，实际：${refs.map((r) => r.id)}`);
  assert.equal(refs[0].id, SESSION_ID);
  assert.equal(refs[0].title, '数据库里的标题');
  assert.equal(refs[0].workspace, CWD);
  assert.equal(refs[0].updatedAt, new Date(1792395009000).toISOString());
});

test('扫描：没有数据库时退化成读文件头，标题不会取成系统提示', async () => {
  const home = await freshDir('wb-scan-nodb');
  writeSession(home, sessionLines());
  const refs = await workbuddy.scan(makeEnv(home));
  assert.equal(refs.length, 1);
  // 文件里的 ai-title 是"修复登录页报错"；即便没有它也不能是 <system-reminder 开头
  assert.equal(refs[0].title, '修复登录页报错');
  assert.ok(!refs[0].title.startsWith('<'));
  assert.equal(refs[0].preview, '帮我修复登录页的报错');
});

test('读取：消息、思考、工具调用与结果都能还原', async () => {
  const home = await freshDir('wb-read');
  writeSession(home, sessionLines());
  const env = makeEnv(home);
  const [ref] = await workbuddy.scan(env);
  const conv = await workbuddy.read(env, ref, { blobs: createBlobStore() });

  assert.equal(conv.source.adapter, 'workbuddy');
  assert.equal(conv.workspace.cwd, CWD);
  assert.deepEqual(
    conv.messages.map((m) => m.role),
    ['user', 'assistant', 'assistant', 'tool', 'assistant'],
    '只有注入内容的 user 消息不应进入会话',
  );
  assert.deepEqual(conv.messages[0].blocks, [{ type: 'text', text: '帮我修复登录页的报错' }]);
  assert.equal(conv.messages[1].blocks[0].type, 'thinking');
  assert.equal(conv.messages[2].blocks[0].name, 'Read');
  assert.deepEqual(conv.messages[2].blocks[0].input, { file_path: 'C:\\work\\wb-demo\\login.tsx' });
  assert.equal(conv.messages[3].blocks[0].callId, 'call_1');
  assert.match(conv.messages[3].blocks[0].output, /Login/);
  assert.equal(conv.model.id, 'deepseek-v4.1-flash');
});

test('导入：dry-run 零写盘，且预览清单与真实写入一致', async () => {
  const homeA = await freshDir('wb-dry-A');
  const homeB = await freshDir('wb-dry-B');
  writeSession(homeA, sessionLines());
  await seedDb(homeB, [TEMPLATE_ROW]);

  const collected = await collectForExport(makeEnv(homeA), { agents: ['workbuddy'], redact: false });
  assert.equal(collected.conversations.length, 1);

  const envB = makeEnv(homeB);
  const before = fs.readdirSync(path.join(homeB, '.workbuddy')).sort();
  const dry = await importConversations(envB, collected.conversations, {
    target: 'workbuddy',
    workspace: 'C:\\work\\new',
    backup: false,
    dryRun: true,
    blobs: collected.blobs,
  });
  const after = fs.readdirSync(path.join(homeB, '.workbuddy')).sort();
  assert.deepEqual(after, before, 'dry-run 不许建目录/写文件');
  assert.equal(dry.results[0].error, null);

  const real = await importConversations(envB, collected.conversations, {
    target: 'workbuddy',
    workspace: 'C:\\work\\new',
    backup: false,
    blobs: collected.blobs,
  });
  // 会话 id 每次随机生成，所以比对的是"清单结构"，不是文件名本身
  const shapeOf = (writes) => writes.map((w) => `${w.kind}:${/\.jsonl$/.test(w.path) ? 'session' : path.basename(w.path)}`).sort();
  assert.deepEqual(shapeOf(dry.results[0].writes), shapeOf(real.results[0].writes), '预览和真实写入的文件清单必须一致');
});

test('导入：写进正确项目目录并登记 sessions 表', async () => {
  const homeA = await freshDir('wb-write-A');
  const homeB = await freshDir('wb-write-B');
  writeSession(homeA, sessionLines());
  await seedDb(homeB, [TEMPLATE_ROW]);

  const collected = await collectForExport(makeEnv(homeA), { agents: ['workbuddy'], redact: false });
  const envB = makeEnv(homeB);
  const res = await importConversations(envB, collected.conversations, {
    target: 'workbuddy',
    workspace: 'C:\\work\\new',
    backup: false,
    blobs: collected.blobs,
  });
  assert.equal(res.results[0].error, null);

  const dir = path.join(homeB, '.workbuddy', 'projects', projectSlug('C:\\work\\new'));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, '会话文件应落在新工作区对应的目录');

  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const newId = files[0].replace(/\.jsonl$/, '');
  assert.equal(lines[0].type, 'session-meta');
  assert.equal(lines[0].sessionId, newId);
  assert.ok(lines.every((l) => l.sessionId === newId), '每行的 sessionId 都必须是新 id');
  // 写回结构要和真实文件同构：assistant 事件带 providerData，ai-title 不带 parentId
  const assistant = lines.find((l) => l.type === 'message' && l.role === 'assistant');
  assert.ok(assistant.providerData?.agent, 'assistant 消息缺 providerData');
  assert.ok(assistant.providerData.conversationRequestId);
  const titleLine = lines.find((l) => l.type === 'ai-title');
  assert.ok(titleLine.aiTitle);
  assert.equal(titleLine.parentId, undefined, 'ai-title 不在消息链上，不该有 parentId');
  assert.ok(!JSON.stringify(lines).includes('system-reminder'), '注入内容不应被写回');

  // 数据库：必须沿用本机已有 user_id，否则应用会当别的账号
  const db = await openDb(path.join(homeB, '.workbuddy', 'workbuddy.db'), { readOnly: true });
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(newId);
  closeQuietly(db);
  assert.ok(row, 'sessions 表没有登记，侧栏历史里就看不到');
  assert.equal(row.cwd, 'C:\\work\\new');
  assert.equal(row.user_id, TEMPLATE_ROW.user_id);
  assert.equal(row.status, 'completed');
  assert.equal(row.title, '修复登录页报错');
});

test('导入：目标机没有 workbuddy.db 时只写会话文件，并如实说明', async () => {
  const homeA = await freshDir('wb-nodb-A');
  const homeB = await freshDir('wb-nodb-B');
  writeSession(homeA, sessionLines());
  await fsp.mkdir(path.join(homeB, '.workbuddy'), { recursive: true });

  const collected = await collectForExport(makeEnv(homeA), { agents: ['workbuddy'], redact: false });
  const res = await importConversations(makeEnv(homeB), collected.conversations, {
    target: 'workbuddy',
    workspace: 'C:\\work\\new',
    backup: false,
    blobs: collected.blobs,
  });
  assert.equal(res.results[0].error, null);
  assert.match(res.results[0].notes.join(' '), /没有 workbuddy\.db/);
  assert.ok(!fs.existsSync(path.join(homeB, '.workbuddy', 'workbuddy.db')), '不该凭空造一个数据库');
});

test('往返：导入后重新扫描读取，内容与源端逐块一致', async () => {
  const homeA = await freshDir('wb-rt-A');
  const homeB = await freshDir('wb-rt-B');
  writeSession(homeA, sessionLines());
  await seedDb(homeB, [TEMPLATE_ROW]);

  const collected = await collectForExport(makeEnv(homeA), { agents: ['workbuddy'], redact: false });
  const envB = makeEnv(homeB);
  await importConversations(envB, collected.conversations, { target: 'workbuddy', workspace: 'C:\\work\\new', backup: false, blobs: collected.blobs });

  const refs = await getStore('workbuddy').scan(envB);
  assert.equal(refs.length, 1);
  const back = await getStore('workbuddy').read(envB, refs[0], { blobs: createBlobStore() });
  const source = collected.conversations[0];

  const shape = (c) => c.messages.map((m) => [m.role, m.blocks.map((b) => b.type)]);
  assert.deepEqual(shape(back), shape(source));
  const texts = (c) => c.messages.flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text));
  assert.deepEqual(texts(back), texts(source));
  const outputs = (c) => c.messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_result').map((b) => b.output));
  assert.deepEqual(outputs(back), outputs(source));
});

test('幂等：同一归档导两次，目标机仍只有一个会话', async () => {
  const homeA = await freshDir('wb-idem-A');
  const homeB = await freshDir('wb-idem-B');
  writeSession(homeA, sessionLines());
  await seedDb(homeB, [TEMPLATE_ROW]);

  const collected = await collectForExport(makeEnv(homeA), { agents: ['workbuddy'], redact: false });
  const envB = makeEnv(homeB);
  const opts = { target: 'workbuddy', workspace: 'C:\\work\\new', backup: false, blobs: collected.blobs };

  await importConversations(envB, collected.conversations, opts);
  const second = await importConversations(envB, collected.conversations, opts);
  assert.equal(second.results[0].skipped, true);
  assert.deepEqual(second.results[0].writes, []);

  const refs = await getStore('workbuddy').scan(envB);
  assert.equal(refs.length, 1, '重复导入产生了副本');
});

test('大输出：<persisted-output> 占位要读回溢写文件，且能按 env.home 重建路径', async () => {
  const home = await freshDir('wb-persist');
  const spillDir = path.join(home, '.workbuddy', 'projects', projectSlug(CWD), SESSION_ID, 'tool-results');
  await fsp.mkdir(spillDir, { recursive: true });
  const full = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: 完整的命令输出`).join('\n');
  await fsp.writeFile(path.join(spillDir, 'call_big.txt'), full, 'utf8');

  const lines = sessionLines();
  lines.splice(5, 1, {
    id: 'fcr-big',
    parentId: 'fc-1',
    timestamp: 1792395004100,
    type: 'function_call_result',
    name: 'Bash',
    callId: 'call_big',
    status: 'completed',
    // 记录的是**另一台机器**的绝对路径：离线迁移（--home）时就是这个样子
    output: {
      type: 'text',
      text: `<persisted-output>\nOutput too large (67.4KB). Full output saved to: C:\\Users\\someone\\.workbuddy\\projects\\x\\y\\tool-results\\call_big.txt\n\nPreview (first 2048 bytes):\nline 1: 完整的命令输出`,
    },
    cwd: CWD,
    sessionId: SESSION_ID,
  });
  writeSession(home, lines);

  const env = makeEnv(home);
  const [ref] = await workbuddy.scan(env);
  const conv = await workbuddy.read(env, ref, { blobs: createBlobStore() });
  const result = conv.messages.find((m) => m.blocks.some((b) => b.type === 'tool_result' && b.callId === 'call_big'));
  const output = result.blocks.find((b) => b.type === 'tool_result').output;
  assert.equal(output, full, '应读回溢写文件的完整内容，而不是 2KB 预览');
});

test('图片：blob_path 换机器后按 sha256 在 blobs/ 下重建', async () => {
  const home = await freshDir('wb-blob');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  // WorkBuddy 的 blob_id 就是内容 sha256（和 Ferry 的 blob 指纹同一套算法）
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  const blobDir = path.join(home, '.workbuddy', 'blobs', sha.slice(0, 2));
  await fsp.mkdir(blobDir, { recursive: true });
  await fsp.writeFile(path.join(blobDir, `${sha}.png`), png);

  const lines = sessionLines();
  lines.splice(1, 0, {
    id: 'm-img',
    timestamp: 1792395001200,
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: `${REMINDER}\n<user_query>看这张截图</user_query>` },
      { type: 'image_blob_ref', blob_id: sha, mime: 'image/png', size: png.length, blob_path: 'D:\\old-machine\\.workbuddy\\blobs\\bd\\x.png', original_filename: 'shot.png' },
    ],
    cwd: CWD,
    sessionId: SESSION_ID,
  });
  writeSession(home, lines);

  const env = makeEnv(home);
  const blobs = createBlobStore();
  const [ref] = await workbuddy.scan(env);
  const conv = await workbuddy.read(env, ref, { blobs });
  const img = conv.messages.flatMap((m) => m.blocks).find((b) => b.type === 'image');
  assert.ok(img, '应该产出 image 块');
  assert.equal(img.blob, sha, 'blob 指纹就是内容 sha256，不该被重新计算成别的值');
  assert.equal(img.name, 'shot.png');
  assert.deepEqual(blobs.get(sha).data, png);
});

test('备份范围：workbuddy.db 与 WAL 边车文件一起声明（否则快照不一致）', () => {
  const home = 'C:\\Users\\me';
  const scope = workbuddy.backupScope({ home });
  assert.deepEqual(scope.map((p) => path.basename(p)), ['workbuddy.db', 'workbuddy.db-wal', 'workbuddy.db-shm']);
  // home 是 Windows 路径，判定绝对路径必须用 win32 语义，否则在 POSIX 宿主上恒为 false。
  assert.ok(scope.every((p) => path.win32.isAbsolute(p)));
});
