# 01 · 契约（v1冻结）

**冻结日期** 2026-10-08 ｜ **状态** v1 冻结

这份文件是 little-one（Agent Runtime）对外的**唯一契约**。实现可以换、SDK 可以换、
工具可以增删——但这里写的事件名、data 形状、状态码语义**不能改**，
因为 raven 的前端已经按它写了。

⚠️ 契约约束的是**编排侧**的语义，不含执行侧：工具在哪执行、权限怎么判、沙箱怎么隔离
都是 raven 的事，它不在本文档里出现。

不属于契约的东西一律不写在这里：模型名、提示词措辞、工具实现、数据库表结构。

---

## §一 什么算契约

| 层 | 契约? | 说明 |
|---|---|---|
| HTTP 路由与状态码 | ✅ 冻结 | raven 的 BFF 代理按它写 |
| SSE 事件名 | ✅ 冻结 | 同上 |
| SSE `data` 的字段 | ✅ 冻结 | 同上。**加字段可以，改名不行** |
| 工具的 `name` | ✅ 冻结 | 模型和 raven 都按名字识别 |
| 工具的 `inputSchema` | ✅ 冻结 | 改它等于改模型的行为 |
| 错误 `code` | ✅ 冻结 | raven 按 code 决定文案与是否重试 |
| 工具实现、提示词、模型选择 | ❌ 不是 | 可以随时换 |
| 数据库表结构 | ❌ 不是（对外） | 但受下面的**持久化演进政策**约束 |

**加字段永远可以，改名需要走契约版本号。** raven 与 agent 各自独立部署、版本不同步，
所以两边都必须容忍对方多出未知事件与未知字段——**未知事件丢弃，未知字段忽略，不报错。**

### 持久化演进政策（2026-10-09）

数据库表结构不是对外契约，但 §六 承诺「进程重启后还能读到历史并继续对话」，而 raven
与 little-one 是**独立升级**的 —— 这一刻起，磁盘上的形状就是 little-one 对「未来版本的
自己」的契约，只是它没有一个名字。三条规矩把它显式化：

1. **老库必须永远能被新代码打开。** 打不开 = 生产事故，不是迁移失败。
2. **只增不删。** 加表、加列直接做（`MIGRATABLE_COLUMNS` 会自动 `ADD COLUMN`）；
   改列名、改类型、删列必须升 `SCHEMA_VERSION`（`src/db/schema.ts`）并写迁移步骤。
3. `_meta` 表的 `schemaVersion` 记录「这行数据是哪个结构写出来的」，让下一次改结构的
   人有地方下钉子，而不是靠 git log 考古。

---

## §二 鉴权

所有接口（`/healthz` 除外）都要：

```
Authorization: Bearer <AGENT_RUNTIME_TOKEN>
```

- 缺失或不匹配 → **401**，body `{"code":"unauthorized","error":"..."}`。
- Token 只存在于 agent 服务端与 raven 的服务端配置里，**永远不下发到浏览器**。
- raven 的 `/api/agent/*` 是 BFF：它校验自己的登录态，再带 token 转发。前端从不接触 token。
- 一用户一实例，所以**没有多租户、没有用户 ID、没有配额区分**。

`/healthz` 不要鉴权：infra 的 deploy 与 navi 的同一套健康检查要在无凭据环境下工作。
它**不返回任何路径与密钥**，只返回 `ok / version / counts`。

---

## §三 Runtime API

### 会话

```
POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
```

`POST /api/sessions` 请求体（全部可选，都有默认值）：

```json
{
  "title": "整理今天的剪贴板",
  "tools": ["clipboard.list", "clipboard.create"],
  "instructions": "可选的额外系统指令",
  "engine": "little-one",
  "endpointId": "zhipu",
  "modelId": "glm-5.3",
  "sandboxApproval": false,
  "businessApproval": true
}
```

- `tools` 省略 = 用配置里的默认工具集。**对 claude 引擎，这个字段 = 挂载的
  MCP 业务工具白名单** —— 引擎原生工具（Bash/Edit/Read）不进这个字段，
  它们是引擎能力，不是会话挑选的工具（2026-10-09 裁定）。
