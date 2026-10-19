import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  freshDir,
  makeEnv,
  seedCodex,
  seedClaude,
  seedCline,
  seedContinue,
  seedGemini,
  seedTrae,
  makeZip,
  write,
} from './helpers.js';
import { scanStores, getStore } from '../src/core/registry.js';
import { collectForExport } from '../src/core/migrate.js';
import { writePack, readPack } from '../src/core/archive.js';
import { importConversations } from '../src/core/migrate.js';
import { pickImporter } from '../src/core/registry.js';

/* ------------------------------------------------------------------ */

test('扫描：识别 5 种本地 Agent 的会话', async () => {
  const home = await freshDir('scan-home');
  const env = makeEnv(home);
  await seedCodex(home);
  await seedClaude(home);
  await seedCline(home);
  await seedContinue(home);
  await seedGemini(home);

  const scan = await scanStores(env);
  const byId = Object.fromEntries(scan.results.map((r) => [r.adapter, r]));
  assert.equal(byId.codex.sessions.length, 1);
  assert.equal(byId['claude-code'].sessions.length, 1);
  assert.equal(byId.cline.sessions.length, 1);
  assert.equal(byId.continue.sessions.length, 1);
  assert.equal(byId['gemini-cli'].sessions.length, 1);
  assert.equal(scan.totalSessions, 5);
  assert.equal(scan.errors.length, 0);
});

test('扫描：Trae 的 chatSessions 能被识别与导入', async () => {
  const homeA = await freshDir('trae-src');
  const homeB = await freshDir('trae-dst');
  const seeded = await seedTrae(homeA);
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);

  const [ref] = await getStore('trae').scan(envA);
  assert.ok(ref, '应扫描到 Trae 会话');
  assert.equal(ref.title, '给登录页加验证码');
  assert.equal(ref.workspace, seeded.cwd);

  const conv = await getStore('trae').read(envA, ref, { blobs: new Map() });
  assert.equal(conv.source.adapter, 'trae');
  assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(conv.messages[1].blocks.map((b) => b.text || '').join(' '), /图形验证码/);

  // 目标机器也要有 Trae 目录才允许写入
  await fsp.mkdir(path.join(homeB, 'AppData', 'Roaming', 'Trae', 'User'), { recursive: true });
  const res = await importConversations(envB, [conv], { target: 'trae', workspace: 'C:\\work\\new', backup: false });
  assert.equal(res.results[0].error, null);

  const [ref2] = await getStore('trae').scan(envB);
  assert.ok(ref2, '导入后应能在新机器上扫描到');
  assert.equal(ref2.workspace, 'C:\\work\\new');
});

test('读取：Codex 的 tool_call / tool_result 结构完整', async () => {
  const home = await freshDir('read-codex');
  await seedCodex(home, 'C:\\work\\demo');
  const env = makeEnv(home);
  const store = getStore('codex');
  const sessions = await store.scan(env);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '修复登录页报错');

  const ctx = { blobs: new Map() };
  const conv = await store.read(env, sessions[0], ctx);
  assert.equal(conv.title, '修复登录页报错');
  assert.equal(conv.workspace.cwd, 'C:\\work\\demo');
  assert.equal(conv.model.id, 'gpt-5-codex');
  assert.equal(conv.messages.length, 4);

  const call = conv.messages.find((m) => m.blocks.some((b) => b.type === 'tool_call'));
  assert.ok(call);
  assert.equal(call.blocks[0].name, 'shell');
  assert.deepEqual(call.blocks[0].input, { command: ['npm', 'test'] });

  const tool = conv.messages.find((m) => m.role === 'tool');
  assert.equal(tool.blocks[0].output, 'FAIL src/login.test.ts');
  assert.ok(conv.messages[0].createdAt.startsWith('2026-10-19'));
});

