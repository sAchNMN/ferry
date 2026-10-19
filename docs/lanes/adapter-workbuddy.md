# LANE：feat/adapter-workbuddy

> 本文件是该分支的范围围栏。契约见 `docs/contract/adapter-interface.md`（只读）。

| 项 | 值 |
|---|---|
| 分支 | `feat/adapter-workbuddy` |
| 基线 | `integration` @ `4f33998` |
| 合并方向 | → `integration`（squash） |
| 主责 | WorkBuddy 的读写双向：扫描、读取、写回 JSONL、登记 `sessions` 表 |

## 为什么值得做

WorkBuddy 是本机**主力** Agent：`~/.workbuddy/projects` 下有 120 个会话文件，
`workbuddy.db` 里 123 行 `sessions`，17k+ 条消息。Ferry 支持了十几个 CLI，唯独没支持自己天天在用的这个。

## 存储结构（实测，不是猜的）

```
~/.workbuddy/
├── projects/<slug>/<sessionId>.jsonl        会话正文，一行一个事件
├── projects/<slug>/<sessionId>/tool-results/ 工具输出溢出文件（正文里只留引用，不迁）
├── workbuddy.db → sessions 表                侧栏历史只认这里，不扫目录
└── blobs/<前两位>/<sha256>.<ext>            图片正文，image_blob_ref 里带 blob_path
```

`<slug>` 规则（用本机 123 行 `sessions` 实测，113 行直接命中，其余 8 行是 `D:\` 与 UNC，同一规则也成立）：

| cwd | 目录名 |
|---|---|
| `C:\Users\me\Desktop\Thdr` | `c-Users-me-Desktop-Thdr` |
| `\\wsl.localhost\Ubuntu\home\zc\p` | `wsl.localhost-Ubuntu-home-zc-p` |
| `D:\` | `d` |

## 事件类型（实测 8 种，本机 46,308 行统计）

| type | 处理 |
|---|---|
| `session-meta` | 只取 `meta`，无正文 |
| `message` | `role=user/assistant`，`content[]` 是 `input_text` / `output_text` / `image_blob_ref` |
| `reasoning` | `rawContent[]` 的 `reasoning_text` → UCM `thinking` |
| `function_call` | `arguments` 是 **JSON 字符串**，`callId` 关联结果 |
| `function_call_result` | `output` 有三种形态：字符串 / `{type,text}` / `[{type:'input_text',text}]` |
| `ai-title` | 模型生成的标题，写在首轮之后（所以扫描不能读几行就 break） |
| `file-history-snapshot` | 文件快照，与对话无关，跳过 |
| `resend-fork-notice` | 重发标记，跳过 |

## 踩过的坑

1. **每一轮的用户消息都被 `<system-reminder>` 包着。**
   `input_text` 里先是一大段环境上下文 / 身份文件 / 记忆提醒（单轮 8KB），
   真正的提问在末尾的 `<user_query>` 里。不剥离 = 导出全是系统提示 + 标题取成提示词原文。
   这和 Codex 那条 lane 的 `isSyntheticUserText` 是同一类问题，但这里不能整条丢掉，
   必须**剥壳再取**（`cleanUserText()`）。
2. **侧栏只读数据库。** 只写 JSONL 不登记 `sessions` 表，重启后历史里什么都没有。
   `user_id` 必须沿用本机已有值（换 id 等于把数据挂到别的账号下）。
3. **`workbuddy.db` 是 WAL 模式。** 备份必须把 `.db` / `.db-wal` / `.db-shm` 一起声明，
   只备份 `.db` 得到的是不一致快照。
4. **删掉的会话文件还在。** 57/120 个文件在 `sessions.deleted_at` 里有值 —— 扫描要跳过，
   否则迁过去的全是用户已经删掉的东西。
5. **`<uuid>.file-rollback.ndjson`** 与 `<uuid>.jsonl` 同目录，扩展名只差一个字母，必须精确匹配 `.jsonl`。

## 写回原则

**补身份/结构字段，不伪造策略/遥测/展示字段。**

| 补齐（少了解析不了） | 不写（编出来就是骗人） |
|---|---|
| `session-meta` 的 `type/id/sessionId/timestamp/meta` | `usage` / `rawUsage`（token 统计） |
| 每行的 `cwd` / `parentId` 链 | `traceId`（外部链路追踪） |
| `providerData` 的 `agent` / `conversationRequestId` / `messageId` / `model*` | `argumentsDisplayText`（UI 摘要文案） |
| `ai-title`（不带 `parentId`，它不在消息链上） | `toolResult` 的 `{title,content,renderer}` 渲染结果 |

## 验收

```bash
npm test                                      # 124 全绿
node --test test/adapters/workbuddy.test.js   # 13 条
```

真实数据回归（只读源、写到临时目录，脚本在 `.tmp/`，被 gitignore）：

| 项 | 结果 |
|---|---|
| 扫描 | 120 个文件 → **63 个会话**（57 个已删除被跳过，0 个空会话），约 0.1s |
| 导出 | 63 会话 / 17,270 条消息 / 8.28M 字符 / 36 张图，0 错误，约 2s（含读回溢写文件） |
| 写回结构 | 6 种事件类型的字段集合与真实文件 **全部 EXACT MATCH** |
| 往返保真 | 63/63 会话逐块一致（role、text、tool output、thinking、图片 mime 全等）；导入约 1.3s |
| 幂等 | 二次导入 `skipped=true`，无副本 |
| dry-run | 零写盘，清单与真实写入结构一致（会话 id 随机，故比结构不比文件名） |

## 已知局限

- 工具输出的溢写文件（`<session>/tool-results/*.txt`）**不复制**：导出时把正文读回来内联进消息（`<persisted-output>` 占位 → 全文），
  迁过去是完整内容，不保留"引用文件"这种死链。超过 8MB 的输出会被截断并标注。
- `providerData.usage` 不写 → 迁移后的会话在 UI 上不显示 token 消耗。这是**故意**的：数字编不出来。
- **真实应用内的"点开能续聊"没验证过**（作者无法在不影响自己数据的前提下启动第二个 WorkBuddy 实例）。
  结构已与真实文件逐字段对齐，但按 README 的证据分级，这一格是 🧪 而不是 ✅。
- 云端同步（`edge-sync-mapping-v4.db`）不碰：那是账号级同步，不是本地会话存储。

## 提交

- Conventional Commits，描述中文：`feat(workbuddy): 支持 WorkBuddy 会话扫描、导出与原生写回`
- **不要 push**