- 未知工具名 → **400** `{"code":"unknown_tool","error":"clipboard.nope"}`。不静默丢弃。
- **`engine`**（2026-10-09 加法）：`little-one`（默认，自研跨厂商 loop）|
  `claude`（委托沙箱里的 claude-cli 做脱手长程任务）。未知值 → 400 `invalid_engine`。
  claude 引擎还没接线时**建会话可以成功**，发消息时才拿 409 `engine_not_available`
  （那时才需要沙箱就绪）。
- **`endpointId` / `modelId`**（加法）：会话固定的端点与模型。不存在 → 400 `invalid_config`。
  **claude 引擎强烈建议固定**：它 spawn 时从这两条 + 厂商 key 组出
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，取默认会拿到错协议的模型。
- **`sandboxApproval` / `businessApproval`**（加法，默认 false / true）：双审批开关，见 §五。

响应 **201**（引擎与开关回显）：

```json
{ "sessionId": "ses_01H...", "title": "...", "createdAt": 1757317217000, "tools": ["..."],
  "engine": "little-one", "sandboxApproval": false, "businessApproval": true }
```

`GET /api/sessions` → `{ sessions: [{ sessionId, title, createdAt, updatedAt, runCount, messageCount,
engine, runningRunId }] }`（`engine` / `runningRunId` 为 2026-10-09 加法）

`DELETE` → **200** `{ "deleted": true, "sessionId": "...", "messages": 12, "runs": 5 }`
带计数是给 UI 用的回执（ raven 的删除纪律：**别让一次误点变成没有回执的抹除**）。

### 发消息（唯一的流式接口）

```
POST /api/sessions/:sessionId/messages
Content-Type: application/json
```

请求体：

```json
{
  "content": "把今天的剪贴板按主题分组",
  "approvalResponses": [
    { "approvalId": "apr_...", "approved": true, "reason": "user" }
  ]
}
```

`approvalResponses` 只在**恢复一个卡在审批上的 run** 时传，见§五。

**成功 → 200，`Content-Type: text/event-stream`。**
**失败 → 400/401/404/409，且是 JSON 不是 SSE**（此时流还没开始，状态码还能改）。

| 情况 | 状态码 | code |
|---|---|---|
| 会话不存在 | 404 | `session_not_found` |
| 上一轮还在跑 | 409 | `run_in_progress` |
| `content` 为空 | 400 | `empty_content` |
| token 预算已用尽（2026-10-09 加法） | 409 | `budget_exhausted` |
| 引擎未接线（claude 沙箱未就绪，2026-10-09 加法） | 409 | `engine_not_available` |

会话详情（`GET /api/sessions/:sessionId`）响应新增（2026-10-09 加法）：
`engine`、`sandboxApproval`、`businessApproval`、**`runningRunId`**
（在途 run 的 id，null = 空闲。**断线重连的页面轮询它**：非 null 显示「进行中」，
变 null 后刷新 messages；事件回放走下面的 `GET …/runs/:runId/stream`）。

### 断线重连（2026-10-09 加法）

```
GET /api/sessions/:sessionId/runs/:runId/stream?after=<seq>
```

事件流从此是**事实源**：每个事件落库，SSE 帧带 `id: <seq>` 行。重连语义：

- `after` 之后的已存事件**按 seq 原样回放**（含 `run.started` 与终止事件）；
- run 还在跑 → 回放完自动**续流**，直到终止事件；
- run 已结束 → 只回放（终止事件在回放里，客户端照常收尾）；
- run 死于半途（interrupted）→ 回放里**没有**终止事件、流关闭 —— 按契约 §四
  的兜底语义显示「异常中断」，权威信号看会话详情的 `runningRunId`。

**所有 agent（两种引擎）统一这条语义：客户端断开不中断工作**，
跑完落库，UI 明示「关了页面它还在跑，回来看结果」。

