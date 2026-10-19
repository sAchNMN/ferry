/**
 * DeepSeek Harness v4 会话日志写入器。
 *
 * Harness 的会话是**事件溯源**的：`session.v4.jsonl.zstd` 里第一帧只有一行 header，
 * 之后每个 append 批次一帧 zstd，每帧里一行一个 `SessionEvent`。事件必须满足
 * 严格的 turn / step / tool 生命周期（`turn/start` → `step/start` → 消息 → `step/end` →
 * `turn/end`，工具调用必须先由 assistant 消息里的 `tool-call` 块“预告”，再 `tool/call`，
 * 最后 `tool/result`），否则 Harness 会拒绝加载或渲染错乱。
 *
 * 这里只做「把 UCM 会话翻译成合法事件流」和「按 Harness 的物理格式编码」两件事，
 * 不依赖 Harness 的任何包；格式契约来自 `@deepseek-ai/dsh-session-format-v3-to-v4`
 * 与 `dsh-session-persistence-jsonl` 的公开说明（v4 当前格式）。
 *
 * 已知取舍（会写进 losses）：
 *   - 系统 / 开发者提示词不写入：那是源 Agent 的环境上下文，目标端应该用自己的；
 *   - 思考过程不写入：DeepSeek 重放需要原始推理签名，伪造签名比丢掉更危险；
 *   - 找不到结果的工具调用整对跳过：Harness 不允许 `step/end` 时还有未结算的调用。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

export const DSH_FORMAT_VERSION = 4;
export const DSH_SESSION_FILE = `session.v${DSH_FORMAT_VERSION}.jsonl.zstd`;

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

/**
 * Harness 的会话 id → 单个安全目录名。与 Harness 的 `encodeSegment` 逐字符一致：
 * 安全字符原样保留，其它 UTF-16 码元写成 `~XXXX`。
 */
