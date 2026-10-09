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
| 数据库表结构 | ❌ 不是 | 内部实现，但 `ensureSchema` 幂等是部署契约 |

**加字段永远可以，改名需要走契约版本号。** raven 与 agent 各自独立部署、版本不同步，
所以两边都必须容忍对方多出未知事件与未知字段——**未知事件丢弃，未知字段忽略，不报错。**

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
  "instructions": "可选的额外系统指令"
}
```

- `tools` 省略 = 用配置里的默认工具集。
- 未知工具名 → **400** `{"code":"unknown_tool","error":"clipboard.nope"}`。不静默丢弃。

响应 **201**：

```json
{ "sessionId": "ses_01H...", "title": "...", "createdAt": 1757317217000, "tools": ["..."] }
```

`GET /api/sessions` → `{ sessions: [{ sessionId, title, createdAt, updatedAt, runCount, messageCount }] }`

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
GET /api/healthz        → 见§二
GET /api/models         → { models: [{ id, label, provider }] }
```

`/api/models` 让 raven 能在会话创建时选模型，而不用把模型列表硬编码在前端。

---

## §四 SSE 事件契约（冻结的核心）

**这节是最不能改的部分。** raven 的前端只写一份解析逻辑。

### 事件表

| event | data | 何时发 |
|---|---|---|
| `run.started` | `{ runId, sessionId, startedAt }` | 流开始，第一个事件 |
| `message.delta` | `{ runId, text }` | 助手正文增量 |
| `tool.called` | `{ runId, callId, tool, input }` | 模型请求了一个工具，**执行之前** |
| `tool.completed` | `{ runId, callId, tool, ok, output, durationMs }` | 工具结束（`ok:false` 也发） |
| `approval.requested` | `{ runId, callId, tool, input, risk, reason }` | 工具需要授权，**执行之前** |
| `approval.resolved` | `{ runId, callId, approved }` | 授权有结论了 |
| `run.completed` | `{ runId, status, steps, usage }` | 正常结束，**最后一个事件** |
| `run.failed` | `{ runId, code, error }` | 出错，**最后一个事件** |

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

`stopped` **不是错误**。步数上限是保护机制，触发时应当如实告诉用户「达到步数上限」，
不要显示成「失败了」——那是误导。

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

---

## §五 授权流程

权限由**代码强制**，不由 Prompt 保证。这是整套设计里最硬的一条边界：
**模型说「已获授权」不算，Prompt 里写「你可以随便删」也不算。**

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