# 范围冻结：只做三个 Agent

状态：**生效**。2026-10-19 首次确认收敛范围；同日 21:40 修订：Codex 解冻、ChatGPT 移出；
同日 22:10 修订：DeepSeek Harness 从只读来源升级为原生写回目标（v4 事件流 + workspace 索引）。
本文件是范围的唯一权威来源。其他文档与本文件冲突时，以本文件为准。

---

## 1. 决定

当前阶段做**三个 Agent 的迁移**：

| Agent | 适配器文件 | 角色 |
|---|---|---|
| WorkBuddy（腾讯） | `src/adapters/workbuddy.js` | 原生写回目标 |
| Codex（OpenAI） | `src/adapters/codex.js` | 原生写回目标 |
| DeepSeek Harness | `src/adapters/deepseek-harness.js` + `deepseek-harness-write.js` | 原生写回目标（v4 事件流） |

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
| DeepSeek Harness | ✅ | ✅ `import: true` | ✅ `resume: true` | `deepseek-harness.js`，`session.v4.jsonl.zstd` + `workspace.json` |
| ChatGPT | ✅（zip 导出包） | ❌ | ❌ | 会话在服务器上，本地无库可写 |

**结论：本阶段有三个写回目标 —— WorkBuddy、Codex、DeepSeek Harness，代码上任意两端都能互搬。**

但**能搬 ≠ 验通**。三条链路的验收进度必须分开看：

| 链路 | 写回实现 | 应用内续聊 |
|---|---|---|
| WorkBuddy | ✅ | ✅ 2026-10-19 验通 |
| Codex | ✅ 解析器接受，尚待人点开 | ⏳ |
| DeepSeek Harness | ✅ Harness 自带 v4 校验器接受 | ⏳ |

所以对外的说法是「三家都能当目标」，不是「三家互搬都验过了」。

ChatGPT 那一路**物理上永远只能当来源**，且已移出范围。

---

## 3. 在范围内的链路

| # | 链路 | 模式 | 状态 |
|---|---|---|---|
| L1 | WorkBuddy（A 机）→ WorkBuddy（B 机） | 原生续聊 | ✅ **2026-10-19 端到端验通**：真实会话导入后侧栏可见、点开内容完整、发消息拿到回复、应用继续往迁移文件里追加事件 |
| L2 | DeepSeek Harness → WorkBuddy | 原生续聊 | 读取侧 ✅ 2026-10-19 用本机 33 个真实会话验通（5,453 条消息，0 错误）；写入侧同日复验：七条门槛过六条（dry-run/可见/幂等/回滚全过），过程中修掉一处丢 119 条工具结果的缺陷；**只剩「点开发消息」要人在应用里做一次** |
| L3 | WorkBuddy ↔ Codex | 原生续聊（双向） | 写入侧结构用 112 个真实 rollout 逐字段对齐（`74ed140`）；**`codex` 自己能否读我们写的文件，未验** |
| L4 | WorkBuddy / Codex → DeepSeek Harness | 原生续聊 | 写侧生成 v4 事件流并登记 `storages/workspace.json`；用安装包自带的 v4 解码器（`@deepseek-ai/dsh-session-format-v3-to-v4`）离线加载通过；**应用内点开未验**；导入前必须退出 Harness |

关键风险不在写入侧，而在**读取侧的理解是否一致**：
Codex 用自己的解析器读我们生成的 rollout，任何"我们写了、我们也能读"的验证都是循环论证。
L3 的验收标准因此必须是：`codex resume` 的列表里能看见，点进去能继续发消息。

DSH 的风险换成两处：Harness 用**安装包内的 v4 解码器**读日志（已离线验过），
以及侧栏是否认 `workspace.json` 里新增的记账（结构已对齐，但没在运行中的应用里点开过）。
另外，运行中的 Harness 会把 `workspace.json` 用自己的内存状态写回，所以导入前必须退出。

---

## 4. 验收门槛（四条链路共用）

一条链路算"迁移成功"，必须依次满足：

1. 真实数据导出，0 错误，损失清单为空或已显式列出；
2. `--dry-run` 零写盘，清单与真实写入一致；
3. 导入后**目标应用的历史列表里能看见**（WorkBuddy / Codex / DSH 各自的历史列表）；
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

L2 的六条已在真库副本上验完（2026-10-19），详见 `docs/lanes/adapter-workbuddy.md` 的「L2 复验」。
副本构造方式：`workbuddy.db` 三件套 + `storage/` 复制进临时 home，`projects/` 留空，
因此「导入后 scan 能读到 N 条」「回滚后回到 0 条」都是干净断言，不依赖人眼。

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

## 6. 决策记录（原「待定，需所有者决策」）

### 6.1 DeepSeek Harness 成为写回目标（已决）

**决定（2026-10-19 22:10，所有者指示）：做。**

Harness 的数据全在本地（`~/.dsh/sessions` + `storages/`），没有云端会话存储，所以不是"物理不可能"。
此前的顾虑是事件溯源结构难写：`turn` / `step` 边界、`tool/call` 与 `tool/result` 严格配对、
`surfaceOp` 历史改写、`request/header` 模型配置。写错一处 Harness 会拒绝加载。

**没有走四次差分实验，改成了两条更硬的证据来源**（只读，不动 Harness）：

1. 安装包内自带完整的格式实现（`@deepseek-ai/dsh-session-format-v3-to-v4`、
   `dsh-session-persistence-jsonl`、`dsh-session`），v4 的 header 字段、事件生命周期与
   zstd 帧布局都有源码/文档可查，比 diff 反推更准；
2. 本机真实会话作为样本逐类事件核对（含一条 474 条消息、251 次工具调用的长会话）。

实现落在 `src/adapters/deepseek-harness-write.js`：

- 事件流：`session/title` → 每个用户消息一个 `turn`，assistant 消息各自一个 `step`，
  工具调用先由 assistant 的 `tool-call` 块"预告"，再 `tool/call`，最后 `tool/result`
  （`sourceEventSeqs` 指回 call）；没有结果的调用整对跳过并写进 losses；
- 物理格式：header 单独一帧、事件一帧，均带 zstd checksum；
- 索引：Harness 的侧栏成员资格来自 `~/.dsh/storages/workspace.json` 的
  `tables.workspaces[].sessionIds`，只写会话文件不会显示；导入会按 `cwd` 复用或新建
  workspace 记录，并把会话 id 记到最前面；
- 安全：`--dry-run` 零写盘；`workspace.json` 进备份范围；索引写失败会回滚刚写的会话文件；
  索引结构无法识别时中止，不猜、不覆盖。

**已验**：生成的日志用 Harness 自带的 v4 解码器（`sessionFormatCatalog.createRestore`）加载通过；
会话文件可被本适配器重新扫描/读取；workspace 索引的复用、新建、回滚均有自动化用例。

**未验**：重启 Harness 后在侧栏点开、发消息拿到回复。这是 L4 的最后一步，
需要在真机上做一次（会改写真实 `~/.dsh`，导入前先退出 Harness）。

### 6.2 ChatGPT 相关（已移出范围）

**ChatGPT 相关（handoff 交接包、官方 zip 解析）**：已移出范围。
会话在服务器上，本地无库可写，只能当只读来源或交接包。
代码保留（`src/adapters/exports/chatgpt.js`），不做验收、不写进支持承诺。