**帧格式加法**：SSE 帧现在带 `id: <seq>` 元数据行。手写解析器只认
`event:`/`data:` 前缀不受影响；规范解析器把它记进 lastEventId。keepalive
仍是注释行。`?after` 缺省 = 0（全量回放）。

### 取消一轮（2026-10-09 加法）

```
POST /api/sessions/:sessionId/runs/:runId/cancel
```

- **200** `{ "cancelling": true, "runId": "...", "sessionId": "..." }` —— 信号已递到。
  ⚠️ **200 不是「已停」的回执**，只是「已开始取消」。真正的结论是流上的终止事件
  （`run.completed`，`status: "cancelled"`）与库里的 runs 行。
- **404** `run_not_found`：这个会话下没有这轮 run。**runId 必须归属该会话** ——
  拿别的会话的 runId 来取消，按 404 处理，否则 404 的语义就不可信了。
- **409** `run_not_running`：run 存在但已经结束 / 已被标记 interrupted。
  没有可以中断的东西是「请求与状态冲突」（409），不是服务坏了（500）——
  前端拿到 409 该刷新那一轮的状态，而不是重试。

设计上只有一条硬要求：**取消必须停止底层的工作。** 信号会一路穿透到模型请求与
在飞的工具调用。只改状态不让工作停下来，那是假取消 —— run 照样烧完剩下的步数。

取消后的收尾走**正常的终止保证**：`run.completed`（`status: "cancelled"`），
不是 `run.failed`。`cancelled` 是用户的决定，`failed` 是系统的故障，两者混在一起
「收到终止事件就关指示器」的逻辑就得分家。

### 工具清单

```
GET /api/tools
```

**这个接口是给 raven 渲染审批卡片用的**，所以它必须返回足够画卡片的字段：

```json
{
  "tools": [
    {
      "name": "clipboard.create",
      "title": "写入剪切板",
      "description": "往 raven 的网络剪切板写一条记录。",
      "inputSchema": { "type": "object", "properties": {} },
      "risk": "write",
      "confirmationPhrase": null
    }
  ]
}
```

`risk` 是**给 UI 的分级提示**，不是授权依据——授权由 agent 服务端自己判。

| risk | 含义 | 典型工具 |
|---|---|---|
| `read` | 只读，不会改任何状态 | list / get / search |
| `write` | 会改状态，但可逆或影响有限 | clipboard.create / todo.update |
| `destructive` | 删除、覆盖、不可逆 | files.delete / clipboard.clear |

`confirmationPhrase` 非null 时，UI 应要求用户原样输入它才能批准（对齐 raven 治理动作的做法）。
**UI 收不收这个词只是体验，agent 服务端不依赖它。**

### 枚举接口

```
GET /api/healthz        → 见 §二
GET /api/models         → { models: [{ id, label, provider }] }
GET /api/config         → 见下面「配置目录」
```

`/api/models` 让 raven 能在会话创建时选模型，而不用把模型列表硬编码在前端。

### 配置目录（2026-10-09 新增）

服务 raven 的「模型与厂商」管理界面。**加路由不算契约变更**（§八：加东西永远可以）。

```
GET    /api/config                          → 一次返回三段 + 当前默认模型
PUT    /api/config/providers/:id           → 增改厂商（apiKey 可选，不传 = 不改）
PUT    /api/config/endpoints/:id           → 增改端点
PUT    /api/config/models                  → 增改模型（body 里带 endpointId）
DELETE /api/config/providers/:id[?cascade=1]
DELETE /api/config/endpoints/:id[?cascade=1]
DELETE /api/config/models/:endpointId/:id
```

**一条不能破的：明文 key 永不出现在任何响应里。** 出口只有 `providers[].apiKeySet` /
`apiKeySource` / `apiKeyHint`（末四位掩码）三个字段，连 `apiKey` 这个键都不存在。
这不是「记得脱敏」，是做成了类型——想泄漏都泄漏不出去。

