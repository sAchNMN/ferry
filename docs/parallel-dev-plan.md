# Ferry 多分支并行开发方案

适用项目：`ferry-agent-port`（AI Agent 会话迁移工具）
文档状态：v1 · 2026-10-19
适用范围：多人 / 多 AI 同时开发，最终通过 git 合并

> **范围已收敛（2026-10-19）**：平台侧只做 WorkBuddy / DeepSeek Harness / ChatGPT 三家，
> 其余平台适配器冻结，不再分配 lane。装配点改造、契约冻结、迁移引擎、归档格式等
> 与平台数量无关的部分照旧执行。权威定义见 [scope.md](scope.md)。

---

## 0. 结论先行

三条判断，决定了后面所有安排：

**判断一：先做"装配点改造"，再谈并行。**
当前代码把所有分支的汇合点写死在了 6 个文件里（适配器清单、别名表、CLI 的 switch、HTTP 的 switch、前端单文件、package.json 的 test 脚本）。
只要这 6 处还是手写数组/switch，任何两路 AI 同时开发都必然在这里冲突。
**并行开发的第一笔投入不是写功能，是把这个汇合点变成"加文件即生效"。**

**判断二：按"存储形态"分支，不按"厂商"分支。**
仓库里已经有证据：`cline-family.js`、`gemini-family.js`、`vscode-chat.js` 各自合并了多个厂商。
按厂商切分会把同一套 SQLite 读法、同一套 JSONL 读法复制 N 份，测试也跟着 N 份。
**一个 lane 负责一种存储形态，内部按厂商分子文件。**

**判断三：国内网页版 Agent 做不到"原生续聊"，这是产品硬约束，不是排期问题。**
Claude Code / Codex / Cursor / Copilot 有本地会话库，写进去就能 `--resume`。
通义、文心、DeepSeek 的网页/APP 端**没有可写入的本地会话库**，只能导出成交接包（handoff），
或者导入到对应的 CLI / API 形态。这条必须在分支职责里写清楚，否则负责这些平台的 lane 会一直在做无效功。

---

## 1. 现状基线（分支划分的事实依据）

| 项 | 现状 | 对并行的影响 |
|---|---|---|
| Git | **尚未初始化**（`git log` 返回 128） | 第一件事是 `git init` + 基线提交 |
| 运行时依赖 | 零依赖，仅需 Node ≥ 22.5 | 无 lockfile 冲突；但 `package.json` 仍是单点 |
| 适配器 | 10 个 store + 4 个 importer，集中注册在 `src/adapters/index.js`（33 行手写数组） | **所有适配器分支的必冲突点** |
| 别名表 | `src/core/registry.js` 内 `ALIASES` 对象 | 第二个必冲突点 |
| CLI | `src/cli.js` 854 行，单一 `switch`，14 个 case | 第三个必冲突点 |
| HTTP | `src/server.js` 334 行，单一 `switch`，13 条 `'METHOD /api/x'` | 第四个必冲突点 |
| 前端 | `src/ui/app.js` 689 行单文件 | 第五个必冲突点 |
| 测试 | `test/core.test.js` + `test/adapters.test.js`，`package.json` 里**硬编码了这两个文件名** | 加测试就要改 package.json → 第六个必冲突点 |
| 测试夹具 | `test/helpers.js` 提供 `seedCodex/seedClaude/seedCline/...`，用 `makeEnv()` 伪装整台机器 | 很好的基础，但按厂商硬编码，需要泛化成 fixture 目录 |
| 契约文档 | `docs/format.md` 已定义 ferrypack/1 + ferry.conversation/1 | 已有冻结基础，可直接升级为"只读契约" |

> 结论：6 个必冲突点，其中 4 个可以在 1 个串行 lane 里一次性消灭。这是本方案的核心杠杆。

---

## 2. 划分依据

