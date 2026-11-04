# duck.ai experimental client tools 调研（task-68）

> **结论先行（TL;DR）**
> 1. duck.ai 前端确实有一层实验性 **client tools / browser bridge**，但它不是「OpenAI function calling」：
>    模型只能调用**上游固定注册**的工具（`supportedTools` 白名单 + `loadUserSkill` 固定契约），
>    客户端只能为这些固定能力提供执行结果。
> 2. `client-tools-support` 与 `skills` 两个实验开关**默认均为 false**（browser-profile flags，
>    来自 `GET /duckchat/v1/capabilities` 的 `flags`）；没有 DuckDuckGo 浏览器/扩展 bridge 时，
>    `capabilities` 列表为空，前端**不发** `x-duckai-client-tools` 头。
> 3. `x-duckai-client-tools` 协议为 `{version:1, capabilities:[{name,version}]}`；客户端本地只放行
>    `loadUserSkill` v1（skills 实验开启时）或 legacy 能力（client-tools-support 开启时）。
>    **自建任意 capability 名（如 `myTool` v1）不会被模型当工具调用**——上游没有对应的工具定义/契约。
> 4. `kind:"client-output"` 是 continuation 的「客户端工具结果」通道：服务端下发
>    `{kind:"client-output", toolCallId, toolName, contract, input, metadata.clientCapability?}`，
>    客户端回 `responses:[{kind:"client-output", toolCallId, output}]`；`BrowserLoadUserSkill.v1`
>    的输出必须是 `{name, content}`（content UTF-8 ≤ 32768 字节）。
> 5. 网关**不能**实现像 OpenAI 那样真正执行自定义函数；**唯一可尝试的灰色方案**是伪装
>    `loadUserSkill.v1` 承载「技能文本加载」（把本地技能内容作为 client-output 返回），
>    但受实验开关/上游校验/提示词注入风险限制，且**本轮未验证 200**。真正的自定义 function calling
>    应继续走网关现有文本注入 + MCP（`src/openai/function-calling.js` / `src/tools/mcp-client.js`）。

---

## 0. 证据来源

- Bundle：`data/tmp/duckai-scripts/entry.duckai.84906ec5fc6f39d18f17.js`（2,493,916 bytes，2026-11-03 抓取，当前部署）。
- 只读提取脚本（本任务新增，未改 src）：
  - `recon-tmp/extract-client-tools.mjs`（关键词/字符串扫描）
  - `recon-tmp/extract-client-tools2.mjs`（bridge/continuation 细节）
  - 输出：`recon-tmp/client-tools-extract.txt`、`recon-tmp/client-tools-extract2.txt`
- 偏移均为该 bundle 内字符 offset（百分比约为相对位置），仅作定位参考（压缩产物）。
- 网关现状依据：`src/duck/index.js`（`CLIENT_TOOLS_HEADER`、`_resumeContinuation`、`client-output` 处理）。

---

## 1. 实验开关 `client-tools-support` / `skills`

### 1.1 定义（bundle offset ≈ 1,977,981 / 模块 44538）

```js
const i = {
  clientToolsSupport: {
    key: "client-tools-support",
    unit: "browser-profile",
    defaultValue: false,
    options: [false, true],
    pixels: {}
  },
  ...
  skills: {
    key: "skills",
    unit: "browser-profile",
    defaultValue: false,
    options: [false, true],
    pixels: {}
  }
};
```

- 两个都是 **browser-profile experiments**，默认 **false**；`options` 只有布尔两档，没有灰度多档。
- 命中方式（bundle offset ≈ 1,443,961 / 1,446,560）：启动时 `GET /duckchat/v1/capabilities`
  （`cache:"no-store"`, `credentials:"include"`, 3s header/body timeout）→ 响应 `flags` 对象；
  每个 flag 值必须是 `{value, version, expiresAt}` 且未过期，按 `key` 匹配到 `g.Mv.*` 定义；
  `experimentEnrollments` 必须对应已存在的 flag（browser-profile 无需 assignmentId；subscriber 单位需要）；
  失败/超时/校验失败回退内置默认 `GF = {accessLevel:"public", flags:{}, experimentEnrollments:[], experimentStateResets:[]}`。