⚠️ **key 的来源只有数据库**（2026-10-09 裁定）。厂商视图里**没有** `keyEnvVar`，
`apiKeySource` 只有 `db` 与 `none` 两个值 —— 环境变量不再参与。

这条裁定的原因是「两份真相」的代价：`apiKeySource` 原本要区分 `db` 与 `env`，
而区分出来之后用户还是得猜哪份生效。唯一来源让这个问题消失。

改 key 只有一个地方：这里。

| 情况 | 状态码 | code |
|---|---|---|
| 厂商/端点下还有下级，且没给 `cascade` | 409 | `cascade_required` |
| 参数不合法（协议名写错、`reasoningEffort` 不是 low/high/max） | 400 | `invalid_config` |
| id 不存在 | 404 | `*_not_found` |

⚠️ **409 与 400/404 必须分开**：409 的意思是「请求与当前状态冲突」，
前端据此弹确认框；500 的意思是「服务端坏了」，前端只会显示「稍后重试」——
而重试一万次也是同样的冲突。

⚠️ **删除一律要求显式 `cascade=1`**，回执报清连带删了几个端点与模型。
静默级联会让「我只想删这个厂商」变成「它的模型全没了」，而不可逆的动作没有回执
是最糟的组合。

---

## §四 SSE 事件契约（冻结的核心）

**这节是最不能改的部分。** raven 的前端只写一份解析逻辑。

### 事件表

| event | data | 何时发 |
|---|---|---|
| `run.started` | `{ runId, sessionId, startedAt, engine? }` | 流开始，第一个事件 |
| `message.delta` | `{ runId, text }` | 助手正文增量 |
| `tool.called` | `{ runId, callId, tool, input }` | 模型请求了一个工具，**执行之前** |
| `tool.completed` | `{ runId, callId, tool, ok, output, durationMs }` | 工具结束（`ok:false` 也发） |
| `approval.requested` | `{ runId, callId, tool, input, risk, reason, approvalId? }` | 工具需要授权，**执行之前** |
| `approval.resolved` | `{ runId, callId, approved, auto? }` | 授权有结论了（`auto` 为 2026-10-09 加法） |
| `run.completed` | `{ runId, status, steps, usage }` | 正常结束，**最后一个事件** |
| `run.failed` | `{ runId, code, error }` | 出错，**最后一个事件** |

`run.started.engine`（加法）：哪个引擎在跑（`little-one` / `claude`）。
`approval.resolved.auto`（加法）：**会话开关自动通过**时为 true ——
自动通过也发完整事件对，审计与审批卡片逻辑对两种配置只有一套（§五）。
另外 **usage 自 2026-10-09 起是归一化形状** `{ inputTokens, outputTokens }`
（token 数，按厂商/模型的分组统计见 `GET /api/usage`），不再是各 SDK 的原始形状。

所有 `data` 都额外带 `runId`—— raven 可能同时开多个流，不带就得靠闭包猜。

### 三条硬规则

1. **失败之后状态码改不了。** `run.failed` 发生时响应头早已发出，所以**HTTP 仍是 200**。
   raven 必须先看事件再判成败，**不能只看 `response.ok`**。
   （只有流还没开始前的错误才是真状态码，见 §三。）
2. **`data` 里不能有裸换行。** 一律先 `JSON.stringify`。
3. **keepalive 必须是注释行** `: xxx`。写 `event: ping` 会唤醒前端的事件回调。

### ⚠️ 工具调用是**并行**的

模型在一个 step 里可以同时请求多个工具，SDK（`ai@7`）默认用 `Promise.all` 并发执行。
所以：

| 结论 | 说明 |
|---|---|
| `callId` 是唯一的关联依据 | **不能按数组下标或到达顺序配对 `tool.called` 与 `tool.completed`** |
| 同一步的多个 `tool.completed` 顺序**不保证** | 快的先返回。前端**按 `callId` 索引**，不要 push 到一个有序列表里靠位置配对 |
| 一个 `tool.failed` 不影响同批的其他工具 | 各自独立 |
| `message.delta` 可能插在 `tool.completed` 之间 | 流式正文与工具执行并发，不要假设「工具都在正文之前」 |

