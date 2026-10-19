# 适配器开发指南

Ferry 的适配器分两类：

- **Store**：本机 Agent 的会话仓库，能扫描、读取，可选原生导入。
- **Importer**：外部导出文件（zip / json / md），只读。

每个适配器都是纯 ESM 模块，只依赖 `src/core`，不引入第三方包。

## 1. Store 协议

```js
import { defineStore } from '../core/adapter.js';
import { block, createConversation } from '../core/ucm.js';

export default defineStore({
  id: 'my-agent',            // 唯一 id，CLI --agent 用它
  name: 'My Agent',
  vendor: 'ACME',
  category: 'cli',           // cli | ide | desktop | chat | framework
  region: 'global',          // global | cn
  docs: 'https://…',
  capabilities: {
    scan: true, export: true, import: true,
    resume: true,            // 导入后能原生续聊
    attachments: false,      // 是否能保存图片附件
    tools: true,             // 是否保留工具调用
  },

  /** 轻量索引：不要在这里读全文 */
  async scan(env) {
    return [{
      id: 'session-id',
      title: '标题',
      path: '…',             // 本地文件或逻辑位置
      createdAt: 'ISO',
      updatedAt: 'ISO',
      bytes: 1234,
      workspace: 'C:\\work\\proj',
      preview: '首条用户消息',
      meta: { /* 适配器私有字段 */ },
    }];
  },

  /** 完整读取，返回 UCM 会话 */
  async read(env, ref, ctx) {
    // ctx.blobs.add(buffer, { mime, name }) -> sha256
    return createConversation({ /* … */ });
  },

  /** 可选：原生导入 */
  async import(env, conv, opts) {
    // opts: { workspace, blobs, dryRun, log, agent }
    return {
      writes: [{ path, bytes, kind }],
      notes: ['给用户看的提示'],
      resume: { cwd, command: 'my-agent --resume <id>', sessionId },
    };
  },

  resumeHint(conv, resume) {
    return '重启应用后在历史里选择该会话';
  },
});
```

### 硬性约定

1. **只通过 `env` 拿路径**，不要读 `process.env` 或 `os.homedir()`——否则测试与 `--home` 会失效。
2. **`dryRun` 时绝对不能写盘**：不建目录、不备份、不碰数据库。先算出路径再 `if (opts.dryRun) return …`。
3. **`scan` 要便宜**：只读文件头 / 目录项，不要解析整个会话。
4. **`read` 要容错**：单行损坏跳过，不要抛异常拖垮整次导出（`safeRead` 会兜底，但体验更好）。
5. **导入要登记索引**：只写会话文件通常不会出现在应用的历史列表里，必须同步 index / DB。
6. 写数据库用 `src/core/sqlite.js` 的 `insertLoose`：以现有行为模板，动态列，兼容 schema 变化。

### env 提供的路径

```
env.home / env.appData / env.localAppData
env.xdgConfig / env.xdgData
env.codeUser('code'|'cursor'|'windsurf'|'trae'|'kiro'|…)
env.globalStorage(host) / env.workspaceStorage(host)
env.ferryHome
```

## 2. Importer 协议

```js
import { defineImporter } from '../core/adapter.js';

export default defineImporter({
  id: 'my-export',
  name: '某某导出包',
  vendor: 'ACME',
  extensions: ['.zip', '.json'],
  detect(buf, filename) { return true/false; },   // 必须廉价且不抛异常
  read(buf, filename) { return [/* UCM conversations */]; },
});
```

`detect` 按注册顺序调用，第一个命中者生效，所以要写得**具体**，避免把别人的 JSON 抢走。

## 3. 已知存储地图

| 产品 | 位置 | 关键格式 |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` | 行事件，`uuid`/`parentUuid` 链，`tool_result` 在 user 消息里 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta` / `response_item` / `event_msg`；索引 `session_index.jsonl`；`state_N.sqlite` 的 `threads` |
| Cursor | `<User>/globalStorage/state.vscdb` | `cursorDiskKV`：`composerData:<id>` + `bubbleId:<cid>:<bid>` |
| Copilot Chat | `workspaceStorage/<hash>/chatSessions/*.jsonl` | `{kind:0,v:…}` 快照 + `{kind:1,k:[…],v:…}` 路径补丁 |
| Cline 系 | `globalStorage/<ext>/tasks/<id>/` | `api_conversation_history.json` + `ui_messages.json` + `task_metadata.json` |
| Continue | `~/.continue/sessions/*.json` | `history[].message` |
| Gemini 系 | `~/.gemini/tmp/<hash>/chats/*.json` | `messages[]`，工具在 `toolCalls` |
| Goose | `~/.local/share/goose/sessions/*.jsonl` | `{role, content:[{type:'text'|'toolRequest'|'toolResponse'}]}` |
| OpenCode | `~/.local/share/opencode/storage/{session,message,part}/…` | 三级 JSON |
| Aider | `~/.aider.chat.history.md` | `####` 用户 / `#` 助手 |

版本会变。适配器应当"嗅探 + 容错"，而不是假设字段永远存在。

## 4. 测试

在 `test/helpers.js` 里造一个"假电脑"：

```js
const home = await freshDir('my-agent');
await write(path.join(home, '.my-agent', 'sessions', '1.json'), payload);
const env = makeEnv(home);
const [ref] = await getStore('my-agent').scan(env);
const conv = await getStore('my-agent').read(env, ref, { blobs: new Map() });
```

至少覆盖：扫描数量、标题、工作区、工具调用、时间戳；有导入的还要覆盖"导入 → 重新扫描能看见"。

```bash
# 默认：进程隔离，Node 22.5+ 均可运行
node --test test/core.test.js test/adapters.test.js

# 受限环境（不允许 Node 测试器 spawn 子进程）且 Node ≥ 24 时用这个
node --test --test-isolation=none test/core.test.js test/adapters.test.js
```

> `--test-isolation=none` 用于部分不允许 spawn 子进程的沙箱，但该参数 **Node 24 起才存在**。
> 在 Node 22 上会直接报 `bad option`，所以默认脚本不带你，需要时显式用 `npm run test:noiso`。

## 5. 注册

编辑 `src/adapters/index.js`：

```js
import myAgent from './my-agent.js';
export const stores = [/* … */, myAgent];
```

能力矩阵、CLI、Web UI 会自动出现，不需要改别的地方。