export function encodeSegment(raw) {
  const value = String(raw ?? '');
  if (!value) throw new Error('会话 id 不能为空');
  if (value === '.') return '~002E';
  if (value === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * 项目目录名 `--<normalized-cwd>--`。与 Harness 的 `projectKey` 一致：
 * 分隔符（`/` `\` `:`）连续出现只记一个 `-`，不安全码元用 `~XXXX`，并截断到 251 字符。
 * 这个映射是有损的（只用于人眼可读的分组），会话 id 仍然唯一决定会话目录。
 */
export function projectKey(cwd) {
  const value = String(cwd ?? '');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** 一条会话在磁盘上的完整路径。 */
export function sessionLogPath(root, cwd, sessionId) {
  return path.join(root, projectKey(cwd), encodeSegment(sessionId), DSH_SESSION_FILE);
}

/* ------------------------------------------------------------------ */
/* Workspace 索引                                                      */
/* ------------------------------------------------------------------ */

/**
 * Harness 的侧栏不是“扫到文件就显示”，而是以 `storages/workspace.json` 里
 * `tables.workspaces[].sessionIds` 的记账为准（`dsh-workspace` 的成员资格）。
 * 只写会话文件、不登记索引，重启后侧栏里看不到 —— 第一版就踩了这个坑。
 *
 * 这个函数只做纯计算：在已初始化的索引上，把会话挂到同目录的 workspace；
 * 没有同目录 workspace 就新建一条并把它放到列表最前面。
 * 索引未初始化（首次启动前）时返回 null：交给 Harness 自己的 bootstrap 按目录归组。
 *
 * @param {object} index 解析后的 workspace.json
 * @param {{sessionId:string, cwd:string, createdAt:number|string, platform?:string, now?:string}} opts
 * @returns {{index:object, workspaceId:string, workspacePath:string, created:boolean}|null}
 */
export function attachSessionToWorkspace(index, opts = {}) {
  if (!index || typeof index !== 'object') return null;
  const global = index.global;
  const tables = index.tables;
  if (!global || global.initialized !== true) return null;
  if (!Array.isArray(global.workspaceIds)) throw new Error('workspace 索引缺少 global.workspaceIds');
  if (!tables || typeof tables.workspaces !== 'object' || tables.workspaces === null) throw new Error('workspace 索引缺少 tables.workspaces');

  const sessionId = String(opts.sessionId || '');
  const cwd = String(opts.cwd || '');
  if (!sessionId || !cwd) return null;

  const next = JSON.parse(JSON.stringify(index));
  const workspaces = next.tables.workspaces;
  const workspaceIds = next.global.workspaceIds;
  const samePath = (a, b) => (opts.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b));
  let foundId = workspaceIds.find((id) => {
    const record = workspaces[id];
    return record && typeof record.path === 'string' && samePath(record.path, cwd);
  });
  if (!foundId) {
    // 防御：表里有记录但顺序数组漏了它（会被 Harness 判为损坏），先按路径复用并补回顺序。
    const orphanId = Object.keys(workspaces).find((id) => {
      const record = workspaces[id];
      return record && typeof record.path === 'string' && samePath(record.path, cwd);
    });
    if (orphanId) {
      foundId = orphanId;
      next.global.workspaceIds = [orphanId, ...workspaceIds.filter((id) => id !== orphanId)];
    }
  }

  const now = opts.now || new Date().toISOString();
  if (foundId) {
    const record = workspaces[foundId];
    if (!Array.isArray(record.sessionIds)) record.sessionIds = [];
    if (record.sessionIds.includes(sessionId)) return null;
    record.sessionIds = [sessionId, ...record.sessionIds];
    record.updatedAt = now;
    return { index: next, workspaceId: foundId, workspacePath: record.path, created: false };
  }

  const id = crypto.randomUUID();
  const createdAt = new Date(Number(opts.createdAt) || Date.now()).toISOString();
  const pathApi = opts.platform === 'win32' ? path.win32 : path.posix;
  next.tables.workspaces[id] = {
    path: cwd,
    title: pathApi.basename(cwd) || cwd,
    sessionIds: [sessionId],
    createdAt,
    updatedAt: now,
  };
  next.global.workspaceIds = [id, ...workspaceIds];
  return { index: next, workspaceId: id, workspacePath: cwd, created: true };
}

/** workspace.json 的稳定序列化；预演与实际写盘必须用同一份字节。 */
export function serializeWorkspaceIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* 事件流                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 UCM 会话翻译成 v4 事件流。
 *
 * @param {object} conv UCM 会话
 * @param {{sessionId?:string, cwd:string, createdAt?:number|string}} opts
 * @returns {{sessionId:string, cwd:string, createdAt:number, header:object, events:object[], losses:{kind:string,detail:string}[]}}
 */
export function buildSessionLog(conv, opts = {}) {
  const sessionId = opts.sessionId || `session-${crypto.randomUUID()}`;
  const cwd = String(opts.cwd || conv?.workspace?.cwd || '');
  const createdAt = parseTime(opts.createdAt ?? conv?.createdAt) ?? Date.now();
  const header = {
    version: DSH_FORMAT_VERSION,
    id: sessionId,
    createdAt,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...(cwd ? { cwd } : {}),
  };

  const state = {
    events: [],
    losses: { system: 0, thinking: 0, tools: 0, empty: 0 },
    clock: createdAt,
    messageIds: new Set(),
    callIds: new Set(),
    turn: 0,
    provider: conv?.model?.provider,
    model: conv?.model?.id,
  };

  emit(state, 'session/title', {
    title: cleanTitle(conv?.title),
    messageSeqs: [],
    source: { kind: 'user' },
  });

  const groups = groupMessages(conv?.messages || [], state.losses);
  for (const group of groups) {
    const user = group.user;
    const userContent = user ? userBlocks(user) : [];
    if (!userContent.length && !group.rest.some((m) => m.role === 'assistant')) {
      if (user) state.losses.empty += 1;
      continue;
    }

    state.turn += 1;
    const turn = state.turn;
    emit(state, 'turn/start', { turn }, timeOf(user?.createdAt));

    let step = 0;
    if (userContent.length) {
      step += 1;
      emit(state, 'step/start', { turn, step }, timeOf(user.createdAt));
      emit(
        state,
        'user/message',
        {
          role: 'user',
          content: userContent,
          source: { kind: 'user' },
          id: messageId(state, user.id),
        },
        timeOf(user.createdAt),
        { surfaceOp: 'append' },
      );
      emit(state, 'step/end', { turn, step }, timeOf(user.createdAt));
    }

    for (let i = 0; i < group.rest.length; i++) {
      const message = group.rest[i];
      if (message.role !== 'assistant') {
        // 没有对应 assistant 调用的 tool 结果、或夹在中间的 system：跳过并记账。
        if (message.role === 'tool') state.losses.tools += 1;
        else state.losses.system += 1;
        continue;
      }

      const following = [];
      let j = i + 1;
      while (j < group.rest.length && group.rest[j].role === 'tool') {
        following.push(group.rest[j]);
        j += 1;
      }

      const built = buildAssistantStep(state, message, following);
      if (!built) {
        i = j - 1;
        continue;
      }

      step += 1;
      emit(state, 'step/start', { turn, step }, timeOf(message.createdAt));
      emit(
        state,
        'assistant/message',
        {
          turn,
          step,
          stream: [],
          message: {
            role: 'assistant',
            content: built.content,
            source: { kind: 'model', provider: built.provider, model: built.model },
            id: messageId(state, message.id),
          },
        },
        timeOf(message.createdAt),
        { surfaceOp: 'append' },
      );

      for (const call of built.calls) {
        emit(
          state,
          'tool/call',
          { turn, step, callId: call.id, name: call.name, arguments: call.arguments },
          timeOf(call.at),
        );
        const callSeq = state.events.length - 1;
        emit(
          state,
          'tool/result',
          {
            turn,
            step,
            message: {
              role: 'tool',
              source: { kind: 'tool', callId: call.id },
              toolCallId: call.id,
              content: [{ type: 'text', text: call.output }],
              isError: Boolean(call.isError),
              id: messageId(state, call.resultId),
            },
            ...(cwd ? { meta: { cwd } } : {}),
          },
          timeOf(call.at),
          { sourceEventSeqs: [callSeq], surfaceOp: 'append' },
        );
      }
      emit(state, 'step/end', { turn, step }, timeOf(message.createdAt));
      i = j - 1;
    }

    emit(state, 'turn/end', { turn, reason: { kind: 'completed' } });
  }

  return {
    sessionId,
    cwd,
    createdAt,
    header,
    events: state.events,
    losses: lossList(state.losses),
  };
}

function groupMessages(messages, losses) {
  const groups = [];
  let current = null;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system') {
      losses.system += 1;
      continue;
    }
    if (message.role === 'user') {
      current = { user: message, rest: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { user: null, rest: [] };
      groups.push(current);
    }
    current.rest.push(message);
  }
  return groups;
}

/**
 * 一条 assistant 消息 → 一条 `assistant/message` 的 content，以及要接着写入的
 * `tool/call` + `tool/result` 对。只有能在紧随其后的 tool 消息里找到结果的调用才会保留。
 */
function buildAssistantStep(state, message, following) {
  const pool = [];
  for (const toolMessage of following) {
    for (const block of toolMessage.blocks || []) {
      if (block.type === 'tool_result') pool.push({ block, message: toolMessage, used: false });
    }
  }

  const content = [];
  const calls = [];
  const sourceModel = message.model && typeof message.model === 'object' ? message.model : null;
  const provider = String(sourceModel?.provider || state.provider || 'deepseek');
  const model = String(sourceModel?.id || message.model || state.model || 'deepseek-chat');

  for (const block of message.blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (block.text) content.push({ type: 'text', text: String(block.text) });
    } else if (block.type === 'thinking') {
      state.losses.thinking += 1;
    } else if (block.type === 'tool_call') {
      const name = String(block.name || 'unknown');
      const result = takeResult(pool, block, name);
      if (!result) {
        state.losses.tools += 1;
        continue;
      }
      const id = callId(state, block.id);
      const args = argumentsText(block.input);
      content.push({ type: 'tool-call', id, name, arguments: args });
      calls.push({
        id,
        name,
        arguments: args,
        output: toolOutput(result.block),
        isError: Boolean(result.block.isError),
        resultId: result.block.id,
        at: result.message.createdAt || message.createdAt,
      });
    } else if (block.type === 'image') {
      content.push({ type: 'text', text: `[图片：${block.name || '未命名'}]` });
    } else if (block.type === 'file') {
      content.push({ type: 'text', text: `[文件：${block.name || '未命名'}]` });
    } else if (block.type === 'citation' && block.url) {
      content.push({ type: 'text', text: `${block.title || block.url}（${block.url}）` });
    }
  }

  if (!content.length) return null;
  return { content, calls, provider, model };
}

function takeResult(pool, call, name) {
  const wanted = String(call.id || '');
  let hit = wanted ? pool.find((entry) => !entry.used && String(entry.block.callId || '') === wanted) : null;
  if (!hit) hit = pool.find((entry) => !entry.used && String(entry.block.callId || '') === '' && (!entry.block.name || entry.block.name === name));
  if (!hit && name) hit = pool.find((entry) => !entry.used && !entry.block.callId && entry.block.name === name);
  if (hit) hit.used = true;
  return hit;
}

function userBlocks(message) {
  const out = [];
  for (const block of message.blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) out.push({ type: 'text', text: String(block.text) });
    else if (block.type === 'image') out.push({ type: 'text', text: `[图片：${block.name || '未命名'}]` });
    else if (block.type === 'file') out.push({ type: 'text', text: `[文件：${block.name || '未命名'}]` });
    else if (block.type === 'citation' && block.url) out.push({ type: 'text', text: `${block.title || block.url}（${block.url}）` });
  }
  return out;
}

function emit(state, type, data, at, extra = {}) {
  state.events.push({
    type,
    seq: state.events.length,
    time: nextTime(state, at),
    data,
    ...extra,
  });
}

function nextTime(state, hint) {
  const parsed = parseTime(hint);
  state.clock = parsed !== null && parsed > state.clock ? parsed : state.clock + 1;
  return state.clock;
}

function timeOf(value) {
  const parsed = parseTime(value);
  return parsed === null ? undefined : parsed;
}

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function messageId(state, raw) {
  let id = typeof raw === 'string' && raw ? raw : `m_${crypto.randomUUID()}`;
  if (state.messageIds.has(id)) id = `${id}~${crypto.randomUUID().slice(0, 8)}`;
  state.messageIds.add(id);
  return id;
}

function callId(state, raw) {
  const base = typeof raw === 'string' && raw ? raw : `call_${crypto.randomUUID()}`;
  let id = base;
  let n = 2;
  while (state.callIds.has(id)) id = `${base}~${n++}`;
  state.callIds.add(id);
  return id;
}

function argumentsText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function toolOutput(block) {
  const text = typeof block.output === 'string' ? block.output : block.output == null ? '' : JSON.stringify(block.output);
  return text || '（无输出）';
}

function cleanTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return (title || '未命名会话').slice(0, 300);
}

function lossList(counts) {
  const losses = [];
  if (counts.system) losses.push({ kind: 'system', detail: `${counts.system} 条系统 / 开发者消息未迁移（目标端会使用自己的提示词）` });
  if (counts.thinking) losses.push({ kind: 'thinking', detail: `${counts.thinking} 段思考过程未迁移（重放需要原始推理签名）` });
  if (counts.tools) losses.push({ kind: 'tools', detail: `${counts.tools} 个工具调用或结果因无法配对而跳过` });
  if (counts.empty) losses.push({ kind: 'empty', detail: `${counts.empty} 条空消息被跳过` });
  return losses;
}

/* ------------------------------------------------------------------ */
/* 物理编码                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按 Harness 的物理布局编码：header 单独一帧，事件一帧；两帧都带 checksum。
 * Harness 读取时只要求「第一帧恰好一行 header」，之后每帧是一批 JSONL 行。
 */
export function encodeSessionFile(session) {
  if (typeof zstdCompressSync !== 'function') {
    throw new Error('当前 Node 不支持写入 DeepSeek Harness 的 .jsonl.zstd 会话，请升级到 Node 22.15+');
  }
  const headerLine = JSON.stringify({ type: 'session', ...session.header });
  const frames = [compressFrame(`${headerLine}\n`)];
  if (session.events.length) {
    const body = session.events.map((event) => JSON.stringify(event)).join('\n');
    frames.push(compressFrame(`${body}\n`));
  }
  return Buffer.concat(frames);
}

function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
}
