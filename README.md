# Ferry · AI 会话摆渡

[![test](https://github.com/sAchNMN/ferry/actions/workflows/test.yml/badge.svg)](https://github.com/sAchNMN/ferry/actions/workflows/test.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-informational)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> 把 AI Agent 的对话历史，从一台电脑完整搬到另一台，并在目标 Agent 里**接着用**。

Ferry 是一个零依赖、跨平台（Windows / macOS / Linux）的本地工具。它读取各家的本地会话存储，
归一化成统一格式，打包成一个可加密的文件；换电脑后写回目标 Agent 的原生目录，
并同步它的索引/数据库，让会话直接出现在历史列表里。

```
本机所有 Agent ──扫描──▶ 统一会话模型 ──打包──▶ backup.ferrypack（可加密）
                                                      │
换电脑 ◀── 原生写入 + 登记索引 + 自动备份 ◀── 解包 ───┘
```

- **零安装**：只需要 Node.js ≥ 22.5，没有 npm 依赖，不联网。
- **真·续聊**：不是导出成 Markdown 让你重开一段，而是写进目标 Agent 的原生存储。
  **WorkBuddy 已在真实应用里端到端验通**（导入 → 侧栏可见 → 点开发消息 → 拿到回复），
  其余平台请先看下面的「验证状态」。
- **可回滚**：每次写入前自动备份，一条命令撤销。
- **默认脱敏**：导出时把 API Key、Token 打码，避免把密钥带进归档。
- **幂等**：同一个归档重复导入不会产生副本（台账在 `~/.ferry/imported.json`，`--force` 可强制重导）。

---

## 30 秒上手

```bash
# 1. 看看这台电脑上有什么
node bin/ferry.js scan

# 2. 全部打包（加密可加 --encrypt）
node bin/ferry.js export --all -o backup.ferrypack

# 3. 把 backup.ferrypack 拷到新电脑，先看它准备写什么
node bin/ferry.js import backup.ferrypack --to codex --dry-run

# 4. 确认后真正写入
node bin/ferry.js import backup.ferrypack --to codex --workspace D:\work\myproj

# 5. 按提示接着用
codex resume
```

图形界面：

```bash
node bin/ferry.js ui          # 打开 http://127.0.0.1:7099
```

Windows 也可以直接双击 `start.cmd`；macOS / Linux 用 `./start.sh`。

---

## 范围（2026-10-19 收敛，同日修订）

当前承诺三个 Agent 的迁移：**WorkBuddy**、**Codex**、**DeepSeek Harness**。

三家都能导出，也都在代码上支持原生写回 —— 所以任意两端之间都能搬。

```
WorkBuddy ←──→ Codex
    ↕
DeepSeek Harness
```

**但「能搬」不等于「验过」**：目前只有 WorkBuddy 这一格在真实应用里点开续聊验通，
Codex 与 DeepSeek Harness 的写回都还没在应用里点开过（见下面的验证状态表）。

DeepSeek Harness 的写回走它的 v4 事件流（会话日志 + `workspace.json` 索引），
是目前最新、也最需要真机验收的一条。ChatGPT 已移出范围 —— 它的会话在服务器上，本地没有可写的库。

其余平台（Claude Code、Cursor、Copilot、Cline 系、Continue、Gemini CLI、Trae 等）
代码保留但**已冻结**：只修 bug，不做续聊验收，不算支持承诺。详见 [docs/scope.md](docs/scope.md)。

> 下面「支持什么」里的矩阵是代码历史能力记录，**不代表当前支持范围**。

## 支持什么

### 验证状态（先看这里）

Ferry 的每个平台支持按"证据等级"分三档，**不要按"代码里有"判断能不能用**：

| 档位 | 含义 |
|---|---|
| ✅ 真实数据验证 | 用作者本机的真实会话跑通过 |
| 🧪 夹具验证 | 只有合成测试数据，没碰过真实文件 |
| ⏳ 未验证 | 代码写了，但一次都没测过 |

「真实应用点开续聊」这一档要求的证据是：**在目标应用里点开迁移进来的会话，发一条新消息并拿到回复**。
结构对齐不算，能扫描到也不算。

当前实况：

| 平台 | 导出 | 导入 | 真实应用点开续聊 |
|---|---|---|---|
| **WorkBuddy**（腾讯） | ✅ 63 个真实会话 / 17k 条消息 | ✅ 写回字段与真实文件逐项对齐 | ✅ **2026-10-19 实测通过**：真实会话导入后侧栏可见、点开内容完整、发消息拿到回复，且应用继续往迁移文件里追加事件 |
| **DeepSeek Harness** | ✅ 30 个真实会话 / 4,681 条消息，0 错误 | ✅ 生成 v4 事件流并登记 `workspace.json`；用 Harness 安装包自带的 v4 校验器（header / 每行准入 / 关系）离线全过 | ⏳ 待退出应用后重启点开 |
| **Codex**（OpenAI） | ✅ 95 个活跃 rollout（含归档共 113 个） | ✅ 写回结构与真实 rollout 逐字段对齐 | ⏳ 待作者验证 |
| **GitHub Copilot Chat** | ✅ 26 个真实会话 | 🧪 | ⏳ |
| Claude Code / Cursor / Cline / Continue / Trae / Gemini CLI / Qwen / iFlow / OpenCode 等 | 🧪 | 🧪 | ⏳ |

一句话：**WorkBuddy 这一路已经端到端验通，可以真用；Codex 结构对齐但没人点开过；DeepSeek Harness 的写回已被官方解码器接受，但还没在应用里点开过。其余平台请自己先在一个不重要的会话上试。**

### 实现清单（下面这些是"代码支持"，不等于"验证过"）

### 能"原生导入、重启即续聊"的

| Agent | 厂商 | 会话存储 | 导入后怎么继续 |
|---|---|---|---|
| Claude Code | Anthropic | `~/.claude/projects/<slug>/*.jsonl` | `claude --resume <id>` |
| Codex | OpenAI | `~/.codex/sessions/**/rollout-*.jsonl` + `threads` 表 | `codex resume <id>` / 应用历史列表 |
| Cursor | Anysphere | `<User>/globalStorage/state.vscdb` | Composer 历史（实验性） |
| GitHub Copilot Chat | GitHub / Microsoft | `workspaceStorage/*/chatSessions/*.jsonl` + `session-store.db` | VS Code Chat 历史 |
| Cline / Roo Code / Kilo Code | Cline 系 | `globalStorage/<ext>/tasks/<id>/` | 扩展的 Task 历史 |
| Continue | Continue | `~/.continue/sessions/*.json` | Continue 历史 |
| Gemini CLI | Google | `~/.gemini/tmp/<hash>/chats/*.json` | `gemini --resume` |
| Qwen Code | 阿里巴巴 | `~/.qwen/tmp/<hash>/chats/*.json` | `qwen --resume` |
| iFlow CLI | 心流 AI | `~/.iflow/tmp/<hash>/chats/*.json` | `iflow --resume` |
| OpenCode | SST | `~/.local/share/opencode/storage/**` | `opencode --session <id>` |
| Trae / Trae CN | 字节跳动 | `<User>/workspaceStorage/*/chatSessions/*.jsonl` | 聊天历史（实验性） |
| Windsurf / Kiro / VSCodium | 多家 | 同上（VS Code 系格式） | 聊天历史（实验性） |
| WorkBuddy | 腾讯 | `~/.workbuddy/projects/<slug>/<sessionId>.jsonl` + `workbuddy.db` 的 `sessions` 表 | 重启应用，侧栏历史列表 |
| DeepSeek Harness | DeepSeek | `~/.dsh/sessions/<project>/<sessionId>/session.v4.jsonl.zstd` + `~/.dsh/storages/workspace.json` | 先退出再重启应用，左侧历史列表 |

### 只能导出（只读解析）

| Agent | 说明 |
|---|---|
| Goose（Block） | 会话为 JSONL，可导出、可转交接包 |
| Aider | `.aider.chat.history.md`，可导出、可转交接包 |

### 通过官方导出包导入

| 格式 | 从哪来 |
|---|---|
| ChatGPT 官方导出 | 设置 → 数据控制 → 导出数据（`.zip`，直接选 zip 即可） |
| Claude 官方导出 | Settings → Privacy → Export data |
| 通用 JSON 对话 | 任何 `[{role, content}]` 结构 |
| Markdown / 纯文本 | 按 `## 用户 / ## 助手` 或 `User:/Assistant:` 切分 |

### 云端产品：交接包

ChatGPT、Claude、Gemini、DeepSeek、Kimi、豆包、通义千问、文心一言、智谱清言、腾讯元宝、
Manus、Genspark、Perplexity 等产品的会话存在**服务器上**，物理上无法写进对方的账号，
也没有"本地数据库"可以塞。

Ferry 对这类产品的方案是**交接包**：把历史压成一份结构清晰、带元信息的 Markdown，
粘贴到目标 AI 的第一条消息里，让它"接着上次继续"。

```bash
ferry import ChatGPT-export.zip --to handoff -o ./handoff
```

> 这类产品真正跨设备"无缝续聊"的唯一官方方式是登录同一个账号 —— 这不是工具能绕过的限制。
> Ferry 不假装能做到，而是给你一条真正可用的路。

---

## 迁移是怎么做到"直接接着用"的

以 Codex 为例，只把 JSONL 复制过去是不够的：应用还依赖索引和 SQLite 里的 `threads` 记录。
Ferry 在导入时会做三件事：

1. 生成符合目标版本格式的会话文件（保留消息顺序、工具调用、时间戳、工作区路径）；
2. 更新对方的索引（`session_index.jsonl`、`sessions.json`、`projects.json` 等）；
3. 在安全的前提下登记数据库（`threads` 表 / Copilot 的 `session-store.db`），
   SQLite 用"读现有行做模板 + 动态列"的方式写入，兼容不同版本的 schema。

工作区路径会按规则重写：`--workspace` 指定新项目目录，或 `--map "C:\old=D:\new"` 做前缀映射，
也可以 `--into D:\projects` 自动落到同名目录下。**只映射元数据，不改写消息里的历史路径**——
这是有意的：改了会让对话内容失真。

---

## 安全

- **纯本地**：没有云端组件、没有遥测、不发起任何外部请求。
- **Web UI 只监听 127.0.0.1**，每次启动生成随机 token，API 必须带 token，防止同机其它网页偷读。
- **加密**：`.ferrypack --encrypt` 使用 scrypt 派生密钥 + AES-256-GCM 整体认证，
  密码错误与文件被篡改都会直接失败，而不是解出一份被改过的历史。
- **脱敏**：默认把 `sk-*`、`ghp_*`、`AKIA*`、JWT、Bearer、私钥、`password=` 等替换为 `[REDACTED:*]`。
  用 `--no-redact` 关闭。
- **备份与回滚**：写入前备份被修改的索引/数据库，`ferry rollback <id>` 一键恢复。
- **模拟模式**：`--dry-run` 只计算会写哪些文件，绝不落盘。

---

## CLI 参考

```
ferry scan                         扫描本机 Agent 与会话
ferry targets                      支持矩阵（导出 / 原生导入 / 续聊）
ferry export --all -o x.ferrypack  导出全部
ferry export --agent codex --since 7d --encrypt
ferry export --agent chatgpt-export --to handoff -o ./handoff
ferry import x.ferrypack --to codex [--workspace DIR] [--map OLD=NEW] [--dry-run]
ferry list x.ferrypack             归档清单
ferry show x.ferrypack [关键字]    渲染会话（Markdown）
ferry unpack x.ferrypack ./out     摊开成普通文件
ferry backups / rollback <id>      备份与回滚
ferry doctor                       环境自检（Node / SQLite / 适配器 / 加密往返）
ferry ui --port 7099               本地 Web 界面

全局：--home <目录>  读取另一份用户目录（例如挂载的旧硬盘）配合 --platform win32|darwin|linux
      --json / --yes / --quiet / --no-redact / --ferry-home <目录>
```

常用组合：

```bash
# 旧硬盘挂载到 F:\，直接在新机器上离线迁移
ferry scan  --home F:\Users\alice --platform win32
ferry export --home F:\Users\alice --agent claude-code -o old.ferrypack

# 只恢复一个项目最近 7 天的会话
ferry export --agent claude-code --since 7d -o recent.ferrypack
ferry import recent.ferrypack --to claude-code --workspace D:\work\proj
```

---

## Web 界面

`ferry ui` 启动后：

- **总览**：本机装了哪些 Agent、多少会话、最近活动；点卡片直接进入导出。
- **导出**：勾选 Agent、时间范围、脱敏与加密开关，生成并下载 `.ferrypack`。
- **导入**：拖入文件 → 浏览会话 → 预览 Markdown → 选目标 Agent 与项目目录 → 预演/导入。
- **归档**：查看自动备份并回滚。
- **设置**：运行环境与能力矩阵。

界面与 CLI 共用同一套核心逻辑，不存在"只有界面能用"的功能。

---

## 局限（先说清楚）

- 附件/图片目前只对 Claude Code 做了内联保存；其它 Agent 的图片多为引用，迁移后会丢失。
- 分支对话只保留当前主分支（ChatGPT 导出里的 `current_node` 路径）。
- 工具调用的结果长度取决于源数据，被源端截断的内容无法补全。
- Cursor 的导入是**实验性**的：不同版本 schema 会变，导入前请退出 Cursor，失败可用备份回滚。
- DeepSeek Harness 的写回会丢两样东西：系统提示词（目标端应该用自己的）与思考过程（重放需要原始推理签名，伪造比丢掉更危险）。图片降级为文字占位。
- DeepSeek Harness 的侧栏成员资格记在 `~/.dsh/storages/workspace.json` 里，**导入前必须先退出 Harness**；否则运行中的应用会用内存状态覆盖这次索引更新。导入失败可用 `ferry rollback` 还原。
- 云端产品无法写入账号，只能交接包或登录同账号。
- 导入不会修改消息正文中的历史路径（避免内容失真），只改会话的工作区元数据。

---

## 开发

```bash
npm test          # 160 个测试：tar/zip/crypto/归档/脱敏/路径映射/幂等/适配器往返
node bin/ferry.js doctor
npm run package   # 生成 dist/ferry-<version>.tar.gz（可直接拷到别的机器）
```

目录：

```
bin/ferry.js           入口
src/cli.js             命令行
src/server.js          本地 Web 服务
src/ui/                前端（原生 JS，无构建）
src/core/              ucm / archive / tar / zip / crypto / registry / migrate / backup
src/adapters/          每个 Agent 一个文件
src/core/adapter.js    适配器协议
docs/                  格式规范、适配器开发、云端迁移指南
test/                  测试与 fixture
```

新增一个 Agent 支持通常只需要一个 `src/adapters/xxx.js`（实现 `scan` / `read` / 可选 `import`），
再在 `src/adapters/index.js` 注册。详见 [docs/adapters.md](docs/adapters.md)；
云端产品请见 [docs/web-chats.md](docs/web-chats.md)；格式规范见 [docs/format.md](docs/format.md)。

---

## License

MIT
