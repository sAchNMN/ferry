/**
 * 测试辅助：在临时目录里伪造一台"电脑"。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createEnv } from '../src/core/env.js';

export const ROOT = path.join(process.cwd(), '.tmp', 'tests');

export async function freshDir(name) {
  const dir = path.join(ROOT, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function makeEnv(home, extra = {}) {
  return createEnv({
    home,
    platform: 'win32',
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    xdgConfig: path.join(home, 'AppData', 'Roaming'),
    xdgData: path.join(home, 'AppData', 'Local'),
    ferryHome: path.join(home, '.ferry'),
    cwd: home,
    ...extra,
  });
}

export async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return file;
}

export function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* 各 Agent 的最小 fixture                                            */
/* ------------------------------------------------------------------ */

export async function seedCodex(home, cwd = 'C:\\work\\demo') {
  const id = '019f0000-0000-7000-8000-000000000001';
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '19');
  const file = path.join(dir, `rollout-2026-10-19T10-00-00-${id}.jsonl`);
  const lines = [
    {
      timestamp: '2026-10-19T02:00:00.000Z',
      type: 'session_meta',
      payload: { id, timestamp: '2026-10-19T02:00:00.000Z', cwd, originator: 'codex_cli', cli_version: '0.160.0', model_provider: 'openai' },
    },
    {
      timestamp: '2026-10-19T02:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 't1', cwd, model: 'gpt-5-codex', approval_policy: 'on-request' },
    },
    {
      timestamp: '2026-10-19T02:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修复登录页的报错' }] },
    },
    {
      timestamp: '2026-10-19T02:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'call_1' },
    },
    {
      timestamp: '2026-10-19T02:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'FAIL src/login.test.ts' },
    },
    {
      timestamp: '2026-10-19T02:00:05.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已定位到空指针，正在修复。' }] },
    },
  ];
  await write(file, jsonl(lines));
  await write(
    path.join(home, '.codex', 'session_index.jsonl'),
    JSON.stringify({ id, thread_name: '修复登录页报错', updated_at: '2026-10-19T02:00:05.000Z' }) + '\n',
  );
  return { id, file };
}

export async function seedClaude(home, cwd = '/home/u/proj') {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const file = path.join(home, '.claude', 'projects', slug, `${id}.jsonl`);
  const lines = [
    {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId: id,
      version: '2.0.0',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: '把 README 补全' },
      uuid: 'u1',
      timestamp: '2026-10-18T08:00:00.000Z',
    },
    {
      parentUuid: 'u1',
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: '我先看一下现有内容。' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/home/u/proj/README.md' } },
        ],
      },
      uuid: 'a1',
      timestamp: '2026-10-18T08:00:02.000Z',
    },
    {
      parentUuid: 'a1',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# Demo' }] },
      uuid: 'u2',
      timestamp: '2026-10-18T08:00:03.000Z',
    },
    {
      parentUuid: 'u2',
      type: 'assistant',
      message: { id: 'msg_2', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '已补全。' }] },
      uuid: 'a2',
      timestamp: '2026-10-18T08:00:05.000Z',
    },
    { type: 'summary', summary: '补全 README', leafUuid: 'a2' },
  ];
  await write(file, jsonl(lines));
  return { id, file, slug };
}