| 原则 | 含义 | 落到本项目 |
|---|---|---|
| **单写者** | 任一文件在任一时刻只有一个 lane 有写权限 | 用 `docs/contract/ownership.md` 明文登记，超出范围即打回 |
| **装配点收敛** | 新功能通过"新增文件"接入，而非"修改清单" | 适配器 / 命令 / 路由 / 测试全部改成自动发现 |
| **依赖单向** | 只能 `adapters → core`，禁止 `core → adapters` | 违反即架构退化，评审直接拒绝 |
| **独立可验** | 单个 lane 能在不依赖其他 lane 的情况下跑通自己的验收命令 | 每个 lane 自带 fixture + 一条 `npm run verify:<lane>` |
| **变更频率对齐** | 高频改动的文件不跨 lane 共享 | `docs/format.md`、`src/core/ucm.js` 全项目只读 |
| **契约先冻结** | 接口先定，实现后填 | B0 产出 `docs/contract/adapter-interface.md`，冻结后所有 lane 只按它写 |

---

## 3. 波次划分与依赖

```
                  ┌──────────────────────────────────────────┐
  波次 0（串行）  │ B0 chore/contract-freeze                 │
  阻塞全部        │ 消灭 6 个必冲突点 + 冻结适配器契约        │
                  └───────────────┬──────────────────────────┘
                                  │ 契约冻结
        ┌─────────────┬───────────┼───────────┬─────────────┐
  波次 1│ A adapter/fs-jsonl  B adapter/sqlite  D adapter/web-export
  （并行）│ E engine/migrate    J qa/contract      （5 路）
        └─────────────┴───────────┼───────────┴─────────────┘
                                  │ core 接口稳定
        ┌─────────────┬───────────┼───────────┬─────────────┐
  波次 2│ C adapter/vscode-fam  F engine/archive  G surface/cli
  （并行）│ H surface/api        I surface/ui      （5 路）
        └─────────────┴───────────┴───────────┴─────────────┘
                                  │
                        集成分支 integration/wave-N
                                  │ 全量测试绿
                                  ▼
                                main（保护）
```

**波次不是按"难易"排的，是按"谁消费谁"排的。** 表面层（CLI / API / UI）是 core 的消费者，
提前开工只会返工；唯一例外是 UI 可以提前用 mock 契约起手（见 §6.4）。

---

## 4. 波次 0：契约冻结（唯一允许串行的分支）

### `B0 chore/contract-freeze`

**为什么必须串行**：它改的正是所有人要碰的 6 个文件。并行做等于主动制造冲突。

**职责边界**：只做"把汇合点变成装配点"，**不改任何业务逻辑，不新增任何适配器**。

**交付物**：

| # | 改造 | 现状 | 目标 |
|---|---|---|---|
| 1 | 适配器自动发现 | `src/adapters/index.js` 33 行手写 import + 数组 | 新增 `src/adapters/_loader.js`，扫目录加载 `*.js`（跳过 `_` 前缀与 `index.js`）；`index.js` 只剩 10 行聚合。**新增适配器 = 新增一个文件** |
| 2 | 别名随适配器走 | `registry.js` 里 24 条 `ALIASES` 硬编码 | 每个适配器自带 `aliases: ['claude','claude-code']`，`registry` 启动时聚合；`ALIASES` 常量删除 |
| 3 | CLI 命令模块化 | `cli.js` 854 行、单 switch、14 个 case | 拆到 `src/commands/*.js`，每个导出 `{ name, aliases, args, run }`；`cli.js` 退化为 ~80 行的解析 + 派发 |
| 4 | HTTP 路由模块化 | `server.js` 单 switch、13 条字符串匹配 | 拆到 `src/api/*.js`，每个导出 `routes = [{ method, path, handler }]`；`server.js` 只做表匹配 |
| 5 | 测试发现化 | `package.json` 硬编码 2 个测试文件 | 改为 `node --test --test-isolation=none test/`，任何新增 `*.test.js` 自动纳入 |
| 6 | 夹具协议 | `helpers.js` 按厂商硬编码 `seedXxx()` | 统一 `test/fixtures/<adapter-id>/` 目录 + 通用 `seedFromFixture(adapter, env)`；各 lane 只往自己目录丢夹具 |

