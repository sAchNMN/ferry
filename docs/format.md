# .ferrypack 与 UCM 格式规范

版本：`ferrypack/1`、`ferry.conversation/1`

## 1. 容器

```
tar ──gzip(level 9)──▶ [AES-256-GCM] ──▶ *.ferrypack
```

未加密时文件以 `1f 8b`（gzip）开头；加密时以 ASCII `FERRYENC1` 开头。

加密布局：

| 偏移 | 内容 |
|---|---|
| 0 | `FERRYENC1`（9 字节魔数，同时作为 GCM 的 AAD） |
| 9 | 4 字节大端：header 长度 |
| 13 | header JSON |
| … | 密文 |
| 末尾 16 字节 | GCM tag |

header：

```json
{
  "v": 1,
  "cipher": "aes-256-gcm",
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "base64" },
  "iv": "base64",
  "createdAt": "2026-10-19T06:00:00.000Z"
}
```

密钥 = `scrypt(password, salt, 32)`；`maxmem` 256MB。
任何一位被改动都会在 `final()` 时认证失败。

## 2. tar 内部布局

```
manifest.json
conversations/<id>.json
blobs/<sha256>
```

- 路径使用 `/`，UTF-8；超过 100 字节的名字用 PAX 扩展头（`path=`）。
- `blobs/<sha256>` 内容寻址，天然去重；不要依赖扩展名，MIME 记录在 manifest。

## 3. manifest.json

```json
{
  "format": "ferrypack/1",
  "ucm": "ferry.conversation/1",
  "createdAt": "2026-10-19T06:00:00.000Z",
  "generator": { "name": "ferry", "version": "0.1.0" },
  "host": { "platform": "win32", "arch": "x64", "hostname": "PC", "node": "v24.18.1" },
  "label": "换电脑前的备份",
  "encryption": { "enabled": true, "cipher": "aes-256-gcm", "kdf": "scrypt" },
  "stats": {
    "conversations": 12,
    "messages": 3456,
    "chars": 1234567,
    "blobs": 3,
    "blobBytes": 45678,
    "payloadBytes": 2345678,
    "archiveBytes": 456789
  },
  "sources": [{ "adapter": "claude-code", "conversations": 10 }],
  "conversations": [
    {
      "id": "…",
      "file": "conversations/….json",
      "title": "补全 README",
      "adapter": "claude-code",
      "sourceName": "Claude Code",
      "workspace": "C:\\work\\proj",
      "createdAt": "…",
      "updatedAt": "…",
      "messages": 42,
      "toolCalls": 7,
      "images": 0,
      "chars": 12000,
      "bytes": 34000,
      "sha256": "会话文件内容的 sha256",
      "fingerprint": "跨机去重用的指纹",
      "model": "claude-sonnet-4-5"
    }
  ],
  "blobs": [{ "sha256": "…", "file": "blobs/…", "bytes": 1024, "mime": "image/png", "name": "a.png" }],
  "notes": []
}
```

读取方必须校验 `conversations[].sha256`；不匹配说明归档损坏（可用 `--no-verify` 跳过，但应视为降级模式）。

## 4. UCM（统一会话模型）

一个会话一个 JSON 文件，UTF-8，无 BOM。

```json
{
  "schema": "ferry.conversation/1",
  "id": "会话唯一 id（尽量沿用源 sessionId）",
  "title": "标题",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "source": {
    "adapter": "claude-code",
    "name": "Claude Code",
    "vendor": "Anthropic",
    "version": "2.0.0",
    "sessionId": "源会话 id",
    "path": "源文件路径（只作溯源）"
  },
  "workspace": {
    "cwd": "C:\\work\\proj",
    "roots": ["C:\\work\\proj"],
    "git": { "branch": "main", "remote": "…" }
  },
  "model": { "id": "claude-sonnet-4-5", "provider": "anthropic" },
  "tags": [],
  "messages": [
    {
      "id": "m_…",
      "role": "user | assistant | system | tool",
      "createdAt": "ISO-8601",
      "blocks": [
        { "type": "text", "text": "…" },
        { "type": "thinking", "text": "…" },
        { "type": "tool_call", "id": "call_1", "name": "shell", "input": { "command": "npm test" } },
        { "type": "tool_result", "callId": "call_1", "output": "…", "isError": false },
        { "type": "image", "blob": "<sha256>", "mime": "image/png", "name": "a.png" },
        { "type": "file", "blob": "<sha256>", "mime": "…", "name": "spec.pdf" },
        { "type": "citation", "url": "…", "title": "…" }
      ],
      "meta": { "internal": true, "sidechain": true }
    }
  ],
  "stats": { "messages": 4, "user": 1, "assistant": 2, "tool": 1, "toolCalls": 1, "chars": 120, "images": 0 },
  "meta": { "exportedAt": "…", "redacted": { "openai": 1 } },
  "extra": {}
}
```

约定：

- `role: "tool"` 的消息只承载工具结果；解析器应把 Anthropic 风格的 `tool_result` 用户消息归并为 `tool`。
- `meta.internal` 表示系统注入（环境上下文、compact 标记），导入时默认跳过。
- `meta.sidechain` 表示子 Agent 分支，导出默认保留、导入默认丢弃。
- 块顺序即真实顺序；渲染与转格式都应保持。
- `stats` 可重算，读取方不应依赖它做逻辑判断。

## 5. 兼容策略

- 读取时接受缺少 `stats` / `tags` / `extra` 的旧数据，并补齐。
- 未知 `blocks[].type` 原样保留为 `unknown`，不丢弃。
- 未来新增字段必须可选；破坏性变更提升 `schema` 主版本。