export async function seedCline(home, variant = 'saoudrizwan.claude-dev') {
  const taskId = '1750000000000';
  const dir = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', variant, 'tasks', taskId);
  await write(path.join(dir, 'task_metadata.json'), {
    task: '给按钮加 loading',
    createdAt: 1750000000000,
    cwdOnTaskInitialization: 'C:\\work\\ui',
  });
  await write(path.join(dir, 'api_conversation_history.json'), [
    { role: 'user', content: [{ type: 'text', text: '给按钮加 loading' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来改。' },
        { type: 'tool_use', id: 'toolu_1', name: 'write_to_file', input: { path: 'src/Button.tsx', content: '...' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
  ]);
  await write(path.join(dir, 'ui_messages.json'), [
    { ts: 1750000000000, type: 'say', say: 'task', text: '给按钮加 loading' },
    { ts: 1750000001000, type: 'say', say: 'text', text: '我来改。' },
  ]);
  return { taskId, dir, variant };
}

export async function seedContinue(home) {
  const id = 'cont-1234';
  const dir = path.join(home, '.continue', 'sessions');
  await write(path.join(dir, `${id}.json`), {
    sessionId: id,
    title: '写单元测试',
    workspaceDirectory: 'C:\\work\\lib',
    history: [
      { message: { role: 'user', content: '给 utils 写测试' } },
      { message: { role: 'assistant', content: '好的，覆盖边界情况。' } },
    ],
  });
  return { id, dir };
}

export async function seedGemini(home) {
  const projectHash = 'deadbeef';
  const sessionId = 'gem-1';
  const dir = path.join(home, '.gemini', 'tmp', projectHash, 'chats');
  await write(path.join(dir, 'session-2026-10-17T00-00-00-gem-1.json'), {
    sessionId,
    projectHash,
    startTime: '2026-10-17T00:00:00.000Z',
    lastUpdated: '2026-10-17T00:05:00.000Z',
    messages: [
      { id: 'm1', timestamp: '2026-10-17T00:00:00.000Z', type: 'user', content: '解释这段正则' },
      {
        id: 'm2',
        timestamp: '2026-10-17T00:00:02.000Z',
        type: 'gemini',
        model: 'gemini-2.5-pro',
        content: '这段正则匹配邮箱。',
        thoughts: [{ subject: '分析', description: '先拆解字符类' }],
      },
    ],
  });
  await write(path.join(home, '.gemini', 'projects.json'), { 'C:\\work\\re': projectHash });
  return { projectHash, sessionId, dir };
}

export async function seedDeepSeekHarness(home, cwd = 'C:\\work\\deepseek') {
  const sessionId = 'dsh-session-1';
  const root = path.join(home, '.dsh', 'sessions', '--C-work-deepseek--', sessionId);
  const file = path.join(root, 'session.jsonl');
  await write(
    file,
    jsonl([
      {
        type: 'session',
        version: 4,
        id: sessionId,
        createdAt: 1760000000000,
        cwd,
        isSeeded: false,
        delegationDepth: 0,
      },
      { type: 'session/title', time: 1760000000001, data: { title: '修复 DeepSeek 迁移' } },
      {
        type: 'system/message',
        time: 1760000000002,
        data: {
          turn: 0,
          step: 0,
          message: { role: 'system', content: [{ type: 'text', text: '你是一个编码助手。' }], id: 'sys-1' },
        },
      },
      {
        type: 'user/message',
        time: 1760000000003,
        data: { role: 'user', content: [{ type: 'text', text: '请检查迁移脚本。' }], id: 'user-1' },
      },
      {
        type: 'request/context',
        time: 1760000000004,
        data: { provider: 'deepseek-official', model: 'deepseek-chat' },
      },
      {
        type: 'assistant/message',
        time: 1760000000005,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '先看迁移入口。' },
              { type: 'tool-call', id: 'call-1', name: 'shell', arguments: '{"command":["npm","test"]}' },
            ],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
            id: 'assistant-1',
          },
          stream: [],
        },
      },
      {
        type: 'tool/result',
        time: 1760000000006,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', content: [{ type: 'text', text: 'FAIL migration.test.js' }], id: 'tool-1' },
        },
      },
      {
        type: 'assistant/message',
        time: 1760000000007,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '已定位迁移入口。' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
            id: 'assistant-2',
          },
          stream: [],
        },
      },
    ]),
  );
  return { sessionId, file, root, cwd };
}

export async function seedTrae(home, app = 'Trae', cwd = 'C:\\work\\trae-proj') {
  const wsHash = 'abc123def456';
  const sessionId = 'c0ffee00-1111-4222-8333-444455556666';
  const dir = path.join(home, 'AppData', 'Roaming', app, 'User', 'workspaceStorage', wsHash, 'chatSessions');
  const file = path.join(dir, `${sessionId}.jsonl`);
  const uri = `file:///${cwd.replace(/\\/g, '/').replace(':', '%3A')}`;
  await write(path.join(home, 'AppData', 'Roaming', app, 'User', 'workspaceStorage', wsHash, 'workspace.json'), { folder: uri });
  await write(
    file,
    JSON.stringify({
      kind: 0,
      v: {
        version: 3,
        creationDate: 1750000000000,
        sessionId,
        requests: [
          {
            requestId: 'r1',
            message: { text: '给登录页加验证码', parts: [{ text: '给登录页加验证码' }] },
            response: [
              { kind: 'markdownContent', content: { value: '先加图形验证码，再做频率限制。' } },
              { kind: 'toolInvocationSerialized', toolId: 'editFile', toolCallId: 'call_1', invocationMessage: { value: 'edit login.tsx' }, isComplete: true },
            ],
            timestamp: 1750000000000,
            modelId: 'claude-sonnet-4-5',
          },
        ],
        inputState: { mode: { id: 'agent', kind: 'agent' }, selectedModel: { identifier: 'auto' }, inputText: '', attachments: [], selections: [] },
      },
    }) + '\n',
  );
  return { sessionId, dir, file, cwd, app };
}

/* ------------------------------------------------------------------ */
/* 极简 ZIP 写入（只用于测试 zip 读取）                                */
/* ------------------------------------------------------------------ */

import zlib from 'node:zlib';

export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