**同时产出（契约文档，冻结后全项目只读）**：

- `docs/contract/adapter-interface.md` — `defineStore` / `defineImporter` 的字段、`scan/read/import` 签名、`ctx.blobs` 语义、失败必须是 `FerryError`
- `docs/contract/ownership.md` — 文件 → lane 归属表（§5 的表格落盘）
- `docs/contract/acceptance.md` — 每个 lane 的验收命令
- `AGENTS.md`（或 `LANE.md` 模板）— 供每个 AI 会话开头读取的"范围围栏"

**验收（Exit Criteria，全绿才解锁波次 1）**：

1. `npm test` 现有 3 个测试文件全绿；
2. **元测试**：临时丢一个假适配器文件进 `src/adapters/`，不做任何其他改动，`scan` 能发现它 —— 证明装配点真的解耦了；
3. 元测试二：丢一个 `test/dummy.test.js`，`npm test` 自动执行 —— 证明测试发现生效；
4. `git status` 干净，`main` 上有基线 tag（`v0.1.0-baseline`）。

> 这一段的投入大概占整体工作量的 8%～12%，但能把后续合并成本降一个数量级。不做这步的并行开发，最后会花更多时间在解冲突上。

---

## 5. 分支清单

### 5.1 波次 1（5 路并行）

#### `A feat/adapter-fs-jsonl` — 文件型 JSONL 存储

| 项 | 内容 |
|---|---|
| 职责 | 以"每会话一个文件 / 一行一条消息"形式落盘的 Agent：Claude Code、Codex、Gemini CLI、Qwen Code、iFlow、OpenCode、Aider |
| 文件所有权 | `src/adapters/claude-code.js`、`codex.js`、`gemini-family.js`、`misc-stores.js`、`test/fixtures/{claude-code,codex,gemini-cli,qwen-code,iflow,opencode,aider}/`、`test/fs-jsonl.test.js` |
| 交付物 | ① 各 Agent **存储版本漂移**的兼容层（Codex 的 `state_N.sqlite` 版本号、Claude Code 的 `projects/<slug>` 编码规则变化）；② 导入时的 sessionId 重写 + `--resume` 可用性验证；③ 工具调用/思考块/子 Agent 分支（`meta.sidechain`）无损往返；④ 每个 Agent 至少 2 套夹具（新版本 / 旧版本） |
| 禁止 | 碰 `src/core/*`、`src/adapters/index.js`（已自动发现）、`docs/format.md` |
| 依赖 | B0 |
| 被依赖 | E（引擎用它的 `read` 做回归）、J（契约测试） |

#### `B feat/adapter-sqlite` — SQLite 存储

| 项 | 内容 |
|---|---|
| 职责 | 会话存在 SQLite 里的 Agent：Cursor（`state.vscdb`）、GitHub Copilot Chat（`session-store.db`）、Continue |
| 文件所有权 | `src/adapters/cursor.js`、`vscode-copilot.js`、`continue.js`、**`src/core/sqlite.js`**（SQLite 读写的唯一 owner）、`test/sqlite.test.js` + 对应 fixtures |
| 交付物 | ① 只读打开 + WAL 安全读取（目标应用正在运行时不能损坏库）；② 导入时对 `state.vscdb` 的**事务写入 + 备份**，失败必须回滚到原字节；③ schema 版本探测与降级；④ Cursor 的 Composer 历史从"实验性"升级到"有夹具覆盖" |
| 禁止 | 碰 `src/core/migrate.js`（回滚编排属 E）；碰其他 adapter |
| 依赖 | B0 |
| 特别风险 | 三个 Agent 共用一个 `sqlite.js`，**该文件锁给 B 独占**，其他 lane 需要改就提 issue 由 B 代改 |

