/**
 * 导出过滤：--exclude-internal
 *
 * Codex 会把审批、子 Agent 这类自动运行也存成会话，整段里没有一句是用户说的。
 * 实测本机 113 个会话里 69 个属于这类 —— 默认全导出去，用户的历史里一半是噪音。
 *
 * 这里同时锁住一个坑：判定必须用**完整消息**，不能用 scan 阶段的结果。
 * scan 只读文件头部，长会话里用户第一句话可能在很后面，按 scan 判定会误杀真实对话（实测差 15 个）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { collectForExport } from '../../src/core/migrate.js';
import { freshDir, makeEnv } from '../helpers.js';

const REAL_ID = '019f0000-0000-7000-8000-0000000000aa';
const AUTO_ID = '019f0000-0000-7000-8000-0000000000bb';

const INJECT = 'The following is the Codex agent history whose request action you are assessing.';

function rollout(id, userTexts) {
  return (
    [
      {
        timestamp: '2026-10-19T02:00:00.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: { id, session_id: id, timestamp: '2026-10-19T02:00:00.000Z', cwd: 'C:\\work\\demo' },
      },
      ...userTexts.map((text, i) => ({
        timestamp: `2026-10-19T02:00:0${i + 1}.000Z`,
        ordinal: i + 1,
        type: 'response_item',
        payload: { type: 'message', id: `m${i}`, role: 'user', content: [{ type: 'input_text', text }] },
      })),
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
}

async function seedTwo(home) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '19');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `rollout-2026-10-19T02-00-00-${REAL_ID}.jsonl`), rollout(REAL_ID, ['真实的用户提问']), 'utf8');
  await fsp.writeFile(path.join(dir, `rollout-2026-10-19T02-00-01-${AUTO_ID}.jsonl`), rollout(AUTO_ID, [INJECT, INJECT]), 'utf8');
}

test('导出过滤：不加参数时两者都导出，但内部会话被标记', async () => {
  const home = await freshDir('excl-all');
  await seedTwo(home);
  const res = await collectForExport(makeEnv(home), { agents: ['codex'], redact: false });
  assert.equal(res.conversations.length, 2);

  const internal = res.conversations.filter((c) => c.meta.internalSession);
  assert.equal(internal.length, 1, '应恰好标记 1 个内部会话');
  assert.equal(internal[0].source.sessionId, AUTO_ID);
});

test('导出过滤：excludeInternal 只保留有真实用户发言的会话', async () => {
  const home = await freshDir('excl-real');
  await seedTwo(home);
  const res = await collectForExport(makeEnv(home), { agents: ['codex'], redact: false, excludeInternal: true });
  assert.equal(res.conversations.length, 1);
  assert.equal(res.conversations[0].source.sessionId, REAL_ID);
  assert.equal(res.conversations[0].meta.internalSession, undefined);
});

test('导出过滤：长会话里用户第一句话靠后，不能被误判为内部会话', async () => {
  const home = await freshDir('excl-long');
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '19');
  await fsp.mkdir(dir, { recursive: true });
  // 前 40 条全是注入，真正的用户发言在第 41 条之后 —— scan 只读有限头部会看不到它
  const texts = Array.from({ length: 40 }, () => INJECT).concat(['最后才是用户真正说的话']);
  await fsp.writeFile(path.join(dir, `rollout-2026-10-19T02-00-00-${REAL_ID}.jsonl`), rollout(REAL_ID, texts), 'utf8');

  const res = await collectForExport(makeEnv(home), { agents: ['codex'], redact: false, excludeInternal: true });
  assert.equal(res.conversations.length, 1, '真实对话被错误地排除了');
});
