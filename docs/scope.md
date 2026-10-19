# 范围冻结：只做三个 Agent

状态：**生效**。2026-10-19 首次确认收敛范围；同日 21:40 修订：Codex 解冻、ChatGPT 移出。
本文件是范围的唯一权威来源。其他文档与本文件冲突时，以本文件为准。

---

## 1. 决定

当前阶段做**三个 Agent 的迁移**：

| Agent | 适配器文件 | 角色 |
|---|---|---|
| WorkBuddy（腾讯） | `src/adapters/workbuddy.js` | 原生写回目标 |
| Codex（OpenAI） | `src/adapters/codex.js` | 原生写回目标 |
| DeepSeek Harness | `src/adapters/deepseek-harness.js` | 只读来源 |

**ChatGPT 官方导出包移出范围**：它的会话在服务器上，本地没有可写的库，
做它只能做"只读 + 交接包"，与"搬进去接着聊"不是同一件事。
适配器代码保留，不再投入。

其余平台适配器一律**保留但不投入**：只修 bug，不加功能，不做续聊验收，不写进支持承诺。
见第 5 节的冻结清单。

> **变更记录 2026-10-19 21:40：Codex 解冻。**
> 理由：它是本机会话最多的 Agent（95 个活跃 rollout，比 WorkBuddy 的 56 个还多），
> 且 `import: true` 的写回实现早已完成、结构用 112 个真实文件逐字段对齐过（提交 `74ed140`），
> 唯一缺的是"导入后在应用里点开"这一次验收。此前按"只验证自己实际在用的 Agent"的原则把它冻掉，
> 但 Codex 恰恰是用得最多的那个 —— 冻掉它等于把唯一能与 WorkBuddy 双向的落点关掉。

---

## 2. 代码事实：三家不是对等的

| Agent | 导出 | 原生写回 | 导入后续聊 | 依据 |
|---|---|---|---|---|
| WorkBuddy | ✅ | ✅ `import: true` | ✅ `resume: true` | `workbuddy.js:60`，JSONL + `sessions` 表 |
| Codex | ✅ | ✅ `import: true` | ✅ `resume: true` | `codex.js:27`，rollout JSONL + `session_index.jsonl` |
| DeepSeek Harness | ✅ | ❌ `import: false` | ❌ | `deepseek-harness.js:37`，注释写明"原生回写格式尚未作为稳定契约" |
| ChatGPT | ✅（zip 导出包） | ❌ | ❌ | 会话在服务器上，本地无库可写 |

**结论：本阶段有两个写回目标 —— WorkBuddy 和 Codex，它们之间可以双向。**

所以产品故事是两条：

> 1. 把 DeepSeek Harness 的历史，搬进 WorkBuddy 或 Codex；
> 2. WorkBuddy 与 Codex 之间互相搬，搬过去能接着聊。

ChatGPT 那一路**物理上永远只能当来源**，且已移出范围。

---

## 3. 在范围内的链路

| # | 链路 | 模式 | 状态 |
|---|---|---|---|
| L1 | WorkBuddy（A 机）→ WorkBuddy（B 机） | 原生续聊 | ✅ **2026-10-19 端到端验通**：真实会话导入后侧栏可见、点开内容完整、发消息拿到回复、应用继续往迁移文件里追加事件 |
| L2 | DeepSeek Harness → WorkBuddy | 原生续聊（读只读源） | 读取侧 ✅ 2026-10-19 用本机 30 个真实会话验通（4,681 条消息，0 错误）；写入侧同 L1；整体在应用内点开待单独验 |
| L3 | WorkBuddy ↔ Codex | 原生续聊（双向） | 写入侧结构用 112 个真实 rollout 逐字段对齐（`74ed140`）；**`codex` 自己能否读我们写的文件，未验** |

关键风险不在写入侧，而在**读取侧的理解是否一致**：
Codex 用自己的解析器读我们生成的 rollout，任何"我们写了、我们也能读"的验证都是循环论证。
L3 的验收标准因此必须是：`codex resume` 的列表里能看见，点进去能继续发消息。

---

## 4. 验收门槛（三条链路共用）

一条链路算"迁移成功"，必须依次满足：

