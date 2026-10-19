# LANE：feat/adapter-codex

> 本文件是该分支的范围围栏。开工前先读完，任何越界改动在评审时直接打回。
> 契约见 `docs/contract/adapter-interface.md` 与 `docs/contract/ownership.md`（只读）。

| 项 | 值 |
|---|---|
| 分支 | `feat/adapter-codex` |
| 工作目录 | `C:\Users\34759\Desktop\ferry-wt-codex` |
| 基线 | `integration` @ `5dcc569` |
| 合并方向 | → `integration`（squash） |
| 主责 | Codex 的读写双向：扫描、读取、写回 rollout、索引与 threads 表 |

## 为什么单独立一条 lane

Codex 是**唯一有真实数据可对照**的目标端（本机 112 个真实会话）。
端到端用例里"导入后能扫描到"是循环论证——写和读都是我们的代码，
真实 `codex` CLI 用自己���解析器。所以这条线的验收标准必须比别处更硬：
**生成文件的结构要和真实 rollout 逐字段对得上**。

## 允许修改

```
src/adapters/codex.js
test/adapters/codex/**
docs/lanes/adapter-codex.md
```

## 只读（改则提 RFC）

```
src/core/**          迁移、归档、UCM 全部不归这里
src/adapters/其他文件
docs/contract/**
docs/format.md
package.json
```

## 禁止

- 伪造**策略/行为**字段（`sandbox_policy`、`permission_profile`、`approval_policy` 之外的审批配置、
  `collaboration_mode`）。这些表达的是用户的安全姿态，写错等于替用户做了决定。
- 为了通过测试而修改断言。测试是从真实文件统计出来的，断言错说明实现错。
- 在 `read()` 里用 `deriveTitle` 覆盖源端标题（见下）。

## 已完成

| 项 | 说明 |
|---|---|
| `session_meta` 字段对齐 | 补齐 `session_id` / `thread_source` / `history_mode` / `runtime_workspace_roots` / `base_instructions` / `context_window`，与真实文件**完全一致** |
| 外层信封 | 补 `ordinal`（连续递增） |
| `turn_context` | 补 `root_turn_id` / `workspace_roots` / `current_date` / `timezone` |
| `response_item` | 补 `id` 与 `internal_chat_message_metadata_passthrough`（message / function_call / function_call_output） |
| dry-run 预览 | 原先只报 rollout，漏报 `session_index.jsonl`，用户按预览判断风险是错的；已补 |

## 待做

| 项 | 说明 |
|---|---|
| 标题丢失 | `scan` 已从 `session_index.jsonl` 拿到 `thread_name`，但 `read()` 用 `deriveTitle` 覆盖成首条消息截断 |
| `event_msg` / `world_state` / `token_usage_record` | 遥测与 UI 事件，评估是否影响 resume；倾向不写（真实文件里它们是运行时产物） |
| `reasoning` 类 response_item | 我们目前不产出（thinking 块没写进去），`status` / `summary` / `encrypted_content` 属于这类条目 |

## 验收

```bash
npm test
node --test "test/adapters/codex/*.test.js"
```

结构类断言全部来自真实 rollout 实测，不是猜的：

```
session_meta: session_id, id, timestamp, cwd, runtime_workspace_roots,
              originator, cli_version, source, thread_source, model_provider,
              history_mode, base_instructions{text,provenance}, context_window{window_id}
envelope:     timestamp, ordinal, type, payload
```

## 提交

- Conventional Commits，描述中文：`fix(codex): 写回 rollout 的 session_meta 补齐真实字段`
- **不要 push**
