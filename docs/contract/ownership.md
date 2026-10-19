# 文件所有权表

规则：**任一文件在任一时刻只有一个分支有写权限。** 超出范围的改动直接打回，不做例外。

分三档：`独占`（只有 owner 能改）、`只读`（全项目冻结，改则走 RFC）、`自由`（新建文件，按命名空间隔离）。

---

## 只读（全项目冻结）

| 路径 | 说明 | 变更方式 |
|---|---|---|
| `docs/format.md` | ferrypack/1 与 UCM/1 格式规范 | RFC + 契约负责人实施 |
| `docs/contract/adapter-interface.md` | 适配器契约 | RFC + 契约负责人实施 |
| `docs/contract/ownership.md` | 本文件 | 契约负责人 |
| `src/core/ucm-model.js` | 结构定义 / 构造 / 校验 / 统计 | RFC；UCM 契约本体 |
| `src/core/aliases.js` | 全局别名命名空间 | 集成负责人统一提交 |
| `package.json` 的 `dependencies` | 本项目维持零运行时依赖 | 集成负责人决策 |

## 独占（owner 列）

| 路径 | owner lane | 备注 |
|---|---|---|
| `src/adapters/_loader.js` | `feat/contracts-v1` | 发现机制；改它影响所有平台 |
| `src/adapters/index.js` | `feat/contracts-v1` | 聚合出口，已退化为 10 行 |
| `src/core/adapter.js` | `feat/contracts-v1` | `defineStore` / `defineImporter` |
| `src/core/registry.js` | `feat/contracts-v1` | 扫描编排与别名解析 |
| `src/core/ucm.js` | `feat/contracts-v1` | 仅 re-export，不含逻辑；分层契约测试会拦 |
| `src/core/ucm-render.js` | `feat/package-conversion` | `renderMarkdown` / `renderHandoff` / `localStamp` |
| `src/core/ucm-redact.js` | `feat/package-conversion` | `redactText` / `redactConversation` |
| `src/core/ucm-text.js` | `feat/package-conversion` | 会话 → 纯文本，渲染与指纹的共同底座 |
| `src/core/ucm-identity.js` | `feat/migration-engine` | 指纹与内容哈希，直接决定去重正确性 |
| `src/core/migrate.js` | `feat/migration-engine` | 迁移编排、路径映射、去重 |
| `src/core/backup.js` | `feat/migration-engine` | 备份与回滚 |
| `src/core/sqlite.js` | `feat/migration-engine` | SQLite 读写唯一入口，其他分支禁自引驱动 |
| `src/core/archive.js` `tar.js` `zip.js` `crypto.js` | `feat/package-conversion` | 容器与加密 |
| `src/cli.js` | `feat/migration-engine` | B0 之后只保留解析与派发 |
| `src/server.js` | `feat/gui` | 路由表匹配 |
| `src/ui/**` | `feat/gui` | 前端全部 |
| `test/helpers.js` | `test/compat-e2e` | 公共夹具工具，单一负责人 |
| `test/contract/**` | `test/compat-e2e` | 契约测试，平台分支只读 |
| `scripts/package.mjs` | `chore/integration-release` | 打包脚本 |

## 按平台独占

> **范围冻结（2026-10-19）**：只在维护范围内的适配器是 `workbuddy.js`、`deepseek-harness.js`、
> `exports/chatgpt.js`。下表其余平台文件进入冻结态：只接 bug 修复，不接新功能。
> 见 [../scope.md](../scope.md)。

| 路径 | owner lane |
|---|---|
| `src/adapters/claude-code.js` + `test/adapters/claude-code/**` | `feat/adapter-claude-code` |
| `src/adapters/cursor.js` | `feat/adapter-cursor` |
| `src/adapters/vscode-copilot.js` | `feat/adapter-copilot` |
| `src/adapters/web-exports.js` 拆出的 `exports/chatgpt.js` `exports/claude.js` | `feat/adapter-chatgpt` / `feat/adapter-claude-web` |
| 通义 / 文心 / DeepSeek 新文件 | 各自平台分支 |

## 命名空间约定（避免新增文件时撞名）

| 类型 | 位置 | 命名 |
|---|---|---|
| 平台适配器 | `src/adapters/<id>.js` | 与适配器 `id` 一致 |
| 导出包导入器 | `src/adapters/exports/<vendor>.js` | 厂商名 |
| 平台测试 | `test/adapters/<id>/*.test.js` | — |
| 平台夹具 | `test/fixtures/<id>/` | — |
| 平台文档 | `docs/platforms/<id>.md` | — |
| 命令实现 | `src/commands/<verb>.js` | CLI 动词 |
| 路由实现 | `src/api/<domain>.js` | 领域名 |

## 已消灭的冲突点（B0 成果，勿回退）

| 原冲突点 | 现状 |
|---|---|
| `src/adapters/index.js` 手写 import + 数组 | 自动发现，新增平台不改此文件 |
| `src/core/registry.js` 内联 `ALIASES` | 移到 `src/core/aliases.js` |
| `src/adapters/web-exports.js` 单文件混 4 个 importer | 拆到 `src/adapters/exports/{chatgpt,claude,generic,markdown}.js` |
| `src/core/ucm.js` 464 行混模型/渲染/脱敏/指纹 | 拆成 model / text / render / redact / identity 五层，`ucm.js` 只 re-export |
| `package.json` 硬编码两个测试文件 | 改为 `"test/**/*.test.js"` glob，新测试自动纳入 |
| IDE 配置/工作区状态混入提交 | `.gitignore` 已覆盖 `.idea/` `.vscode/` `.workbuddy/` |
| CRLF 行尾污染 diff | `.gitattributes` 统一 LF，`.cmd/.bat/.ps1` 保留 CRLF |

> 若有人把手写清单加回来，`test/contract/discovery.test.js` 的注入用例会失败。
> 若有人让 UCM 各层互相引用，`test/contract/layering.test.js` 会失败。