1. 真实数据导出，0 错误，损失清单为空或已显式列出；
2. `--dry-run` 零写盘，清单与真实写入一致；
3. 导入后 WorkBuddy 侧栏历史里**能看见**；
4. 关闭应用重启，会话**仍然在**；
5. 点开能发下一条消息并拿到回复；
6. 二次导入幂等，不产生副本；
7. `ferry rollback` 能还原。

第 5 条曾是整个项目**一次都没做过**的验收。2026-10-19 已用一条真实会话打通：
`864b7dd3`（42 条消息）→ 导入新工作区 → 重启应用 → 侧栏可见 → 点开 → 发消息 → 收到回复，
且应用开始往迁移文件里追加 `session-meta` / `message` / `reasoning` 事件（证明它不是"只读可见"而是真正接管）。
第 7 条 2026-10-19 已在**真实数据库副本**上验通：把本机真实 `workbuddy.db`（含 WAL/SHM）
连同一条真实会话复制到临时 home → 导出该会话 → 导入新工作区（自动备份）→ `ferry rollback`
→ 目录快照逐字节比对 `added 0 / removed 0 / changed 0`，回滚后扫描仍能读到原会话。
另有 9 条自动化用例守护（`test/core/backup.test.js`、`test/e2e/rollback.test.js`）。

剩下唯一没做的：**在真库上、且目标应用正在运行时的回滚**。
那一步会抹掉当前 `414ff90f` 的验收证据，需要所有者单独决定时机。

---

## 5. 冻结清单

### 平台适配器（停止投入）

`claude-code` / `cursor` / `vscode-copilot` / `cline` `roo` `kilo` / `continue` /
`gemini-cli` `qwen-code` `iflow` / `opencode` / `trae` / `vscode-chat` / `goose` / `aider`，
以及导入器 `claude-export` / `generic-json` / `markdown`。

（`codex` 已解冻，见 §1。）

处理方式：

- 代码不动，**不删**（删了要动注册表和测试，收益为零）；
- 不新增功能、不做续聊验收、不写进 README 的支持承诺；
- 只在它们的真实用户报 bug 时修。

### 平台分支（关闭）

`docs/parallel-development-plan.zh-CN.md` 里的 8 个平台分支全部作废，不再领任务：
`feat/adapter-claude-web`、`feat/adapter-claude-code`、`feat/adapter-cursor`、`feat/adapter-copilot`、
`feat/adapter-qwen`、`feat/adapter-wenxin`、`feat/adapter-deepseek`、`feat/adapter-chatgpt`
（ChatGPT 移出范围，见 §1）。

已合入的 `feat/adapter-codex`（`docs/lanes/adapter-codex.md`）**已解冻**，纳入范围。

### 不在范围外、继续做的

`feat/contracts-v1`、`feat/migration-engine`、`feat/package-conversion`、`feat/gui`、
`test/compat-e2e`、`chore/integration-release` —— 这六个是核心，与平台数量无关，全部保留。

---

## 6. 待定，需所有者决策

1. **DeepSeek Harness 要不要成为写回目标？**
   Harness 的数据全在本地（`~/.dsh/sessions` + `storages/` + 用量文件），没有云端会话存储，
   所以这不是"物理不可能"。难点是它是**事件溯源**结构：一个 518 条事件的真实会话里，
   `step/start` 与 `step/end` 各 86 条、`tool/call` 与 `tool/result` 各 110 条严格配对，
   还有 `surfaceOp` 历史改写、`request/header` 的模型配置、`turn` 边界。
   写错一处，Harness 可能拒绝加载或渲染错乱。

   要做的入口不是改代码，是**四次差分实验**（只读文件，不动 Harness）：
   新建会话发一条 → 复制文件；再发一条 → 再复制；做一次工具调用 → 再复制；
   触发一次历史压缩 → 再复制。四次 diff 就能反推出增量写入的格式契约。
   拿到样本之后才谈 `import: true`。

2. **ChatGPT 相关（handoff 交接包、官方 zip 解析）**：已移出范围。
   会话在服务器上，本地无库可写，只能当只读来源或交接包。
   代码保留（`src/adapters/exports/chatgpt.js`），不做验收、不写进支持承诺。
