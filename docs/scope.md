# 范围冻结：只做三个 Agent

状态：**生效**。2026-10-19 由项目所有者确认收敛范围。
本文件是范围的唯一权威来源。其他文档与本文件冲突时，以本文件为准。

---

## 1. 决定

当前阶段**只做三个 Agent 的迁移**：

| Agent | 适配器文件 | 角色 |
|---|---|---|
| WorkBuddy（腾讯） | `src/adapters/workbuddy.js` | 唯一的原生写回目标 |
| DeepSeek Harness | `src/adapters/deepseek-harness.js` | 只读来源 |
| ChatGPT（官方导出包） | `src/adapters/exports/chatgpt.js` | 只读来源 |

其余全部适配器代码**保留但不投入**：只修 bug，不加功能，不做续聊验收，不写进支持承诺。
见第 5 节的冻结清单。

---

## 2. 代码事实：三个不是对等的

这不是排期问题，是能力问题。当前代码里的 `capabilities`：

| Agent | 导出 | 原生写回 | 导入后续聊 | 依据 |
|---|---|---|---|---|
| WorkBuddy | ✅ | ✅ `import: true` | ✅ `resume: true` | `workbuddy.js:59`，JSONL + `sessions` 表 |
| DeepSeek Harness | ✅ | ❌ `import: false` | ❌ | `deepseek-harness.js:26`，注释写明"原生回写格式尚未作为稳定契约" |
| ChatGPT | ✅（zip 导出包） | ❌ | ❌ | 会话在服务器上，本地无库可写 |

**结论：本阶段只有一个写回目标，就是 WorkBuddy。**

所以产品故事不是"三个平台互迁"，而是：

> 把 DeepSeek Harness 和 ChatGPT 的历史，搬进 WorkBuddy。

三向互迁需要先给 DeepSeek Harness 定写回格式，且 ChatGPT 那一路**物理上永远做不到**——只能当来源或交接包。

---

## 3. 在范围内的三条链路

统一目标写法：`--to workbuddy`。

| # | 链路 | 模式 | 状态 |
|---|---|---|---|
| L1 | WorkBuddy（A 机）→ WorkBuddy（B 机） | 原生续聊 | ✅ **2026-10-19 端到端验通**：真实会话导入后侧栏可见、点开内容完整、发消息拿到回复、应用继续往迁移文件里追加事件 |
| L2 | DeepSeek Harness → WorkBuddy | 原生续聊（读只读源） | 读取侧 ✅ 2026-10-19 用本机 31 个真实会话验通（4,681 条消息 / 2.64M 字符，0 错误）；写入侧同 L1（已验通）；L2 整体在应用内点开尚未单独验 |
| L3 | ChatGPT 导出 zip → WorkBuddy | 原生续聊 | 导入侧同 L1（已验通）；ChatGPT 解析侧待真包验证 |

L2 / L3 的"续聊"能力完全继承 WorkBuddy 写回，各自的风险只在**读取侧**。
这意味着：把 L1 的真实续聊验通，L2/L3 就只剩解析器的问题，不会再有新的写回风险。

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
剩下第 7 条（`ferry rollback` 还原）尚未在真机上走过一遍。

---

## 5. 冻结清单

### 平台适配器（停止投入）

`claude-code` / `cursor` / `vscode-copilot` / `cline` `roo` `kilo` / `continue` /
`gemini-cli` `qwen-code` `iflow` / `opencode` / `trae` / `vscode-chat` / `goose` / `aider` / `codex`，
以及导入器 `claude-export` / `generic-json` / `markdown`。

处理方式：

- 代码不动，**不删**（删了要动注册表和测试，收益为零）；
- 不新增功能、不做续聊验收、不写进 README 的支持承诺；
- 只在它们的真实用户报 bug 时修。

### 平台分支（关闭）

`docs/parallel-development-plan.zh-CN.md` 里的 8 个平台分支中，只保留 `feat/adapter-chatgpt`。
以下分支**作废**，不再领任务：`feat/adapter-claude-web`、`feat/adapter-claude-code`、
`feat/adapter-cursor`、`feat/adapter-copilot`、`feat/adapter-qwen`、`feat/adapter-wenxin`、
`feat/adapter-deepseek`。

已合入的 `feat/adapter-codex`（`docs/lanes/adapter-codex.md`）**冻结维护**：代码留下，不再扩展。

### 不在范围外、继续做的

`feat/contracts-v1`、`feat/migration-engine`、`feat/package-conversion`、`feat/gui`、
`test/compat-e2e`、`chore/integration-release` —— 这六个是核心，与平台数量无关，全部保留。

---

## 6. 待定，需所有者决策

1. **DeepSeek Harness 要不要成为写回目标？**
   要 = 新增一份 `docs/format.md` 的 DSH 写回规范 + 一套真实格式样本，工作量不小。
   不要 = 它就只能是只读来源，L2 单向进 WorkBuddy。
2. **ChatGPT 要不要做 handoff 交接包？**
   不做原生写回是确定的；但"压成 Markdown 粘贴给别的 AI"这条路还要不要留。
3. **ChatGPT 的解析用哪种包？**
   官方 zip（`conversations.json` + 分支树）和普通 JSON 是两套结构，先按哪个验。