#### `D feat/adapter-web-export` — 网页 / 客户端导出包

| 项 | 内容 |
|---|---|
| 职责 | 没有本地会话库、只能靠导出文件的平台：ChatGPT 官方 zip、Claude 官方 json、**通义 / 文心一言 / DeepSeek / 豆包 / Kimi 的导出格式**、通用 JSON、Markdown |
| 文件所有权 | `src/adapters/web-exports.js` → 拆成 `src/adapters/exports/{chatgpt,claude,tongyi,wenxin,deepseek,generic,markdown}.js`、`test/web-export.test.js` + fixtures |
| 交付物 | ① 国内平台导出格式适配（分享链接 HTML 抓取解析、APP 导出的 JSON/CSV）；② 分支对话树（ChatGPT 的 `mapping`）展开为线性或保留为 `meta.sidechain`；③ **明确标注 `capabilities.import = false`，只走 handoff 包**，并在 `resumeHint` 里给出可执行的续聊建议；④ 脱敏覆盖国内厂商的 Key 形态（DashScope / 百度 AK-SK / DeepSeek `sk-`） |
| 禁止 | 承诺"原生续聊"——做不到就如实标 false |
| 依赖 | B0 |
| 产品口径 | 这是唯一一条"迁移后不能直接续聊"的线，README 的能力矩阵必须如实反映 |

#### `E feat/engine-migrate` — 迁移引擎

| 项 | 内容 |
|---|---|
| 职责 | 迁移语义本身：路径映射、workspace 解析、去重、增量、事务与回滚 |
| 文件所有权 | `src/core/migrate.js`、`src/core/backup.js`、`src/core/registry.js`（B0 之后仅剩扫描编排）、`test/migrate.test.js` |
| 交付物 | ① **跨平台路径映射**：`C:\work\proj` ↔ `/Users/x/proj` ↔ `/home/x/proj`，盘符大小写、UNC、WSL `/mnt/c/` 双向；② workspace 解析策略补全（`map` / `workspace` / `into` / `same-machine` 之外补 `git-remote` 匹配）；③ **去重与增量合并**：同会话二次导入不产生副本，长会话追加而非覆盖；④ 导入事务：一批会话失败要能整体回滚（现有 `createdPaths` 补写 manifest 的做法要抽象成事务对象）；⑤ 干跑（dry-run）与真实写入的报告结构完全一致 |
| 禁止 | 碰任何 adapter、碰 `ucm.js`（契约） |
| 依赖 | B0；弱依赖 A/B（需要它们的 `read` 做回归，可用夹具替代） |
| 被依赖 | G / H / I（表面层全部消费它的返回结构） |

#### `J qa/contract` — 契约测试与夹具治理

| 项 | 内容 |
|---|---|
| 职责 | 当裁判，不当运动员。定义"什么叫通过" |
| 文件所有权 | `test/contract/*.test.js`、`test/fixtures/_schema/`、`test/helpers.js`、`scripts/verify.mjs` |
| 交付物 | ① **适配器契约测试**：任何 store 必须满足 N 条不变量（`scan` 返回的每个 ref 都能被 `read`；`read` 结果必须通过 `validateConversation`；`import` 后能被重新 `scan` 到；`dryRun` 不落盘）——新适配器只要注册就自动进测试；② **跨版本兼容测试**：ferrypack/1 与未来 v2 的双向读取；③ **端到端矩阵**：源 Agent × 目标 Agent，优先覆盖"能原生导入"的组合，其余走 handoff；④ `npm run verify:<lane>` 脚本 |
| 禁止 | 修改被测试的实现来让测试通过（发现 bug 提 issue，不自己改别人的文件） |
| 依赖 | B0 |
| 价值 | 这条 lane 如果缺席，其他 lane 的产出无法证明"真的能迁移"，合并时全靠人肉点验 |

### 5.2 波次 2（5 路并行）