test('读取：Claude Code 的 tool_result 归并为 tool 角色', async () => {
  const home = await freshDir('read-claude');
  const { id } = await seedClaude(home, '/home/u/proj');
  const env = makeEnv(home);
  const store = getStore('claude-code');
  const [ref] = await store.scan(env);
  const conv = await store.read(env, ref, { blobs: new Map() });
  assert.equal(conv.id, id);
  assert.equal(conv.title, '补全 README');
  assert.deepEqual(
    conv.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  const toolCall = conv.messages[1].blocks.find((b) => b.type === 'tool_call');
  assert.equal(toolCall.name, 'Read');
});

test('导出：collectForExport 汇总并过滤 Agent', async () => {
  const home = await freshDir('collect');
  await seedCodex(home);
  await seedContinue(home);
  const env = makeEnv(home);

  const onlyCodex = await collectForExport(env, { agents: ['codex'], redact: true });
  assert.equal(onlyCodex.conversations.length, 1);
  assert.equal(onlyCodex.conversations[0].source.adapter, 'codex');

  const all = await collectForExport(env, { redact: true });
  assert.equal(all.conversations.length, 2);
});

test('导入：Codex → Claude Code 原生文件，可被重新扫描', async () => {
  const homeA = await freshDir('src-home');
  const homeB = await freshDir('dst-home');
  await seedCodex(homeA, 'C:\\work\\demo');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);

  const collected = await collectForExport(envA, { agents: ['codex'], redact: false });
  const res = await importConversations(envB, collected.conversations, {
    target: 'claude-code',
    workspace: 'C:\\work\\demo',
    backup: false,
  });
  assert.equal(res.results[0].error, null);
  assert.match(res.results[0].resume.command, /claude --resume/);

  const [ref] = await getStore('claude-code').scan(envB);
  assert.ok(ref, '导入后的会话应能被 Claude Code 适配器扫描到');
  assert.equal(ref.workspace, 'C:\\work\\demo');
  const conv = await getStore('claude-code').read(envB, ref, { blobs: new Map() });
  assert.equal(conv.messages.filter((m) => m.role === 'user' || m.role === 'tool').length >= 2, true);
  assert.ok(conv.messages.some((m) => m.blocks.some((b) => b.type === 'tool_call' && b.name === 'shell')));
});

test('导入：Claude Code → Codex，写出 rollout 与索引', async () => {
  const homeA = await freshDir('claude-src');
  const homeB = await freshDir('codex-dst');
  await seedClaude(homeA, 'C:\\work\\proj');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);

  const collected = await collectForExport(envA, { agents: ['claude-code'], redact: false });
  const res = await importConversations(envB, collected.conversations, {
    target: 'codex',
    workspace: 'C:\\work\\proj',
    backup: false,
  });
  assert.equal(res.results[0].error, null);
  assert.match(res.results[0].resume.command, /codex resume/);

  const rollouts = await fsp.readdir(path.join(homeB, '.codex', 'sessions'), { recursive: true });
  assert.ok(rollouts.some((f) => String(f).endsWith('.jsonl')));
  const index = await fsp.readFile(path.join(homeB, '.codex', 'session_index.jsonl'), 'utf8');
  assert.match(index, /补全 README/);

  const [ref] = await getStore('codex').scan(envB);
  assert.equal(ref.title, '补全 README');
});

test('导入：Cline 任务目录结构正确', async () => {
  const homeA = await freshDir('proj-src');
  const homeB = await freshDir('cline-dst');
  await seedCline(homeA);
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);

  const collected = await collectForExport(envA, { agents: ['cline'], redact: false });
  const res = await importConversations(envB, collected.conversations, { target: 'cline', workspace: 'C:\\work\\ui', backup: false });
  assert.equal(res.results[0].error, null);

  const [ref] = await getStore('cline').scan(envB);
  assert.ok(ref);
  assert.equal(ref.title, '给按钮加 loading');
});

test('导入：dry-run 不落盘', async () => {
  const homeA = await freshDir('dry-src');
  const homeB = await freshDir('dry-dst');
  await seedCodex(homeA);
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);
  const collected = await collectForExport(envA, { agents: ['codex'], redact: false });

  const res = await importConversations(envB, collected.conversations, {
    target: 'claude-code',
    workspace: 'C:\\work\\demo',
    dryRun: true,
    backup: false,
  });
  assert.equal(res.results[0].error, null);
  assert.equal(res.results[0].writes.length, 1);
  const exists = await fsp
    .access(path.join(homeB, '.claude'))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false, 'dry-run 不应创建任何目录');
});

