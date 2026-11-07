# 订阅与身份

Duck.ai 的付费模型/更高额度依赖 DuckDuckGo 登录态。DuckAI CPA 用“订阅实体 + 身份绑定”管理这些登录态。

## 概念

| 概念 | 说明 |
| --- | --- |
| 身份（identity） | 网关在 duck.ai 侧的匿名身份：journeyId、设备指纹、durable stream 密钥、RSA 密钥 |
| 订阅（subscription） | 一份 DuckDuckGo 登录 token/refresh token，可绑定到一个身份 |
| 绑定（binding） | 身份 ↔ 订阅的关系；付费模型只路由到已绑定的订阅身份 |
| 冷却（cooldown） | 上游额度耗尽后的临时禁用窗口 |

## 捕获登录 token

duck.ai 的登录 token 依赖 DuckDuckGo 登录 cookie，Node 侧无法直接获取，必须由**已登录的浏览器**回传。

管理台提供两种方式：

1. **书签脚本**：在已登录 duck.ai 的标签页运行脚本，回传同源 token；
2. **Console 脚本**：打开开发者工具粘贴执行。

脚本会把 `sessionId`/token 通过 URL hash 带回管理台，管理台立即清除 hash，避免 token 留在历史记录。

> token 有效期约 4 小时；自刷新 refresh token 有效期约 30 天。

## 绑定身份

1. 在「订阅」页创建订阅；
2. 选择要绑定的身份；
3. 保存后，该身份进入付费池；
4. 付费模型请求会优先路由到付费池的订阅身份。

## 自动续期

如果需要长期运行：

1. 从浏览器捕获 `ddg_auth_refresh_token`（HttpOnly cookie）；
2. 在订阅页粘贴并启用自动续期；
3. 网关每 5 分钟巡检，在到期前 30 分钟续期；
4. 续期后的 token 会同步到绑定身份。

> refresh token 是敏感凭据，只保存在 `data/duckai.db` 的加密字段/订阅记录中；接口只返回脱敏信息。

## 删除规则

身份被订阅绑定时不能直接删除：

```text
409 identity_has_subscription
```

先解绑订阅，或使用强制解绑参数（会退出 duck.ai 登录态，需明确确认）。

## 额度冷却

当上游返回：

- `ERR_USER_LIMIT` / `[LIMIT_ENTITY]`：免费每日额度；
- `ERR_ACCOUNT_LIMIT`：账号额度；

网关会把当前身份写入冷却时间（通常取上游 resetAt，缺省 1440 分钟）。冷却中的身份不参与路由，但已有会话不会提前解绑；下次请求需要时再懒改绑。

## 安全建议

- 不要把恢复码、refresh token、完整 access token 粘贴到聊天/issue；
- 管理台截图前确认 IP/身份/token 已脱敏；
- 定期备份 `data/duckai.db` 与 `data/config.json`，但不要提交到仓库。