#### `C feat/adapter-vscode-family` — 编辑器系 JSON 文件树

| 项 | 内容 |
|---|---|
| 职责 | 以 globalStorage 下 JSON 文件树存储会话的编辑器：Cline / Roo / Kilo、Trae、VS Code 内置 Chat、Windsurf / Kiro |
| 文件所有权 | `src/adapters/cline-family.js`、`vscode-chat.js`、`test/vscode-family.test.js` + fixtures |
| 交付物 | ① 同一族内多厂商的目录差异矩阵（`saoudrizwan.claude-dev` / `kilocode.kilo-code` / `rooveterinaryinc.roo-cline`）；② 导入时同步 `tasks/` 与索引文件；③ 版本升级导致的字段漂移兼容 |
| 依赖 | B0 + B（若需要读 SQLite 索引，走 B 的 `sqlite.js`，不得自行 import better-sqlite3） |

#### `F feat/engine-archive` — 归档容器与加密

| 项 | 内容 |
|---|---|
| 职责 | `.ferrypack` 容器：tar/gzip、AES-256-GCM、blob 去重、校验、增量 |
| 文件所有权 | `src/core/archive.js`、`tar.js`、`zip.js`、`crypto.js`、`test/archive.test.js` |
| 交付物 | ① 流式加解密（大归档不爆内存）；② **增量包**（`ferrypack/2` 提案：只含新增会话 + 父包 id）；③ 分卷（>2GB 的归档）；④ 损坏检测与 `--no-verify` 降级路径的可观测性；⑤ schema 升级提案（**只提 RFC，不直接改 `docs/format.md`**） |
| 依赖 | B0 |
| 红线 | 格式变更必须走 RFC + 向后兼容；`ferrypack/1` 的读取能力永久保留 |

#### `G feat/surface-cli` — 命令行

| 项 | 内容 |
|---|---|
| 职责 | 命令、参数、输出、交互向导 |
| 文件所有权 | `src/commands/*.js`（B0 建好的目录） |
| 交付物 | ① 交互式向导（无参数运行时的引导式流程）；② 统一的进度/错误/提示输出层（颜色、TTY 检测、`--json` 机器可读）；③ 新增 `verify` / `diff`（对比两台机器的会话差异）/ `plan`（导入前预演）命令；④ 退出码规范（0 成功 / 1 业务失败 / 2 用法错误） |
| 依赖 | B0 + E（消费 `importConversations` 返回结构） |
| 禁止 | 在命令里写业务逻辑；命令只做参数校验 + 调 core |

#### `H feat/surface-api` — 本地 HTTP API

| 项 | 内容 |
|---|---|
| 职责 | `127.0.0.1` 上的本地服务：扫描、预览、导入、下载、回滚 |
| 文件所有权 | `src/api/*.js`（B0 建好的目录） |
| 交付物 | ① 统一响应包络 `{ ok, data, error }`；② 长任务进度用 SSE（现有前端只能轮询）；③ 上传大小限制与临时文件清理；④ CSRF/本地端口劫持防护（只绑 127.0.0.1 + Origin 校验 + 一次性 token） |
| 依赖 | B0 + E |
| 契约 | 接口定义**先出 `docs/contract/api.md`**，UI lane 按它对 mock 开发 |

#### `I feat/surface-ui` — 图形界面

| 项 | 内容 |
|---|---|
| 职责 | 浏览器界面：扫描结果、会话预览、导入向导、备份回滚 |
| 文件所有权 | `src/ui/*` |
| 交付物 | ① 把 689 行单文件拆成 `index.html` + `views/*.js` + `components/*.js`（**否则 UI lane 内部也无法并行**）；② 迁移前"将写入哪些文件"的可视化预览（这是本产品最需要的信任建设）；③ 会话内容渲染（Markdown、代码块、工具调用折叠）；④ 大列表虚拟滚动（几千会话不卡） |
| 依赖 | B0；**可提前起手**：用 `docs/contract/api.md` + mock 数据开发，不等 H 完成 |
| 禁止 | 直接拼 `fetch` 字符串，统一走一个 `api.js` 客户端，H 改接口时只改一处 |