- 前端读取：`(0,E._P)(g.Mv.clientToolsSupport)` / `(0,E._P)(g.Mv.skills)`（bundle offset ≈ 1,776,157），
  `getVariant(definition)` 没有命中时返回 `definition.defaultValue`（即 false）。
- 另一个相关默认：`frameworkBrowserProfileAA` 等默认 "a"；与 client tools 无关。

**结论**：默认关闭；只有 DuckDuckGo 的 browser-profile 实验命中且值为 true 时才启用；
普通 Chrome 上通常拿不到这两个 true（除非账户/浏览器 profile 被实验命中）。

---

## 2. `x-duckai-client-tools` 请求头协议

### 2.1 发送位置与形状（bundle offset ≈ 1,999,278 / 80.17%）

```js
const headers = {
  "Content-Type": "application/json",
  "x-duckai-continuation": "resubmit-context",
  "x-duckai-consent-purposes": "user-location,image-generation,web-search",
  "x-duckai-tool-approval": "web-search",
  "x-duckai-response-id": responseId,
  ...(capabilities.length ? {
    "x-duckai-client-tools": JSON.stringify({ version: 1, capabilities })
  } : {}),
  ...
};
```

- **只有 `capabilities.length > 0` 才发该头**；空列表时完全省略。
- 形状固定：`{ "version": 1, "capabilities": [{ "name": string, "version": number }] }`。
- 网关当前（`src/duck/index.js:33`）发送的是 `{"version":1,"capabilities":[]}`（空数组也发），
  与浏览器行为有差异；是否影响上游未验证（见 §6 建议）。

### 2.2 capabilities 从哪里来（bundle offset ≈ 1,777,356 / 71.27%）

```js
// bridge 为 DuckDuckGo 原生 aiChat bridge（见 2.3）
let o = await R.hO(bridge, options);          // 拿 bridge 的 clientTools 列表
// 协议校验：
if (!sizeOk(o, 4096) || !isObj(o) || !keysOk(o, ["protocolVersion","capabilities"]) ||
    1 !== o.protocolVersion || !Array.isArray(o.capabilities) || o.capabilities.length > 32) return [];
// 每个 capability：{name, version}，name /^[A-Za-z0-9_.:-]{1,128}$/ 且 ≤64 字符，
// version 必须 safe integer ≥1，name 唯一
...
return capabilities
  .filter(({ name, version }) =>
    name === "loadUserSkill"
      ? skillsEnabled && version === 1
      : legacyEnabled            // client-tools-support
  );
```

- bridge 返回协议：`{protocolVersion:1, capabilities:[{name,version},...]}`（≤32 个，名字唯一）。
- **本地白名单/过滤**：
  - `loadUserSkill`：仅当 `skills` 实验 true，且 version === 1；
  - 其他 capability：仅当 `client-tools-support` 实验 true（legacy 模式）。
- 因而 capability 名字/版本**不是任意自建就生效**：页面只会把上述过滤后的列表塞进请求头。

### 2.3 bridge 是什么（bundle offset ≈ 2,167,272 / 模块 33500）

```js
const bridge = (0, _ .W7)();   // React context，默认值来自 module 33500 的 QG
// module 33500: v() { const e = (0, a.CZ)("aiChat"); ... }   // native bridge
// bridge.request("getAIChatNativeConfigValues") / ("getAIChatNativePrompt") / ("userSkills/list") ...
```

- `getNativeBridge("aiChat")` 来自 **DuckDuckGo 原生 app/browser 的 native message bridge**（`getAIChatNativeConfigValues`、
  `getAIChatNativePrompt`、`submitAIChatPageContext`、`userSkills/list` 等）。
- 普通网页 Chrome 没有该 bridge → `W7()` 为空 → capabilities `[]` → 不发头。
- 该 bridge 支持事件订阅：`clientToolPermissionRequested`、执行请求 `executeClientTool`、
  权限响应 `respondToClientToolPermission`（见 §3）。
