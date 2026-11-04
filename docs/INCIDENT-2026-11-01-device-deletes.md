# 事故复盘：误删用户手机设备（2026-11-01）

## 影响

- 用户在 DuckDuckGo Sync 账号（`user_id = 489adc11-ab46-4046-8411-c2ce3f0a18bf`）中的**手机设备被删除**：
  - `device_id: c2458c0e-f14e-4f23-93f5-1adb4bac7e45`
  - `name: HONOR BRT-AN00`，`type: phone`，`credential_id: ddg`
- 手机端表现：从「My Devices」消失；无法再与其他设备配对/同步（该设备的 Sync 会话被 `/logout-device` 注销）。

## 时间线（America/New_York）

| 时间 | 事件 |
| --- | --- |
| 11-01 09:45 | 用户手机扫码配对成功，账号与设备（HONOR）建立 |
| 11-01 10:00–13:40 | 反复联调设备注册/槽位；此阶段设备列表仍含 HONOR |
| ~11-01 13:50 | 执行 `node scripts/page-check.mjs`（带 admin token / real account）；用例「sync 设备契约（v2.8）」中「删除其它设备 → 预期 200」挑选**第一个非当前设备** → 恰为 HONOR → `DELETE /admin/api/sync/server-devices/c2458c0e…` → 后端 `logoutDevices([id])` → **手机设备被注销并从账号删除** |
| 11-01 14:14 | Lead 复查设备列表发现 HONOR 已消失（当时误以为是缓存问题） |
| 11-02 01:57 | 用户反馈手机无法配对、设备消失 |

## 根本原因

1. **测试脚本含破坏性用例**：`scripts/page-check.mjs` 为验证「删除其它设备返回 200」，从真实账号的设备列表里**任取一台**执行 DELETE。账号里唯一的「其它」设备就是用户的手机。
2. **后端缺少安全校验**：`DELETE /admin/api/sync/server-devices/:id` 不校验设备是否存在于真实列表，任意 id 都返回 200（事后复测：不存在的 uuid 也 200），使误删无任何阻力。
3. **删除语义未区分当前设备**：用户要求默认设备也可删除，但当时实现对当前设备一律 400，前端显示不可删；与此同时「其它设备」删除却是无确认的一键操作。

## 已修复

| 修复 | 文件 |
| --- | --- |
| page-check 删除用例改为「删除不存在的设备 → 400/404」；真实删除仅在 `--allow-device-delete --delete-device-id=<id>` 显式开启时执行 | `scripts/page-check.mjs` |
| 后端：删除前校验设备存在，未知 id → 404 `invalid_device` | `src/admin/sync-devices.js` |
| 后端：当前设备（DuckAI@main）支持 `?force=true` 确认删除（注销设备但保留身份/账号/恢复码，可重新注册） | `src/admin/sync-devices.js` |
| 前端：当前设备显示「删除」，二次确认 + 安全提示 | `webapp/` |
| 静态护栏测试：禁止脚本从真实设备列表挑选设备删除 | `tests/scripts-safety.test.js` |

## 用户侧恢复步骤（手机）

手机设备已被注销，需要**重新加入账号**：

1. **推荐**：在网关「身份」页打开「DuckDuckGo 官方恢复码」→ 点二维码（或复制完整恢复码）；
2. 手机：DuckDuckGo → 设置 → Sync & Backup → 「Sync with another device / 输入恢复码」→ 粘贴恢复码（或扫码）→ 确认；
3. 若手机端仍提示失败：在仍保持登录的桌面浏览器（账号内 Chrome/Edge 设备）里打开 DuckDuckGo → Sync & Backup → 生成配对二维码，用手机扫描；
4. 完成后手机设备会重新出现在 My Devices。

## 遗留与建议

- 账号里仍保留我们的网关设备 `DuckAI@main`（`ad9c87a3…`）。如不再需要，可在「DuckDuckGo 设备列表」卡片删除（本版起支持删除当前设备，`?force=true`+二次确认）。
- 建议后续：任何自动化脚本对真实账号的写操作默认禁用，必须显式开关；设备删除类操作统一二次确认 + 审计日志。

---

## 取证细节（Lead，2026-11-02 复核）

- 恢复码**未被修改/轮换/删除**：网关只把它用于 Sync 登录（HKDF 派生 `scopedPassword`/`hashed_password`）与设备注册；存储于 `data/pairing.json`（权限 0600），未写入日志。
- 账号 `user_id` 仍为 `489adc11-ab46-4046-8411-c2ce3f0a18bf`，恢复码仍可正常登录（2026-11-02 复核 `login 200`）。
- 手机设备 `c2458c0e-…` 已不在账号设备列表中，其余设备为：`Chrome 156.0.0.0`、`Edge 156.0.0.0`、`DuckAI@main`（网关自身）。
- 删除动作来自 `scripts/page-check.mjs` 的「sync 设备契约（v2.8）」用例（2026-11-01 约 13:50 EDT 执行多次），其逻辑为「任取一台非当前 uuid 设备执行 DELETE→期望 200」。
- 事后清理：Lead 用固定 `identity.deviceId` 登录清理了调试产生的 `DuckAI@probe` / `DuckAI@cleanup*` 临时设备，避免继续污染账号。

## v2.13 后续修复（已完成）

1. `scripts/page-check.mjs`：默认**不再删除任何真实设备**（改为删除不存在的 uuid 期望 404）；真实删除需 `--allow-device-delete --delete-device-id=<id>`；orphan 注入用例改为 `--inject-orphan` 显式开启，其余情况 SKIP。
2. 后端 `DELETE /admin/api/sync/server-devices/:id`：
   - 设备不存在 → **404 `invalid_device`**（此前任意 id 返回 200）；
   - 当前设备（DuckAI@main）默认 400，带 `?force=true` 可删除：注销设备但**保留**身份、账号与官方恢复码，随后可重新注册；
   - 删除/注销写入审计日志（deviceId/deviceName/current）。
3. 后端 `PUT /admin/api/sync/device-slots`：允许不含默认身份（用户要求），移除默认设备时注销该设备并把 `server.registered=false`，但保留身份与账号；此后只读列表走缓存，避免 re-login 立即把设备重新创建。
4. 前端：「DuckDuckGo 设备列表」允许删除当前设备（二次确认 + 明确提示「本机匿名身份、配对账号与官方恢复码不受影响」），并在卡片顶部增加误删警示。
5. 回归：`npm test` 343/343、`build-check` 16/16、`page-check` 22/22。