### 5.3 依赖关系汇总

| Lane | 硬依赖 | 软依赖 | 冲突面（需重点盯） |
|---|---|---|---|
| B0 | — | — | 全部（串行，无冲突） |
| A | B0 | — | `adapters/` 目录（与 B/C/D 不同文件，安全） |
| B | B0 | — | `core/sqlite.js`（独占） |
| C | B0, B | — | `adapters/` 目录 |
| D | B0 | — | `adapters/exports/`（独占子目录） |
| E | B0 | A, B | `core/`（与 F 分文件，安全） |
| F | B0 | — | `core/` 容器四件套 |
| G | B0, E | J | `commands/` |
| H | B0, E | J | `api/` |
| I | B0 | H（mock 解耦） | `ui/` |
| J | B0 | 全部 | `test/` 根目录、`helpers.js`（独占） |

**没有横向依赖的 lane 之间，冲突面全部落在"目录"粒度而非"文件"粒度。** 这是能并行的根本原因。

---

## 6. 合并策略

### 6.1 分支模型

```
main                 保护分支，只接受集成分支的 fast-forward
 └─ integration/wave1  波次 1 五条 lane 的汇合点，全量测试在此变绿
 └─ integration/wave2  波次 2 同上
 └─ feat/*             每 lane 一条，生命周期 = 一个波次
```

- **`main` 保持线性**：每个 lane 合入时 squash 成一个 commit，commit message 用 `feat(adapter): ...` 这类 Conventional Commits（类型前缀英文，描述中文）。
- **integration 分支用 merge 而非 squash**：保留每个 lane 的边界，出问题能精准 revert 单条 lane。
- **`main` 禁止 force-push**；lane 分支允许 `git push --force-with-lease`（rebase 后需要用）。

### 6.2 合并顺序

按"被依赖者先合"排序，同层按冲突热度升序：

```
B0 → J（契约测试先落地，成为后续门禁）
   → A / B / D（三条适配器线，互不相干，顺序随意）
   → E（引擎，依赖 A/B 的读能力已稳定）
   → C（依赖 B 的 sqlite）
   → F（容器，独立）
   → G / H（表面层，依赖 E）
   → I（UI，依赖 H 的接口，最后合）
```

**每天固定两个合并窗口**（例如上午、晚上各一次）。不要攒到波次末尾一次性合 —— 分支存活越久，rebase 成本指数上升。

### 6.3 三条硬规则

1. **谁后合谁解冲突**。后合的分支负责 rebase 到最新 `integration` 并自行解决冲突，不允许把冲突推给先合的人。
2. **契约冲突由 B0 的 owner 裁决**。涉及 `docs/contract/*`、`ucm.js`、`format.md` 的冲突，不走"谁后合谁解"，走裁决 + RFC。
3. **每个 lane 合入前必须 rebase 到 `integration` 最新提交并本地跑通 `npm test`**。CI/人工门禁只做验证，不做修复。

### 6.4 解耦技巧：mock 优先

UI 和 CLI 是消费者，最容易被 core 拖住。做法：

- H lane 先产出 `docs/contract/api.md`（哪怕实现是空的）；
- I lane 用 `src/ui/mock/*.json` 按契约开发，`?mock=1` 开关切换；
- E lane 的返回结构一旦变化，先改 `api.md`，再改实现，最后通知 I。

这样 UI 可以和 E 同时开工，最后只需要对齐一次字段名。

---

## 7. 冲突规避

### 7.1 六类冲突的针对性处理

