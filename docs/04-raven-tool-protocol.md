# 04 · Raven Tool Protocol v1

**状态** v1 ｜ **两侧实现**
Runtime `src/protocol/raven-tool-protocol.ts` · Raven `backstage/lib/tool-protocol.ts`

Runtime 与 raven 之间**唯一**的接缝。三个操作，五种语义。

---

## §一 这条边界为什么存在

| | Runtime（little-one） | Raven |
|---|---|---|
| 回答 | 模型下一步做什么 | 怎么安全、可靠地做 |
| 拥有 | 面向模型的 Tool Registry | 实际的 Tool Executor Registry |
| 知道 | 跑到第几轮、上下文还剩多少 | 路径在哪、配额还剩多少、谁是调用方 |

**归属判据**：完全移除 LLM 之后仍有独立意义的能力 → 属于 raven。
一个 `rg`、一个读文件、一个 Sandbox，不走模型也照样有人要。

两边不共享内部实现，只过这份协议。

---

## §二 三个操作

```ts
interface RavenClient {
  listTools(workspaceId?): Promise<ListToolsData>
  executeTool(request: {
    workspaceId?; toolName; arguments; executionId?; timeoutMs?
  }): Promise<ToolResult>
  cancelExecution(executionId): Promise<CancelExecutionData>
}
```

这是**逻辑接口**。传输层是 raven 的 `POST /api/agent/gateway`，
请求体带 `op` 分发（`v` + `op`），不是三个 URL —— 单一入口意味着单一鉴权点。

### `listTools` —— 发现

返回 `protocolVersion` / `workspaceId` / `tools[]` / `disabled[]`。

Runtime 拿到的 `inputSchema` 是 **JSON Schema**（跨进程只有 JSON 能过线），
自己转成模型要的格式。**raven 加一个工具，runtime 不改代码就能用** ——
这是这份协议存在的全部理由；如果 runtime 里还硬编码一份工具表，那协议就是装饰。

`disabled[]` 明说哪些工具存在但未开放，省掉一轮「为什么我调不了」的排查。

### `executeTool` —— 调用

同步等到终态。返回 `ToolResult`：`executionId` / `status` / `output` / `error` /
`startedAt` / `endedAt` / `durationMs`。

| 规则 | 为什么 |
|---|---|
| **每次执行都有 `executionId`** | 没有 ID 的执行无法取消。取消接口拿什么指认它？ |
| 调用方给 `executionId` = 幂等重试 | 网络超时后重发同一个 ID，raven 认它是同一次 |
| `timeoutMs` 由工具自报，调用方可以调短、不能调长 | 上限 `MAX_EXECUTION_TIMEOUT_MS` 在 raven 手里 |

`status` 只有四个：`ok` / `error` / `cancelled` / `timeout`。**没有 `running`** ——
调用同步等到终态，「正在跑」是 raven 内部的事。

### `cancelExecution` —— 取消

返回 `{ executionId, status, cancelled }`。

**来晚了不是错误**：执行已经到终态时，`cancelled: false`，返回它的真实终态。
取消接口必须能安全地重复调用 —— 网络重试会让它重复，报「找不到」会误导调用方以为取消失败。

---

## §三 五种语义

发现 · 调用 · 结果 · 错误 · 取消。前三个是操作，后两个是回执：

**结果**只在 `status: 'ok'` 时出现，放在 `output`。**错误信息不放 `output`** ——
混在一起的下场是「模型读到了一段错误文本，当成正常内容继续推理」。

**错误**是 `{ code, message, retryable }`：

| code | HTTP | 重试? | 含义 |
|---|---|---|---|
| `unauthorized` | 401 | ✗ | 没带 token 或不对 |
| `protocol_mismatch` | 400 | ✗ | `v` 不支持 |
| `invalid_request` | 400 | ✗ | 请求体形状不对 |
| `unknown_tool` | 404 | ✗ | 没这个工具 |
| `tool_disabled` | 501 | ✗ | 存在但未开放 |
| `invalid_input` | 400 | ✗ | 参数不合法 |
| `not_found` | 404 | ✗ | 路径不存在 |
| `outside_root` | 403 | ✗ | 越过受管根 |
| `permission_denied` | 403 | ✗ | 身份问题，不是路径问题 |
| `workspace_unknown` | 404 | ✗ | workspace 不存在或碰不到 |
| `quota_exceeded` | 507 | ✗ | 配额满 |
| `timeout` | 504 | ✗ | 超过 `timeoutMs` |
| `cancelled` | 409 | ✗ | 被取消 |
| `execution_not_found` | 404 | ✗ | 这个 ID raven 不认识 |
| `internal_error` | 500 | ✓ | raven 自己崩了 |

**按 `code` 分支，不要匹配 `message`。** `message` 给人看，随时会改。
`invalid_input` 的 message 值得原样喂回模型 —— 那是唯一一类能靠改参数救回来的错误。

---

## §四 权限归 raven

Runtime 传来的 `workspaceId` 是**意图**，不是凭证。

- 调用方身份由 `AGENT_RUNTIME_TOKEN` 决定；
- 能不能碰这个 workspace、这个路径、这个配额，**全部由 raven 判**；
- 沙箱判定（`backstage/lib/sandbox.ts` 的 realpath 段比较）是唯一一份，
  runtime 里**不复制** —— 两套判定漂移的那一次就是越界。

当前实现**只有一个 workspace**（`DEFAULT_WORKSPACE_ID`）。所以 raven 做的是**校验**
而不是查找：传来的不是它 → `workspace_unknown`，绝不静默当成默认。
字段是为以后预留的，不是现在就支持多 workspace —— 这两句话的区别很重要。

---

## §五 版本

| 改动 | 升版本? |
|---|---|
| 加工具、加可选字段、加错误码 | ✗ |
| 改字段名 / 改语义 / 改 HTTP 状态 | ✓ |

**能力协商靠字段缺失时的默认值，不靠版本号比对。**
两侧独立部署、版本不同步，所以「缺失就用默认值」，绝不「缺失就报错」。

两份类型是**手抄的两份**，不抽共享包（现在只有两个项目，抽包会引来发布流程）。
代价是改一处必须改另一处 —— 所以用 `scripts/protocol/verify-tool-protocol.ts`
拉起一个假 raven 跑完整往返来兜。
