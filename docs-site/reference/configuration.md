# 配置项

运行配置保存在：

```text
data/config.json
```

首次启动由 `config/config.example.json` 生成。管理台「设置」「模型配置」页会更新它。

## 环境变量

环境变量优先级高于配置文件：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DUCKAI_CPA_HOST` | `127.0.0.1` | 监听地址；容器内需 `0.0.0.0` |
| `DUCKAI_CPA_PORT` | `8787` | 监听端口 |
| `DUCKAI_CPA_DATA_DIR` | `data` | 数据目录 |
| `DUCKAI_CPA_CONFIG_PATH` | `<data>/config.json` | 配置文件路径 |
| `DUCKAI_CPA_ADMIN_TOKEN` | 自动生成 | 管理后台 token |
| `DUCKAI_CPA_VERSION` | package/镜像版本 | 展示版本 |
| `HTTP_ADAPTER` | `fastify` | `fastify` / `native` |

## 配置分区

| 分区 | 关键项 |
| --- | --- |
| `server` | `host`、`port`、`cors` |
| `auth` | `apiKeys`、`adminToken` |
| `upstream` | `rps`、`maxConcurrent`、`queueLimit`、`queueTimeoutMs` |
| `duck` | `baseUrl`、`defaultModel`、`timeoutMs`、`allowPaidModels`、`challenge` |
| `prompts` | `mode`（inline/system）、`defaultSystemPrompt`、按模型 defaults |
| `logging` | `level`、`maxEntries`、`maxAgeDays` |
| `models` | 别名、按模型覆盖 |
| `identity` | `enabled`、`durableStream`、`sync`、`deviceName` |
| `proxy` | `enabled`、`type`、`host`、`port`、用户名密码、`noProxy` |
| `pool` | `enabled`、`maxIdentities`、`strategy`、队列、`bindingTtlDays` |
| `context` | `maxInputChars`、`maxMessages`、`onLimit` |
| `context.pdfSpill` | `enabled`、`inputCharLimit`、`maxPages` |
| `tools` | `webSearch`、`imageGeneration`、`clientFunctionCalling`、`location` |
| `conversations` | `mode`: `stateless` / `server` |
| `history` | `retentionDays` |

## 队列

```json
{
  "upstream": {
    "rps": 1,
    "maxConcurrent": 1,
    "queueLimit": 50,
    "queueTimeoutMs": 300000
  }
}
```

- `rps`：每秒上游请求数；
- `maxConcurrent`：同时执行的上游请求；
- `queueLimit`：最大排队数；
- `queueTimeoutMs`：排队超时。

上游是串行的；不要把它当成高并发代理。

## PDF 溢出

```json
{
  "context": {
    "pdfSpill": {
      "enabled": true,
      "inputCharLimit": 20000,
      "maxPages": 15
    }
  }
}
```

- `inputCharLimit`：触发 PDF 溢出的字符阈值；
- `maxPages`：上下文 PDF 最大页数；超过返回 413。

## 提示词

```json
{
  "prompts": {
    "mode": "inline",
    "defaultSystemPrompt": "",
    "defaults": {}
  }
}
```

- `mode=inline`：系统提示拼到第一条 user（兼容 duck.ai）；
- `mode=system`：使用 system role；
- `defaults` 可按模型覆盖。

## 工具

```json
{
  "tools": {
    "webSearch": true,
    "imageGeneration": true,
    "location": false,
    "clientFunctionCalling": { "enabled": true }
  }
}
```

- `location` 默认关闭；关闭时发送 `canUseApproxLocation:false`，避免位置提示；
- 不可用工具默认静默清理，可在「模型配置 → 危险/高级操作」关闭静默清理。

## 会话

```json
{
  "conversations": {
    "mode": "stateless"
  }
}
```

Chat Completions 默认 stateless；改为 `server` 或显式请求头启用服务端会话。

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `data/config.json` | 运行配置（含 token，0600） |
| `data/duckai.db` | SQLite：身份、绑定、订阅、日志、用量、历史、连接测试、摘要、统计 |
| `data/identity.json` | 默认身份密钥（保持稳定） |
| `data/pairing.json` | DuckDuckGo 恢复码（最高敏感） |

> 不要提交 `data/`；不要把完整 token/恢复码写进日志或截图。

## 相关

- [安装与部署](/guide/installation)
- [数据与安全](/reference/security)