| 冲突类型 | 典型场景 | 处理 |
|---|---|---|
| **注册表冲突** | 两个 lane 都往 `adapters/index.js` 加一行 | B0 改成自动发现，从源头消灭 |
| **switch 冲突** | 两个 lane 都往 `cli.js` 加一个 case | B0 拆成命令模块 |
| **测试清单冲突** | 两个 lane 都改 `package.json` 的 test 脚本 | B0 改成目录发现 |
| **格式化噪声** | 不同 AI 用不同缩进/引号/行尾 | 统一 `.editorconfig` + `.gitattributes`：`* text=auto eol=lf`，`*.cmd text eol=crlf`（Windows 环境必须有这条，否则 CRLF/LF 差异会污染整个 diff） |
| **文档冲突** | 多个 lane 同时更新 README 的能力矩阵 | README 由 J lane 统一维护，其他 lane 只提"待更新条目"到 `docs/changelog.d/<lane>.md`（changefile 模式，避免同文件竞争） |
| **依赖冲突** | 某个 lane 想引入 `better-sqlite3` | **全项目维持零运行时依赖**；确需依赖的走 B0 统一引入并说明理由，禁止各 lane 自行 `npm i` |

### 7.2 物理隔离：git worktree

多 AI 并发开发最容易被忽略的一点：**它们不能共享同一个工作目录**。
一个 AI `git checkout` 到自己的分支，另一个 AI 的文件瞬间变了 —— 这不是 git 冲突，是直接踩烂对方的工作区。

```bash
# 每条 lane 一个独立目录，互不干扰
git worktree add ../ferry-A feat/adapter-fs-jsonl
git worktree add ../ferry-B feat/adapter-sqlite
git worktree add ../ferry-E feat/engine-migrate
```

每个 AI 会话的启动上下文里明确写死自己的工作目录，禁止跨目录操作。

### 7.3 范围围栏：给每个 AI 的提示词模板

```markdown
# LANE: feat/adapter-sqlite
工作目录：C:\ferry-B
允许修改：src/adapters/cursor.js, src/adapters/vscode-copilot.js,
          src/adapters/continue.js, src/core/sqlite.js,
          test/sqlite.test.js, test/fixtures/{cursor,vscode-copilot,continue}/
只读：docs/contract/*, docs/format.md, src/core/ucm.js
禁止：其他 adapter、cli.js、server.js、ui/、package.json
验收：npm run verify:sqlite
提交前：git rebase integration/wave1 && npm test
```

**这张表比任何"请小心不要冲突"的口头约定都有效。** AI 会严格守围栏，前提是围栏写清楚了。

### 7.4 契约变更流程（RFC）

任何需要动冻结契约的变更：

1. 在 `docs/rfc/NNNN-<topic>.md` 写提案（动机 / 影响面 / 兼容性）；
2. 标注影响的 lane；
3. B0 owner + 受影响 lane 的 owner 同意后才实施；
4. 实施者必须是 B0 owner 或契约文件当前的 owner —— **不允许"顺手改一下"**。

---

## 8. 整体提速思路

### 8.1 瓶颈在哪

这类项目的并行开发，**瓶颈从来不是"写代码的速度"，而是"验证 + 合并"的串行成本**。
10 个 AI 同时写代码，如果每个产出都需要人肉点验、每条分支都手动解冲突，总耗时不会比单线快。

所以提速的三个着力点，按收益排序：

| 着力点 | 做法 | 收益 |
|---|---|---|
| **消灭汇合点** | B0 的 6 项改造 | 合并从"手工解冲突"变成 `git merge` 直接过。**最大单项收益** |
| **验证前置** | J lane 先写契约测试，新适配器一注册就自动被检验 | 问题在 lane 内暴露，不流到合并阶段 |
| **契约解耦** | API 契约先出，UI/CLI 用 mock 并行 | 消除关键路径上的等待 |

### 8.2 并发度上限

**建议 4～6 路并发，不超过 8 路。**

理由：
- 每条 lane 合入时需要一次完整的 rebase + 全量测试 + 人工评审；
- 并发 10 路时，评审带宽成为唯一瓶颈，后合的分支 rebase 冲突率显著上升；
- 真到 10 个模块，正确的做法是**分两波，每波 5 路**（本方案即是），而不是一次开 10 路。

