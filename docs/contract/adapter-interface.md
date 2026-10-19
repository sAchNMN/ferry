# 适配器契约 v1（冻结）

状态：**冻结**。变更需走 `docs/rfc/` 提案，由契约负责人裁决。
生效日期：2026-10-19。对应基线提交：`v0.1.0-baseline`。

本文件定义平台分支与核心之间的**唯一接口**。平台分支只准按本文件实现，不准改本文件。

---

## 1. 装配方式
适配器目录 `src/adapters/` 下的每个 `.js` 文件会被自动加载：

- default 导出或命名导出均可，一个文件可导出多个适配器（如 `gemini-family.js` 导出 3 个）；
- **支持一层子目录**，如 `src/adapters/exports/chatgpt.js`（同族适配器可聚在一个目录里）；
- 判定依据是对象自身的 `kind` 字段，不看文件名、不看变量名；
- `_` 前缀的文件、`_` 前缀的目录与任意层级的 `index.js` 不参与发现
  （前者是内部实现，后者是聚合出口）；
- **`id` 全局唯一**，不同对象用同一 id 会直接抛错，不静默覆盖；
  同一对象被多个文件 re-export 不算重复（按引用判定）。

```js
// src/adapters/my-agent.js
import { defineStore } from '../core/adapter.js';
export default defineStore({ id: 'my-agent', name: 'My Agent', scan, read });
```

> 新增平台 = 新增一个文件。**不需要**改 `src/adapters/index.js`，也不需要改任何清单。

文件按文件名字母序加载，因此 `scan` 结果顺序稳定但不对应业务优先级；
需要排序的地方（如 CLI 列表）由展示层自行排序。

## 2. Store（本机会话仓库）

```js
{
  kind: 'store',
  id: string,            // 全局唯一，kebab-case
  name: string,          // 展示名
  vendor?: string,       // 厂商
  category?: 'cli'|'ide'|'desktop'|'chat'|'framework',
  region?: 'global'|'cn',
  capabilities: {
    scan: true,
    export: true,
    import: boolean,     // 是否支持**原生写入**（能出现在目标应用历史列表里）
    resume: boolean,     // 导入后能否直接接着聊
    attachments: boolean,
    tools: boolean,
  },
  scan(env): Promise<ScanRef[]>,
  read(env, ref, ctx): Promise<Conversation>,   // UCM 对象
  import?(env, conv, opts): Promise<ImportResult>,  // 仅 capabilities.import === true 时必需
  backupScope?(env): string[],                  // 导入时会原地改写的索引/DB 文件
  resumeHint?(conv): string,
  docs?: string,
}
```

### 2.1 备份范围声明（迁移期机制）

导入前必须备份"会被原地改写"的索引或数据库。这段逻辑原本硬编码在 `migrate.js` 的 switch 里，
每加一个平台就要改核心文件 —— 这是并行开发的一个隐性冲突点。现在改成两段式：

```js
// 优先：适配器自己声明
backupScope(env) {
  return [path.join(env.home, '.my-agent', 'index.json')];
}

// 回落：migrate.js 的 legacyBackupScope switch（仅覆盖已有平台）
```

规则：

- **声明优先**。适配器有 `backupScope` 就完全以它为准，即使返回空数组也不回落
  （空数组 = 明确表示"本次导入不改写任何既有文件"）。
- **返回值必须是绝对路径数组**。返回非数组、或数组里混入 null/undefined，视为声明有误：
  非数组按空处理，数组里的空值被过滤（见 `test/contract/backup-scope.test.js`）。
- **新平台禁止往 switch 加 case**。switch 只作历史回落，不再接受新分支。
- 未知或不支持导入的平台返回空数组，**不猜路径** —— 宁可少备份，也不去碰一个没验证过的文件。

**ScanRef**
```js
{ id, title, path, updatedAt?, createdAt?, messages?, bytes?, workspace?, preview? }
```

**ImportResult**
```js
{ writes: [{ path, kind }], notes: string[], resume: string }
```

### 硬性要求

1. `scan` 必须只读。任何 `scan` 期间写盘的行为视为缺陷。
2. `read` 失败必须抛 `FerryError`（带 `code` 与 `hint`），不得返回 `null` 或空对象。
   `safeRead()` 依赖这个约定把单会话失败隔离成"跳过并记录"，而不是整次导出崩溃。