**唯一的全局顺序保证**：`run.started` 是第一个，`run.completed` / `run.failed` 是最后一个。

⚠️ 前端要能画「3 个工具同时在跑」—— 一个 `running` 列表，不是单条的 loading。

### 终止保证

- `run.completed` 与 `run.failed` **互斥**，且都是最后一个事件，之后流关闭。
- **每个 run 恰好有一个终止事件。** 提前断开连接不算——那由 raven 侧处理。
- 因此前端可以无脑写：`收到终止事件 → 关闭指示器`；`流结束但没收到 → 显示「异常中断」`。

### `run.completed` 的 `status`

| status | 何时 |
|---|---|
| `done` | 模型正常收尾 |
| `stopped` | 达到步数上限（默认 20 步），主动停止 |
| `denied` | 用户拒绝了某个工具的授权，模型接受了这个结论并收尾 |
| `cancelled` | 用户通过取消接口主动停掉（2026-10-09 加值，加法不升版本） |

`stopped` **不是错误**。步数上限是保护机制，触发时应当如实告诉用户「达到步数上限」，
不要显示成「失败了」——那是误导。
`cancelled` 与 `stopped` 分列的理由同理：**stopped 是保护机制，cancelled 是用户决定**，
前端对两者的文案不应该共用一句「已停止」。

### `run.failed` 的 `code`

`run.failed` 的 data 有四个字段：`{ runId, code, error, hint?, retryable? }`
（后两个是 2026-10-09 加的，见下）。

| code | 含义 | raven 该怎么做 |
|---|---|---|
| `model_auth_failed` | key 无效或缺失 | **提示去配置 key**，不要重试 |
| `model_quota_exhausted` | 余额不足 / 欠费 / 资源包用尽 | **提示去充值**，不要重试 |
| `model_rate_limited` | 被厂商限流 | 等几十秒重试，**这是唯一该自动重试的** |
| `model_content_filtered` | 被内容过滤拦下 | 显示原文，让用户改说法 |
| `model_not_found` | 模型 id 或端点不存在 | 提示去改模型配置 |
| `model_upstream_error` | 厂商侧 5xx | 稍后重试 |
| `model_error` | 模型调用失败但认不出具体成因 | 显示 error 原文 |
| `tool_error` | 工具抛异常 | 显示 tool 名与 error |
| `invalid_tool_input` | 模型给的参数不合法 | 显示出来，这是可以改Prompt 重试的 |
| `model_not_configured` | 服务端没配模型 id | **这是运维问题不是用户问题**，提示联系维护者，不要让用户重试 |
| `aborted` | 客户端主动断开 | 静默，不弹错误 |
| `internal_error` | Runtime 自己崩了 | 提示重试 |

**`code` 是稳定标识，`error` 是不稳定文案。** raven 按 code 分支，不要匹配文案。

#### 为什么把「模型调用失败」拆成六个（2026-10-09）

以前只有 `model_error` 一个码，而它盖住的三件事**要采取的行动完全相反**：

| 厂商返回 | 真实处置 |
|---|---|
| 401 key 无效 | 去配置 key —— 重试一万次还是那把废 key |
| 429「余额不足或无可用资源包」 | 去充值 —— 等再久也没用 |
| 429「rate limit exceeded」 | **等 30 秒就好** —— 重试是有效的 |

一个码意味着 raven 只能把厂商原文显示出来，而「余额不足或无可用资源包,请充值。」
这句话里没有「现在该做什么」。同理，说成「Runtime 崩了，请重试」会让用户去重启服务，
而重启对这个错误毫无作用。

#### `hint` 与 `retryable`（加字段，不升版本）

- **`hint`**：一句话可执行提示。raven **优先显示它**，而不是 `error`
  （`error` 是厂商原文，含 request_id 等排查信息，适合折叠在详情里）。
- **`retryable`**：**别靠文案猜能不能重试**。前端若猜错，代价是一个
  永远转圈的进度条 —— 而「限流可以重试、欠费不能」只有服务端知道。