test('导入：路径映射生效', async () => {
  const homeA = await freshDir('map-src');
  const homeB = await freshDir('map-dst');
  await seedCodex(homeA, 'C:\\old\\proj');
  const envA = makeEnv(homeA);
  const envB = makeEnv(homeB);
  const collected = await collectForExport(envA, { agents: ['codex'], redact: false });

  const res = await importConversations(envB, collected.conversations, {
    target: 'claude-code',
    map: [{ from: 'C:\\old', to: 'D:\\new' }],
    backup: false,
  });
  assert.equal(res.results[0].workspace, path.join('D:\\new', 'proj'));
});

/* ------------------------------------------------------------------ */

test('外部导出：ChatGPT 官方 zip 解析（含工具调用与分支）', async () => {
  const conv = {
    conversation_id: 'gpt-1',
    title: '写个脚本',
    create_time: 1750000000,
    update_time: 1750000100,
    current_node: 'n3',
    mapping: {
      n0: { id: 'n0', message: null, parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        parent: 'n0',
        children: ['n2'],
        message: {
          id: 'n1',
          author: { role: 'user' },
          create_time: 1750000001,
          content: { content_type: 'text', parts: ['写个备份脚本'] },
        },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: ['n3'],
        message: {
          id: 'n2',
          author: { role: 'assistant' },
          recipient: 'python',
          create_time: 1750000002,
          content: { content_type: 'code', parts: ['import shutil'] },
        },
      },
      n3: {
        id: 'n3',
        parent: 'n2',
        children: [],
        message: {
          id: 'n3',
          author: { role: 'assistant' },
          create_time: 1750000003,
          content: { content_type: 'text', parts: ['脚本已生成。'] },
        },
      },
    },
  };
  const zip = makeZip({ 'conversations.json': JSON.stringify([conv]) });
  const importer = pickImporter(zip, 'export.zip');
  assert.equal(importer.id, 'chatgpt-export');
  const convs = importer.read(zip, 'export.zip');
  assert.equal(convs.length, 1);
  assert.equal(convs[0].title, '写个脚本');
  assert.deepEqual(
    convs[0].messages.map((m) => m.role),
    ['user', 'assistant', 'assistant'],
  );
  assert.equal(convs[0].messages[1].blocks[0].type, 'tool_call');
  assert.equal(convs[0].messages[1].blocks[0].name, 'python');
  assert.equal(convs[0].messages[2].blocks[0].text, '脚本已生成。');
});

test('外部导出：Claude 官方 json 解析', async () => {
  const dir = await freshDir('claude-export');
  const file = path.join(dir, 'conversations.json');
  await write(file, [
    {
      uuid: 'c-1',
      name: '重构建议',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:10:00Z',
      chat_messages: [
        { uuid: 'm1', sender: 'human', created_at: '2026-01-01T00:00:00Z', text: '帮我拆函数', content: [{ type: 'text', text: '帮我拆函数' }] },
        { uuid: 'm2', sender: 'assistant', created_at: '2026-01-01T00:01:00Z', text: '可以这样拆', content: [{ type: 'text', text: '可以这样拆' }] },
      ],
    },
  ]);
  const buf = await fsp.readFile(file);
  const importer = pickImporter(buf, file);
  assert.equal(importer.id, 'claude-export');
  const [conv] = importer.read(buf, file);
  assert.equal(conv.title, '重构建议');
  assert.equal(conv.messages.length, 2);
});

test('归档：跨 Agent 打包后再导入', async () => {
  const homeA = await freshDir('pack-src');
  const homeB = await freshDir('pack-dst');
  const work = await freshDir('pack-work');
  await seedCodex(homeA);
  await seedClaude(homeA);
  const envA = makeEnv(homeA);

  const collected = await collectForExport(envA, { redact: false });
  assert.equal(collected.conversations.length, 2);

  const file = path.join(work, 'mix.ferrypack');
  await writePack(file, { conversations: collected.conversations, blobs: collected.blobs, password: 'pw-123456' });
  const pack = await readPack(file, { password: 'pw-123456' });
  assert.equal(pack.conversations.length, 2);

  const envB = makeEnv(homeB);
  const res = await importConversations(envB, pack.conversations, {
    target: 'claude-code',
    workspace: 'C:\\work\\demo',
    backup: false,
    blobs: pack.blobs,
  });
  assert.equal(res.results.filter((r) => !r.error).length, 2);
  const scan = await scanStores(envB, { only: ['claude-code'] });
  assert.equal(scan.results[0].sessions.length, 2);
});