- **不是** window 上可任意伪造的公开对象（上下文由宿主注入）；网关侧无法伪造 bridge，只能自行构造请求头。

---

## 3. `kind:"client-output"` continuation 完整契约

### 3.1 服务端 continuation 事件与 pendingActions（bundle offset ≈ 2,099,422 / 84.18%）

SSE 末帧可能是：

```jsonc
{
  "role": "continuation",
  "action": "success",
  "token": "<opaque>",
  "pendingActions": [ /* ≤128 个 */ ],
  "replayPolicy": "continuation-only" | "existing-consent-fallback"  // 可选
}
```

校验函数（前端）要求：

- `role === "continuation"`、`action === "success"`；
- `token` 为非空字符串（≤1,572,864）；
- `pendingActions` 数组，长度 1..128；
- 每个 action 必须是对象，`toolCallId` / `toolName` 都是非空字符串（≤256），`toolCallId` 唯一；
- `kind === "approval"`：`approvalId` 字符串（≤256），可选 `purpose`（枚举
  `user-location` / `image-generation` / `web-search`）、可选 `imageModelDisplayName`；
- `kind === "client-output"`：`contract` 字符串（≤256）；`input` 必须存在且 `JSON.stringify(input)` ≤262,144 bytes；
  可选 `metadata.clientCapability = {name: string≤64, version: safe integer>0}`；
- 含 `client-output` 的 continuation **不能**是 `replayPolicy:"continuation-only"`（否则直接无效）。

### 3.2 客户端回传的 responses（bundle offset ≈ 2,110,554 / 84.63%）

对每个 pendingAction **按顺序**回一条：

```jsonc
// approval
{ "kind": "approval", "approvalId": "...", "approved": true }

// client-output
{ "kind": "client-output", "toolCallId": "...", "output": <any JSON> }
```

- `pendingActions.length` 必须等于 `responses.length`；approval 用 `approvalId` 匹配、
  client-output 用 `toolCallId` 匹配；`output` 必须已定义。
- 其它字段来自原 continuation token/responseId/currentAssistant（网关现有 `_resumeContinuation` 已实现）。
- `contract` 用于客户端选择执行器；服务端只回传，不校验其值（客户端按 contract 分派）。
- `input` 是工具调用参数；`toolName` 是上游工具名（如 `BrowserLoadUserSkill`）。

### 3.3 `BrowserLoadUserSkill.v1` 具体校验（bundle offset ≈ 1,715,364 / 68.78%，1,779,648 / 71.36%）

前端调用 bridge 执行时构造：

```js
const result = await bridge.execute({
  kind: "client-output",
  contract: "BrowserLoadUserSkill.v1",
  toolCallId: crypto.randomUUID(),
  toolName: "BrowserLoadUserSkill",
  input: { name: skillName },
  metadata: { clientCapability: { name: "loadUserSkill", version: 1 } }
}, { signal });
```

bridge 返回值与本地校验：

- 输入 `input` JSON ≤262,144 bytes；`toolCallId` 随机 UUID；
- bridge 侧权限流程：`clientToolPermissionRequested` 事件 `{requestId,callId,message,choices}`，
  `choices` 只能是 `allow` / `always` / `never`（1–3 个、不重复），`message` ≤4096，整体 ≤8192；
  响应 `respondToClientToolPermission`；执行 `executeClientTool {callId, capability, input}`。
- 执行结果：`{callId, ok:true, value}` 或 `{callId, ok:false, error:{code}}`；
  error code 枚举：`denied` / `cancelled` / `unavailable` / `not_found` / `invalid_arguments` / `execution_failed`；
  bridge 超时 150,000ms（`C=15e4`），返回值整体 JSON 默认上限 524,288 bytes。
- **loadUserSkill v1 额外校验**：
  - `input` 必须是对象且 `input.name` 为字符串：长度 ≤64，正则 `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`；
  - `value` 必须是对象，键 ⊆ `["name","content"]`，`value.name === input.name`；
  - `content` 必须是非空字符串，UTF-8 字节数 ≤ **32768**；
  - 任一不满足 → `execution_failed`。