- 两者都是**可选**字段：旧版 little-one 不发它们时，raven 走原有逻辑即可。

⚠️ **`model_not_configured` 正常情况下不会出现** —— `startServer()` 在启动时就检查了
模型配置，缺 key 或缺模型 id 会直接拒绝启动（容器起不来，compose 会报）。
它存在是为了守住「配置在运行中被改掉」这条路径。

### 快终止裁定：为什么这两个 code 不做循环内自愈（2026-10-09）

`invalid_tool_input` 与 `model_content_filtered` 有一个共同点：**它们是模型自己的、
理论上可修正的错误** —— 把校验错误喂回去、让模型换个说法，循环就能自己继续。
OpenHands 就是这么做的（feed back → nudge → 继续），长程编码任务靠这个活。

**little-one 明确不这么做。这两个 code 就是要终止 run，理由写在这里防止将来被当成
缺陷改掉：**

- 这个 Runtime 的产品形态是**人在环**：更快地把控制权交还给用户，让用户看到错在哪、
  改一下说法重发，比一个自愈循环更符合使用方式。用户修正一次的成本，低于盯着一个
  「正在自己挣扎」的进度条猜它能不能出来。
- **完全脱手的长程任务不属于这里。** 那种任务的正确形态是专业工具：raven 执行侧的
  脚本、调度、带重试预算的作业。Runtime 给它递工具就够了，不该把「挣扎」做进循环里。
- 自愈不是免费的：每一次 feed-back 都是一轮真实的模型调用（钱与时间），而剪贴板级
  工具的单步成本不值得这个开销。步骤上限烧在同一个错误上重复十次，是最糟的组合。

如果将来真要做自愈，形状是加法：`tool.rejected` 之类的新事件把校验错误作为观察喂回
模型，`run.failed` 的语义不动 —— 那需要先有真实的长程用例撑着，现在没有。

---

## §五 授权流程

权限由**代码强制**，不由 Prompt 保证。这是整套设计里最硬的一条边界：
**模型说「已获授权」不算，Prompt 里写「你可以随便删」也不算。**

### 双审批开关（2026-10-09）

会话级两个**独立**开关（§三 创建时设置，缺省值加粗）：

| 开关 | 管什么 | 缺省 | 理由 |
|---|---|---|---|
| `sandboxApproval` | **沙箱内工具**（引擎原生能力：文件、终端） | **关**（自动通过） | claude 引擎的定位是脱手长程任务，沙箱隔离就是安全机制；每个 Bash 都弹审批就不是脱手了 |
| `businessApproval` | **raven 业务工具**（clipboard/todo/…，MCP 挂载） | **开**（需要审批） | 业务数据是治理核心，回执与审批不可绕 |

裁定与边界：

1. **两开关互不影响。** `sandboxApproval=false` 只放行沙箱内工具；
   业务工具的审批**无条件保留**，不随它联动。
2. **自动通过也发完整事件对**：`approval.requested` → `approval.resolved`
   （`approved: true, auto: true`）。不静默吞 —— 审批卡片的前端逻辑
   对两种配置只有一套，events 表的审计线索也完整。
3. **little-one 引擎会话里 `sandboxApproval` 是 no-op**：它的工具全是业务工具。
4. 开关在特殊时刻可手动改（机制留在会话创建参数里），但**默认值就是产品定位**：
   沙箱放行 + 业务审批，别在 UI 上诱导用户两个全关。
5. **`approvalId`（2026-10-09 加法）**：待批事件携带的签名凭证，前端原样放进
   `approvalResponses` 回传。little-one 引擎由 SDK 签发；claude 引擎由 Driver 以
   HMAC 把 approvalId 与工具名+入参绑定 —— **入参被篡改的旧 approvalId 必判否**，
   消费位置在下一轮 resume 的 canUseTool（`scripts/drivers/verify-claude.ts`
   有「篡改 → deny」的断言）。claude 引擎需要审批的操作本轮以 deny 收尾，
   模型收尾或绕行；结论下一轮消费 —— 与「决策走下一条消息」同形。

