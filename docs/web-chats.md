# 云端对话怎么迁

ChatGPT、Claude、Gemini、DeepSeek、Kimi、豆包、通义千问、文心一言、智谱清言、腾讯元宝、
Manus、Genspark、Perplexity 等产品的对话都在**厂商服务器**上，按账号存储。

这意味着：

- 换电脑后登录同一个账号，历史自然就在 —— 这是官方唯一支持的"无缝续聊"。
- 想换一个厂商/模型继续同一条对话，没有通用的"导入账号"接口，也没有本地数据库可以写。
- 任何声称能"把历史注入 ChatGPT 账号"的工具，做的都是模拟请求或改前端缓存，既不稳定也有封号风险。

Ferry 不做这种事。它提供两条**真实可用**的路径：

1. **官方导出 → 归档**：把 ChatGPT / Claude 的官方导出包读进 Ferry，统一管理、检索、转成本地 Agent 的会话。
2. **交接包**：把任意会话压成一份带上下文的 Markdown，粘贴到目标 AI，让它接着干。

---

## 一、官方导出

### ChatGPT

1. 头像 → Settings → Data controls → **Export data** → 确认。
2. 邮箱会收到下载链接（通常几分钟到 24 小时）。
3. 得到 `ChatGPT-export-….zip`，**不用解压**。

```bash
ferry import ChatGPT-export.zip --to handoff -o ./chatgpt-handoff
# 或先看看内容
ferry import ChatGPT-export.zip --list
```

Ferry 会沿 `current_node` 回溯主分支，把 `text` / `multimodal_text` / `code` / `execution_output`
/ `thoughts` 分别映射为文本、工具调用、工具结果与思考块。

### Claude

1. Settings → Privacy → **Export data**。
2. 收到 `conversations.json`（或 zip）。

```bash
ferry import conversations.json --to claude-code --workspace D:\work\proj
```

### DeepSeek Harness（本地会话）

DeepSeek Harness 的本地会话会落在 `.dsh/sessions/` 下，Ferry 可以读取普通 JSONL 和拼接的 `.jsonl.zstd`，
再迁移到 Claude Code、Codex 等支持原生导入的本地 Agent：

```bash
ferry export --agent deepseek-harness -o deepseek.ferrypack
ferry import deepseek.ferrypack --to claude-code --workspace D:\work\proj
```

### Gemini

Google Takeout → **My Activity → Gemini Apps**，导出 JSON 或 HTML。
Takeout 的结构是"活动记录"而非对话树，Ferry 目前不直接解析；推荐用浏览器打开后
按「用户 / Gemini」两栏复制成 Markdown，再用 `ferry import xxx.md --to handoff`。
（如果你有更规整的 JSON，可以用通用 JSON 导入器。）

---

## 二、交接包

一条命令把本机任意 Agent 的会话变成可粘贴的上下文：

```bash
# 单个会话
ferry export --agent codex --id "支付重构" --to handoff -o ./handoff

# 某段时间的全部
ferry export --all --since 14d --to handoff -o ./handoff
```

生成的文件大致长这样：

```markdown
# 会话交接包：支付重构

- 来源：Claude Code
- 时间：2026-10-18 16:20
- 项目：`D:\work\payment`
- 模型：claude-sonnet-4-5

---

以下是我与另一个 AI Agent 的完整历史对话。请通读后**接着最后的进度继续工作**，
不要重复已经完成的步骤；如有歧义先问我。

## 对话全文

### USER
…
### ASSISTANT
…
[tool:shell] {"command":"npm test"}

---

**请从最后一条用户请求继续，保持之前已确认的决策与约束。**
```

把它作为目标 AI 的第一条消息发出去即可。工具调用默认保留（截断到 600 字符），
思考块默认不包含，避免把内部推理当成事实。

技巧：

- 目标模型上下文不够时，加 `--last 40`（或手工删掉前面的轮次），保留最近的关键决策。
- 长期项目建议每个里程碑生成一次交接包，按日期命名，形成可检索的项目记忆。
- 敏感内容会按导出规则自动脱敏（默认开启）。

---

## 三、各产品的现实情况

| 产品 | 官方导出 | Ferry 直接解析 | 建议 |
|---|---|---|---|
| ChatGPT | ✅ 全量 zip | ✅ | 导出 zip → 归档 / 交接包 |
| Claude | ✅ 全量 JSON | ✅ | 同上 |
| Gemini | ✅ Takeout（活动记录） | ❌ | 复制为 Markdown 或通用 JSON |
| DeepSeek 网页版 | ❌ | ❌ | 复制对话为 Markdown → `ferry import` |
| DeepSeek Harness | 本地 JSONL / zstd | ✅（只读） | 导出后迁移到本地 Agent |
| Kimi | ❌ | ❌ | 同上 |
| 豆包 | ❌ | ❌ | 同上 |
| 通义千问 | ❌ | ❌ | 同上 |
| 文心一言 | ❌ | ❌ | 同上 |
| 智谱清言 | ❌ | ❌ | 同上 |
| 腾讯元宝 | ❌ | ❌ | 同上 |
| Manus | 视版本 | ❌ | 任务产物 Markdown + 交接包 |
| Perplexity | 部分（Collections） | ❌ | 交接包 |

> 表格会随产品更新变化。Ferry 的设计是"适配器可插拔"：一旦某家开放了导出格式，
> 加一个 `src/adapters/*.js` 就能接入，不需要改核心。