- 技能装配（bundle offset ≈ 1,779,648）：`userSkills/list` 返回 manifest；选中的技能逐个用
  `BrowserLoadUserSkill.v1` 加载，组装为：

```jsonc
{
  "metadata": {
    "userSkills": { /* manifest */ },
    "userSkillInstructions": {
      "version": 1,
      "instructions": [ { "name": "skill-name", "content": "..." } ]
    }
  }
}
```

  - 只有声明了 `loadUserSkill` v1 capability 时才带这些 metadata；否则前端会清空
    `metadata.userSkills` / `metadata.userSkillInstructions`（bundle offset ≈ 1,997,700）。

---

## 4. 模型如何知道 client tool？自定义工具是否可行？

### 4.1 固定工具 vs client capability

- 模型可调用的工具来自 **模型定义 `supportedTools` 固定列表**（bundle 模块 28401，约 1,977,981）：
  `WebSearch`、`RelatedSearchTerms`、`LocationPrompt`、`ImageGeneration`、`GenerateImage`、
  `ReadDocument`、`ReadDocumentSelection`、`FindInDocument`；付费模型另有 `Browser*` 工具。
- `loadUserSkill` 是**单独固定能力**：前端声明 `{name:"loadUserSkill",version:1}`，
  对应上游工具 `BrowserLoadUserSkill` + 固定契约 `BrowserLoadUserSkill.v1`；
  它不是 `supportedTools` 列表里的普通工具，而是 client tools 通道里的固定能力。
- `metadata.userSkills`/`userSkillInstructions` 是**技能文本/指令**（技能名 + 内容），
  不是可执行工具 schema；模型把这些内容当作上下文/指令使用，不会因此获得新函数。

### 4.2 自建 capability 会发生什么？

- 前端本地过滤器（§2.2）：
  - `name === "loadUserSkill"` → 只允许 v1 且 skills 实验 true；
  - 其他名字 → 只有 legacy experiment（`client-tools-support`）true 才保留；
- 即使保留（legacy），模型侧也没有该名字的**工具定义/参数 schema/契约**；服务端 continuation 的
  `pendingActions` 由上游决定，前端不能注册新 schema；
- 因此 **不能**像 OpenAI `tools:[{type:function,function:{name,schema}}]` 那样让模型调用自定义函数，
  也不能把自定义 capability 当成 function calling 的替代。

### 4.3 为什么 `loadUserSkill` 是「技能文本」而非函数

- 其 output 固定为 `{name, content}`，content 是**技能文本**（≤32KB），不是任意 JSON/函数返回值；
- 前端拿到 content 后组装进 `metadata.userSkillInstructions` 供模型当指令；
- 不存在「自定义函数名 + 参数 schema + 结构化返回值」的机制。

---

## 5. 网关能否实现？

### 5.1 结论表

| 方案 | 可行性 | 证据 | 说明 |
| --- | --- | --- | --- |
| 真正自定义 client tools（OpenAI function calling 式） | ❌ **不可行** | 固定 `supportedTools` + 固定 `loadUserSkill` 契约；capability 仅执行器声明；无动态 schema | 上游不会产生任意工具调用；不要伪造自定义 capability |
| 复用 `loadUserSkill.v1` 做「技能文本加载」 | 🟡 **理论可行、未验证** | §3.3 契约 + `metadata.userSkillInstructions`；网关可回 client-output | 需实验开关/上游接受；本质是“把技能文本喂给模型”，不是执行函数 |
| 继续现有文本注入 + MCP function calling | ✅ **可行（已实现）** | `src/openai/function-calling.js` / `src/tools/mcp-client.js` | 与上游无关，完全网关侧；推荐继续 |
| 伪造 `x-duckai-client-tools` 空/自定义能力 | ⚠️ 不建议 | 浏览器空列表时不发头；网关发空头已存在差异 | 不产生能力，可能触发异常检测，无收益 |

### 5.2 如果要做「技能文本加载」：实现步骤（仅建议，未改代码）

1. **配置**：新增 `duck.clientTools.skills.enabled`（默认 false）与本地技能库
   `{name, content}`（name 必须匹配 `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`、≤64；content ≤32KB）。