3. `capabilities.import === true` 时，`import` 必须在 `opts.dryRun` 为真时**零写盘**，
   且返回的 `writes` 与真实执行时完全一致。
4. `import` 必须有幂等性：同一 `conv` 导入两次，第二次不得产生重复会话。
5. 适配器**永远不直接读** `process.env` / `os.homedir()` / `process.cwd()`，一律走 `env`；
   测试会把 `env` 指向临时目录来伪装一台电脑，绕过 `env` 意味着测试会读到开发者真机数据。

## 3. Importer（外部导出文件）

```js
{
  kind: 'importer',
  id: string,
  name: string,
  extensions: string[],           // 提示用，不参与匹配
  detect(buf, filename): boolean, // 必需：判断这个文件是不是我的
  read(buf, filename, ctx): Promise<Conversation|Conversation[]>,
}
```

`detect` 是**必需**字段：`registry.pickImporter()` 逐个调用 `imp.detect?.(buf, filename)`，
缺失该字段的导入器永远不会被选中，且不会报错——这是静默失败。
契约测试 `test/contract/discovery.test.js` 会拦住这种情况。

`detect` 必须对未知内容返回 `false`，不得"猜测式命中"。

## 4. env 契约

`env` 是唯一的机器视图，由 `src/core/env.js` 构造：

| 字段 | 含义 |
|---|---|
| `env.home` | 用户主目录（测试中是临时目录） |
| `env.platform` | `win32` / `darwin` / `linux` |
| `env.cwd` | 当前工作目录 |
| `env.appData` / `env.globalStorage(app)` | Windows / VSCode 系路径解析 |
| `env.codeUser(app)` | VSCode 系用户目录 |

## 5. ctx.blobs

`ctx.blobs` 是内容寻址的附件仓库，由 `archive.createBlobStore()` 提供：

```js
blobs.put(buffer, { mime, name }): string   // → sha256
blobs.get(sha256): Buffer
blobs.size / blobs.bytes()
```

适配器只负责把二进制塞进去、把 sha256 写进 UCM 的 `blocks[].blob`，不负责存储路径。

## 6. 别名

别名是全局命名空间，集中在 `src/core/aliases.js`（纯数据文件）。
**平台分支不得修改该文件**，需要新增别名时在 PR 描述里提出，由集成负责人统一提交。

## 7. ImportPlan（v1 目标形态，当前未实现）

现状：`migrate.js` 直接调 `store.import(env, conv, { dryRun })`，计划与执行在同一次遍历里完成。
要达到"零写盘预演 → 用户确认 → 重检 → 应用"的流程，需把 `import` 拆成两段：

```js
planImport(env, conv, opts): Promise<ImportPlan>   // 零写盘
applyImportPlan(env, plan, opts): Promise<ImportResult>
```

```js
ImportPlan = {
  target: { id, version },
  writes: [{ path, kind, existed, bytes, sha256? }],
  backupScope: string[],          // 需要备份的索引/DB，迁移前取一致快照
  locks: string[],                // 需独占的资源
  idMap: Record<string,string>,   // 源会话 id → 目标 id
  losses: [{ kind, detail }],     // 丢失/降级/截断，必须显式列出
  resume: string,                 // 导入后的续聊入口
  stateDigest: string,            // 应用前重检用，防止预览后目标已变化
}
```

迁移策略（避免核心与适配器互相等待）：

1. 契约层只定义 `ImportPlan` 结构，不实现；
2. 核心提供默认包装器：适配器未实现 `planImport` 时，用现有 `import()` 的 `dryRun` 反推计划，
   并标注 `fidelity: 'inferred'`；
3. 各适配器在自己的分支里逐步替换为真实两段式，替换前链路可用、只是计划精度低。

## 8. 契约测试入口

```bash
npm test                    # 全部测试（含契约）
node --test "test/contract/*.test.js"   # 只跑契约
```

`test/contract/` 由契约负责人维护，平台分支只读。
新增适配器会被契约测试**自动纳入**（因为发现是自动的），无需登记。
