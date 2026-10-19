# LANE：feat/package-conversion

> 本文件是该分支的范围围栏。开工前先读完，任何越界改动在评审时直接打回。
> 契约见 `docs/contract/adapter-interface.md` 与 `docs/contract/ownership.md`（只读）。

| 项 | 值 |
|---|---|
| 分支 | `feat/package-conversion` |
| 工作目录 | `%USERPROFILE%\Desktop\ferry-wt-package` |
| 基线 | `integration` @ `ferry-contract-v1` |
| 合并方向 | → `integration`（squash），禁止直接合 `master` |
| 主责 | 容器、加密、校验、渲染与脱敏 |

## 目标

1. **流式加解密**：现在 `archive.js` 整包读入内存。大归档（>500MB）必须能跑，不能 OOM。
2. **增量包（ferrypack/2 提案）**：只含新增会话 + 父包 id。
   **只提 RFC，不直接改 `docs/format.md`**，也不得破坏 `ferrypack/1` 的读取能力。
3. **分卷**：超过单卷上限时切片，读取端能自动拼回。
4. **损坏检测**：`conversations[].sha256` 不匹配必须显式失败；
   `--no-verify` 降级路径要可观测（告诉用户跳过了多少项校验）。
5. **资源限制**：限制条目数、单文件/总体解压体积、压缩比、嵌套深度、KDF 资源消耗；
   拒绝绝对路径、路径穿越、危险符号链接、重复路径覆盖。
6. **渲染与脱敏**：`ucm-render.js` / `ucm-redact.js` / `ucm-text.js` 的归属在你这边，
   但**接口不得变更**（`renderMarkdown` / `renderHandoff` / `redactConversation` 的签名与返回结构）。

### 进度

| 目标 | 状态 | 说明 |
|---|---|---|
| 资源限制（防炸弹） | ✅ 完成 | `src/core/limits.js`：gzip 体积上限、条目数、单条/总量预算 |
| 路径安全 | ✅ 完成 | 拒绝 `../`、绝对路径、盘符、反斜杠、NUL；附件名必须是 64 位 hex sha256 |
| 损坏检测 | ✅ 已有 | `sha256` 不匹配显式失败（`ECHECKSUM`），`--no-verify` 跳过 |
| 流式加解密 | ⏳ 待做 | 现在整包读入内存，大归档会 OOM |
| 增量包 ferrypack/2 | ⏳ 待做 | 需先提 RFC |
| 分卷 | ⏳ 待做 | |
| 压缩比上限 | ⏳ 待做 | 目前靠总量上限兜底，未单独限制 ratio |

## 允许修改

```
src/core/archive.js
src/core/tar.js
src/core/zip.js
src/core/crypto.js
src/core/ucm-render.js
src/core/ucm-redact.js
src/core/ucm-text.js
test/archive/**
docs/rfc/**                            （格式变更提案）
docs/lanes/package-conversion.md
```

## 只读（改则提 RFC）

```
docs/contract/**
docs/format.md                         ← 格式规范，只能提 RFC，不能直接改
src/core/ucm-model.js                  ← UCM 契约本体
src/core/ucm-identity.js               ← 指纹归 engine lane
src/core/migrate.js  backup.js  sqlite.js  env.js  cli.js
src/adapters/**
package.json
```

## 禁止

- 修改 `ucm-model.js` 的任何导出（schema 变更走 RFC）。
- 修改 `renderMarkdown` / `renderHandoff` / `redactConversation` 的签名或返回结构。
- 让加密算法"自己设计"——只用 Node 标准库的 AES-256-GCM + scrypt，参数变更需 RFC。
- 把密码写进日志、命令行历史或 manifest。
- 自行 `npm install`。

## 验收

```bash
npm test                              # 必须全绿，含 test/contract/**
node --test "test/archive/*.test.js"  # 本 lane 专项
```

新增测试落在 `test/archive/`。三条必测：加密往返、错误密码必须失败、篡改必须失败。

## 提交

- Conventional Commits，类型前缀英文，描述中文：`feat(archive): 支持流式 AES-GCM 解密`
- 小步提交，一个可独立验证的改动一个 commit
- 合入前 `git merge integration` 并重跑全量测试
- **不要 push**，由用户执行