### 顺序

```
模型请求工具
    │
    ▼
ToolLoopAgent 判定 needsApproval
    │
    ├── 不需要授权 ──► tool.called ──► 执行 ──► tool.completed
    │
    └── 需要授权
          │
          ▼
      approval.requested  （带 risk与 reason）
          │
          ▼
      ⏸ 流在这里挂住，等 approvalResponses
          │
          ▼
      approval.resolved ──► approved ? 执行 :跳过并把「用户拒绝」喂回模型
```

**关键：授权请求期间 SSE 流是打开的**，不是挂起请求。
前端要在 `approval.requested` 之后显示审批 UI，等用户点了再带着
`approvalResponses` 发**新的一条消息**（`content` 传空字符串）继续这一轮——
模型看到「工具被拒绝」的返回后会自己收尾，于是产生一个 `run.completed`（`status: "denied"`）。

### 为什么是这个形状

请求挂起会让 nginx / 浏览器 / 各种超时的处理变得不可控。
「流里表达『我在等』，决策走下一条消息」是唯一在断线重连下能自愈的形状。

### 授权不可被模型伪造

审批用 **HMAC 签名**（ai@7 内置）把 `approvalId` 与工具入参绑在一起。
agent 服务端在恢复时**重新校验签名与入参**——
一个被篡改过的入参配上一个有效的旧 approvalId，必须被判否。
`ai@7` 里对应的错误类是 `InvalidToolApprovalSignatureError` / `ToolCallNotFoundForApprovalError`。

---

## §六 生命周期

```
Instance（本进程，一用户一实例）
  │
  └── Session（一次对话，持久化）
        │
        └── Run（一轮问答，持久化）
              │
              ├── Step 1 ── LLM 调用 ── 可能的多个工具调用
              ├── Step 2
              └── ...（默认上限 20 步）
```

- **Session 与 Run 都落库**，进程重启后还能读到历史并继续对话。
- **进行中的 Run 不跨重启恢复。** 启动时把 `running` 状态的 run 标记为
  `interrupted` —— 半轮对话恢复不了，硬接会产出更糟的东西。
- **`interrupted` 不是 `run.failed`**：它没有 `code`，是一段历史，不是一个错误。
  raven 显示成「这一轮中断了，可以重新问一遍」。

### 多引擎（2026-10-09）

会话有 `engine` 字段（§三）。分工是**产品裁定**，不是技术取舍：

- **little-one**（自研跨厂商 loop）：业务面的轻量调度 —— 业务工具 + 快终止 +
  人在环。轻任务、低单步成本、用户随问随改。
- **claude**（沙箱里的 claude-cli，经 Driver 委托）：脱手的长程任务 ——
  文件、代码、脚本。引擎原生工具自带入场，raven 不复刻工作区能力；
  业务读写仍经 MCP 走 raven 治理（§五）。