2. **请求头**：仅当启用且技能库非空时，发
   `x-duckai-client-tools: {"version":1,"capabilities":[{"name":"loadUserSkill","version":1}]}`；
   建议不要再发空 capabilities 头（与浏览器行为对齐；需评估 418 影响）。
3. **请求体 metadata**：带
   `metadata.userSkills`（manifest；schema 需按 bundle `userSkills/list` 返回值构造——本轮未完全逆向）
   和 `metadata.userSkillInstructions:{version:1,instructions:[...]}`；只在声明 capability 时带。
4. **continuation 处理**：在 `_resumeContinuation` 中不要再对 client-output 直接抛 502；
   - 对每个 `pendingActions` 的 client-output：
     - 校验 `contract === "BrowserLoadUserSkill.v1"`、`metadata.clientCapability.name === "loadUserSkill"` v1；
     - `input.name` 查本地技能库；构造 `output = {ok:true, value:{name, content}}`；
     - 技能不存在/超限 → `output = {ok:false,error:{code:"not_found"|"invalid_arguments"}}`；
   - 与 approval 一起按 **原 pendingActions 顺序**组装 `responses`；
   - 复用现有 token/responseId/currentAssistant/挑战滚动逻辑重发。
5. **安全**：技能内容是提示词注入面；只允许管理员配置；输出严格限长/名字校验；不要回传用户密钥。
6. **验证**：mock SSE continuation → 断言 responses 结构/顺序/输出；真实上游需 1–2 次小请求（间隔≥8s），
   并观察是否被实验开关/账号限制（未命中 `skills` 实验时服务端可能不下发 client-output）。
7. **工作量**：协议+续传改造约 2–4 小时，测试 1–2 小时，真实联调/风控验证 1–2 小时；
   若上游要求 `skills` 实验命中或账号资质，则该方案可能不可用（BLOCKED）。

### 5.3 不应做的

- 不要伪造 bridge、不要在普通网页环境承诺 client tools；
- 不要尝试用自定义 capability 名实现 function calling；
- 不要把 `loadUserSkill` 输出当任意结构化函数结果（契约只允许 `{name,content}`）。

---

## 6. 风险与未验证项

1. **实验开关**：`client-tools-support` 与 `skills` 默认 false；真实账号是否命中未知；未命中时
   服务端可能根本不下发 `client-output`（本任务未做真实上游验证，避免消耗额度）。
2. **上游校验**：客户端本地过滤/校验不等于服务端必然接受；服务端可能对 capability 列表、contract、
   output 再做校验（bundle 中未见服务端逻辑）。
3. **网关当前行为**：`src/duck/index.js::_resumeContinuation` 对 `client-output` 直接抛
   `DuckError{status:502, code:'upstream_client_tool_unsupported'}`；这是「不支持」而非「尝试后失败」。
4. **空 capabilities 头差异**：网关目前始终发 `{"version":1,"capabilities":[]}`，浏览器只在非空时发；
   两者是否影响 418/429 未验证（不属本任务结论）。
5. **技能 manifest schema**：`userSkills/list` 返回的 manifest 结构未完全逆向（`N.n7` 处理函数），
   若实现技能加载需进一步分析或实测。

---

## 7. 最终结论（给 Lead）

- **duck.ai 的 experimental client tools 不是通用 function calling**：它只允许固定的
  `loadUserSkill`（技能文本）和浏览器 legacy 工具，由宿主 DuckDuckGo 浏览器 bridge 执行；
  模型工具清单仍是硬编码的 `supportedTools`。
- **网关无法实现自定义工具执行**（除非上游新增动态工具协议）；当前对 `client-output` 返回
  502 `upstream_client_tool_unsupported` 是诚实且安全的行为。
- 若产品只想要「自定义技能/指令」：可尝试 `loadUserSkill.v1` 技能文本加载，
  但需要实验开关命中，且只是“加载指令”，不是函数调用；建议先做一次最小真实实验再决定是否实现。
- 若目标是 OpenAI function calling：继续使用网关现有文本注入 + MCP 方案，不依赖此实验特性。