如果手上只有 3 个 AI，合并 lane：

```
A+C → adapter-files（文件型全部）
B   → adapter-sqlite（不合并，SQLite 风险最高）
D   → adapter-export
E+F → engine（迁移 + 归档）
G+H → surface-cli-api
I   → surface-ui（可最后做）
J   → qa
```

### 8.3 相对收益预期

按本方案执行，相比严格串行：

- **开发阶段**：约 2.5～3 倍（受并发上限与评审带宽约束，不是线性 10 倍）；
- **合并阶段**：冲突处理量下降一个数量级（B0 改造的直接结果）；
- **返工**：显著减少（契约冻结 + 契约测试把返工从"合并后发现"提前到"提交前发现"）。

---

## 9. 风险与红线

| 风险 | 表现 | 应对 |
|---|---|---|
| **真机数据不可逆损坏** | 导入写坏 `state.vscdb`，用户 Cursor 打不开 | 任何写入前强制备份（`backup.js` 已有基础）；SQLite 写入必须事务化；dry-run 报告与真实写入结构一致 |
| **假阳性"迁移成功"** | 文件写进去了，但应用里看不到（索引没同步） | 验收标准必须是"目标应用能列出该会话"，不是"文件存在"；J lane 的端到端矩阵负责守这条 |
| **国内平台承诺过度** | README 写"支持通义/文心导入"，实际只能导出 | 能力矩阵如实标注 `import: false`，交付物里必须包含"这条线只能 handoff"的明确说明 |
| **格式通胀** | 各 lane 各自往 UCM 里塞字段 | UCM 只读；新增字段必须走 RFC 且可选 |
| **依赖渗入** | 某个 lane 引入第三方包，破坏零依赖 | 禁止自行 `npm i`；B0 统一决策 |
| **AI 跨目录操作** | 一个 AI 改了别人的文件 | worktree 隔离 + LANE.md 围栏 |

**红线（任何情况不破）**：

1. 不修改用户的原始会话数据来"适配"格式 —— 只读源，只写目标。
2. 不在没有备份的情况下写入任何 Agent 的原生存储。
3. 不声称支持一个实际没验证过的 Agent（能力矩阵必须可复现）。

---

## 10. 落地清单

**第 1 步（今天）**

```bash
cd ~/Desktop/Thdr
git init
git add -A && git commit -m "chore: 初始化 Ferry 项目基线"
git tag v0.1.0-baseline
```

**第 2 步**：开 `B0 chore/contract-freeze`，按 §4 的 6 项改造 + 4 份契约文档推进，验收全绿后打 tag `v0.2.0-contract`。

**第 3 步**：按 §7.2 建 5 个 worktree，把 §7.3 的 LANE.md 模板逐 lane 填好，启动波次 1。

**第 4 步**：每日两个合并窗口，波次 1 全绿合入 `main` 后，再开波次 2。

---

## 附：为什么不用别的切法

| 备选方案 | 否决理由 |
|---|---|
| 按厂商切 10+ 个 adapter 分支 | 同一存储形态的解析逻辑重复 3～4 份；测试无法共享；`adapters/` 目录下文件名冲突概率上升；实际并行度受"每个 AI 学一遍同一套 SQLite 读法"拖累 |
| 按前后端切（core / UI 两分支） | 粒度过粗，UI 一个人扛 689 行单文件仍是串行；core 内部（适配器 vs 引擎 vs 容器）完全可再并行 |
| 按"功能"切（导出 / 导入 / 加密 / UI） | 与代码结构不吻合：导出和导入共享 `migrate.js` 与全部适配器，两个 lane 会在同一批文件上打架 |
| 只开一条 main 分支、靠 AI 顺序提交 | 无法并行，且没有隔离点，一旦某次提交引入回归，定位成本高 |