两种引擎共享同一份 SSE 契约、同一套审批卡片、同一个 session 账本 ——
**归一化的锚是契约，不是引擎**。claude 引擎 spawn 时用会话固定的
`endpointId`/`modelId` + 厂商 key 组出 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`，
配置目录零改动（复用现有表）。

### token 预算（2026-10-09）

- **记账单位是 token，全程不出现钱。** 定价随厂商与时间变，换算成钱是
  库外面的事 —— raven 与 little 的任何接口、字段、日志都不含金额。
- **按厂商/模型分开统计**：`GET /api/usage` 返回 totals + byModel 分组
  + 预算余量。落账在 `usageLedger`，一次 run 一行。
- **上限是实例级的一个数**（配置目录 `PUT /api/config/budget`，null = 不设防），
  检查点在 **run 启动前**：累计已超 → **409 `budget_exhausted`**（真状态码，
  与 `run_in_progress` 同理必须在开流前判）。
- **运行中逐 token 掐断做不到**（usage 在 run 收尾才给全量）——
  运行中的超支风险由工具调用次数上限（`maxSteps`，对 claude 引擎映射为
  工具调用次数）兜底，由 `stopped` 如实收尾。
- `run.completed.usage` 是归一化形状 `{ inputTokens, outputTokens }`（§四）。

### 跨版本恢复：历史与工具是两回事（2026-10-09）

会话在升级前后被继续使用时（raven 与 little-one 独立部署，这是常态而不是例外），
两条裁定，来源是 OpenHands 的恢复契约（「工具只能加不能删，因为 LLM 可能已经被
告诉过它们」）：

1. **历史无条件重放。** 已落库的工具调用与结果是**事实，不是能力** ——
   模型上一轮调过什么、拿到什么，照原样进上下文。工具的 `inputSchema` 变了、
   实现换了，都不影响旧记录的回放。
2. **注册表里已经不存在的工具，不再暴露给模型，跳过并警告，不拒跑。**
   会话创建时工具名已校验并冻结（§三 的 `unknown_tool` → 400 只发生在创建时）；
   但「会话创建之后工具被下线」如果变成拒跑，一次升级就能把所有旧会话变成
   不可用 —— 那是把内部清单的变动变成了对外可用性的破坏。
   实现位置：组装层发消息时解析 `session.tools`，缺的名字 `console.warn` 后跳过
   （`src/server.ts`）。

（对应地，`runs.parentRunId` 预留列已在库中 —— run 的血缘现在没有写入方，
先占位，见 `src/db/schema.ts` 的注释。）

### 预留（2026-10-09，均未实现，先占位防退化）

| 预留 | 位置 | 打算什么时候用 |
|---|---|---|
| `runs.parentRunId` 列 | `runs` 表 | 要做「从哪断的 / 重试链」时直接用，不用迁移 |
| `run.completed.stopDetail` 字段 | §四 事件表 | `stopped` 的如实延伸：步数是不是烧在同一个错误上 |

（~~预算守卫~~ 已于 2026-10-09 提级实现，见上面「token 预算」一节。）

---

## §七 边界（不要越）

1. **Runtime 不实现业务。** 工具是外部服务提供的，agent 只负责调。
2. **业务数据不进 Agent 的记忆。** 需要什么就调什么工具查。
   （`sop` / SOP Store 属于运行时经验，**v1 不实现**，但也不能拿它当业务数据库用。）
3. **不实现多租户。** 一用户一实例，隔离靠部署架构。
4. **不做长期记忆。** Session History 与 Context Management 属于核心；长期记忆暂缓。
5. **不给浏览器发 token。** 见 §二。

---

## §八 版本演进

契约改动分两类：

| 改动 | 需要吗| 怎么做 |
|---|---|---|
| 新增事件 | ❌ | 直接加。老前端丢弃未知事件即可 |
| 事件 `data` 新增字段 | ❌ | 直接加。老前端忽略未知字段 |
| 新增工具 | ❌ | 直接加。`GET /api/tools` 会自动出现 |
| 改事件名 / 删字段 / 改字段类型 | ✅ | 必须升 `X-Contract-Version`，两侧同步 |
| 改工具 `inputSchema`（新增必填、改名） | ✅ | 同上 |

**版本协商靠能力而不是靠版本号协商**：raven 永远应该能handle 一个更新的 agent。
所以真实请求里的字段以「缺失就用默认值」为前提设计，不做「缺失就报错」。

`/healthz` 返回 `contractVersion`，纯信息用途。

---

## §九 已知不做的事

| 不做 | 理由 |
|---|---|
| SOP Store | v1 没有可学习的东西。先有执行记录，再谈提取。 |
| 多 Agent 协作 | 单 Loop 能覆盖的用例还没测完 |
| 会话分叉 / 重放 | 单线对话够用 |
| 长期记忆 | 原讨论已裁定暂缓 |
| Session 级容器隔离 | 调用外部 LLM + 受控工具不需要隔离 |
| 流式工具执行 | 工具的输出当作一步的结果整体返回，工具内部自己流式 |