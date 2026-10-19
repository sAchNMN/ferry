# LANE：feat/migration-engine

> 本文件是该分支的范围围栏。开工前先读完，任何越界改动在评审时直接打回。
> 契约见 `docs/contract/adapter-interface.md` 与 `docs/contract/ownership.md`（只读）。

| 项 | 值 |
|---|---|
| 分支 | `feat/migration-engine` |
| 工作目录 | `C:\Users\34759\Desktop\ferry-wt-engine` |
| 基线 | `integration` @ `ferry-contract-v1` |
| 合并方向 | → `integration`（squash），禁止直接合 `master` |
| 主责 | 迁移语义本身：路径、去重、事务、回滚、CLI |

## 目标

让"换一台电脑接着用"这件事在语义上正确，而不是只把文件搬过去。

1. **跨平台路径映射**：`C:\work\proj` ↔ `/Users/x/proj` ↔ `/home/x/proj`，
   覆盖盘符大小写、UNC、WSL `/mnt/c/`、Unicode 路径、同名目录。
2. **workspace 解析**：现有 `map / workspace / into / same-machine / unverified / cwd` 六种策略之外，
   补 `git-remote` 匹配（源与目标 remote 相同则认为是同一项目）。
3. **去重与增量**：同一会话二次导入不得产生副本；长会话追加而非覆盖。
   指纹由 `ucm-identity.js` 提供，**不要在本分支重写指纹算法**，需要改就提 RFC。
4. **导入事务**：一批会话失败要能整体回滚。现有"把 createdPaths 补进 manifest"的做法要抽象成事务对象，
   支持中断恢复。
5. **dry-run 与真实写入报告结构完全一致**（这是契约硬性要求第 3 条）。

## 允许修改

```
src/core/migrate.js
src/core/backup.js
src/core/sqlite.js
src/core/env.js
src/cli.js
src/commands/**            （若 CLI 拆分已落地）
test/migration/**
docs/lanes/migration-engine.md
```

`src/core/util.js` 只允许**追加新函数**，不得修改或删除已有导出（17 处调用方）。

## 只读（改则提 RFC）

```
docs/contract/**
docs/format.md
src/core/ucm-model.js
src/adapters/**
src/core/archive.js  tar.js  zip.js  crypto.js
src/core/ucm-render.js  ucm-redact.js  ucm-text.js  ucm-identity.js
package.json            （依赖与脚本由集成负责人统一改）
```

## 禁止

- 改动任何 `src/adapters/**` 文件 —— 那是平台分支的独占区。需要适配器配合，提 issue 给别人。
- 把平台专属逻辑写进 `migrate.js`（比如"如果是 Cursor 就……"）。这类需求一律走 `backupScope` / `ImportPlan`。
- 往 `legacyBackupScope` 的 switch 加 case —— 它已经冻结为历史回落。
- 自行 `npm install`。本项目维持零运行时依赖。

## 验收

```bash
npm test                                  # 必须全绿，含 test/contract/**
node bin/ferry.js doctor                  # 自检
node --test "test/migration/*.test.js"    # 本 lane 专项
```

新增测试必须落在 `test/migration/`，不得改动 `test/contract/`（那是契约守卫，平台分支只读）。

## 提交

- Conventional Commits，类型前缀英文，描述中文：`feat(migrate): 支持 WSL /mnt 路径映射`
- 小步提交，一个可独立验证的改动一个 commit，不攒批
- 合入前 `git merge integration` 并重跑全量测试
- **不要 push**，由用户执行
