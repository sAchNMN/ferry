# LANE：test/compat-e2e

> 本文件是该分支的范围围栏。开工前先读完，任何越界改动在评审时直接打回。
> 契约见 `docs/contract/adapter-interface.md` 与 `docs/contract/ownership.md`（只读）。

| 项 | 值 |
|---|---|
| 分支 | `test/compat-e2e` |
| 工作目录 | `C:\Users\34759\Desktop\ferry-wt-e2e` |
| 基线 | `integration` @ `ferry-contract-v1` |
| 合并方向 | → `integration`（squash），禁止直接合 `master` |
| 主责 | 当裁判：定义"什么叫迁移成功"，并且只判不修 |

## 这个 lane 的定位

已经踩过一次坑：`test/adapters.test.js` 里有一条"导入后能重新扫描到"的用例，
它验证的是**实现**，而不是**用户结果**。文件写进去了、扫得到了，但标题被截断、
工具结果丢了、二次导入出副本 —— 这些它都不会红。

所以本 lane 只写**黑盒**用例：只看 `src/core` 的公开 API 和用户可见结果，
不看内部实现。实现怎么重构都不影响这些用例，除非行为变了。

**只判不修。** 发现实现有缺陷，记录在下方"已知缺陷"，交回对应 lane；
不允许为了让自己绿而去改 `src/**`。

## 允许修改

```
test/e2e/**                 （harness.js + 各验收用例）
test/contract/**            （契约守卫）
test/helpers.js             （公共夹具工具，单一负责人）
docs/lanes/compat-e2e.md
```

## 只读（改则提 RFC）

```
src/**                      全部实现代码
docs/contract/**
docs/format.md
package.json
```

## 禁止

- 修改 `src/**` 让测试变绿。发现缺陷 → 记录 → 交给对应 lane。
- 用真实 HOME、真实账号、真实会话数据跑测试。全部走 `mintMachine()` 的临时目录。
- 把"文件写进去了"当成"迁移成功"。验收标准必须是**目标应用能列出该会话且内容可读回**。
- 用 `assert.ok(x)` 这种模糊断言。每条断言都要能说清"用户在哪儿会看到这个失败"。

## 验收

```bash
npm test                            # 全量，含本 lane
node --test "test/e2e/*.test.js"    # 只跑端到端
```

未实现的能力写成 `test(..., { todo: '原因' }, ...)`，**不允许删掉或用 skip 掩盖**。
todo 是"已知缺口清单"，skip 是"假装不存在"。

## 覆盖率目标（按方案 §10 的验收分层）

| 层级 | 状态 |
|---|---|
| 两台电脑（A 导出 → B 校验导入 → 目标可见） | ✅ 已覆盖 |
| dry-run 零写盘 | ✅ 已覆盖 |
| 跨平台路径映射 | ✅ 已覆盖 |
| 归档篡改显式失败 | ✅ 已覆盖 |
| 真实 HOME 隔离（蜜罐） | ✅ 已覆盖 |
| 导出脱敏无明文残留 | ✅ 已覆盖 |
| 幂等（重复导入不产生副本） | ⏳ todo，待 `feat/migration-engine` |
| 源端标题保真 | ⏳ todo，待 dialog 适配器分支 |
| 跨 OS 矩阵（win/mac/linux 三套 env） | ⏳ 待补 |
| 故障注入（磁盘满 / 权限拒绝 / 中断恢复） | ⏳ 待补 |
| 真实产品续聊（打开应用发下一条消息） | ⏳ 需人工，不进 CI |

## 已知缺陷（本 lane 实测发现）

| # | 严重度 | 现象 | 归属 |
|---|---|---|---|
| 1 | 高 | 同一归档导入两次 → 产生 2 个副本（实测 `actual: 2`）。`import` 每次生成新 sessionId，没有按指纹查重 | `feat/migration-engine` |
| 2 | 中 | Codex 的 `session_index.jsonl` 里有 `thread_name`，但 `read()` 用 `deriveTitle` 覆盖，用户起的会话名变成首条消息截断 | adapter 分支 |
| 3 | 中 | `importConversations({ map })` 的 JSDoc 写 `string[]`，实际必须传 `compileMappings()` 处理过的 `{from,to}[]`。传原始字符串会在 `mapPath` 里崩成 `Cannot read properties of undefined (reading 'replace')` | `feat/migration-engine`（建议内部自动编译，或至少抛带说明的错误） |

### 修复进度

- **#1 已修**：`feat/migration-engine` @ `1d97bd6` 引入导入台账（`<ferryHome>/imported.json`）
  与 `--force`。合入 `integration` 后，把本文件 `幂等` 那条用例的 `todo` 标记去掉即可转正。
- **#3 已修**：同提交的 `normalizeMap()`，`map` 同时接受 `['A=B']` 与 `[{from,to}]`。
  合入后「map 参数」相关的 todo/备注可删。
- **#2 未修**：等 Codex 适配器分支。

## 提交

- Conventional Commits，描述中文：`test(e2e): 覆盖跨平台路径映射`
- 合入前 `git merge integration` 并重跑全量
- **不要 push**
