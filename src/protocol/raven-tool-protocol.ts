/**
 * Raven Tool Protocol v1 —— Runtime ↔ Raven 之间**唯一**的接缝。
 *
 * ## 这条边界为什么存在
 *
 * Runtime 回答「模型下一步做什么」，raven 回答「怎么安全地做」。两者只通过
 * 三个操作说话：**发现 / 调用 / 取消**（外加结果与错误两种回执，合起来五种语义）。
 * 协议之外的东西一律不过界 —— raven 不知道模型是谁、跑到第几轮，
 * runtime 不知道路径在哪、配额还剩多少。
 *
 * ⚠️ **这份类型是两份**：raven 侧有一份镜像（`backstage/lib/tool-protocol.ts`）。
 * 不抽共享包是刻意的 —— 现在只有两个项目，抽包会引来版本号与发布流程，
 * 而它换来的只是「不用改两遍」。**改这里必须同时改那边**，
 * `scripts/protocol/verify-tool-protocol.ts` 会拉起一个假 raven 跑完整往返。
 *
 * ## 三条不能破的
 *
 * 1. **`executionId` 是执行的主键。** 每次调用要么由调用方给（重试时给同一个，
 *    raven 认它是同一次），要么由 raven 生成。**没有 ID 的执行无法取消** ——
 *    取消接口拿什么去指认它？
 * 2. **权限校验在 raven，不在 runtime。** runtime 传来的 `workspaceId` 只是**意图**，
 *    不是凭证。raven 必须自己判「这个调用方能不能碰这个 workspace」。
 * 3. **错误靠 `code` 分支，不靠 `message`。** `message` 是给人看的，随时会改。
 */

/** 协议版本。**改任何字段名/语义都要升它**，加字段不用。 */
export const RAVEN_TOOL_PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** JSON Schema 的一个节点。只用到 draft-07 的子集，多余的字段原样透传。 */
export type JsonSchemaNode = boolean | JsonSchemaObject

export type JsonSchemaObject = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: (string | number | boolean)[]
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean
  [key: string]: unknown
}

/** 与 runtime 契约 §三 的 `risk` 同一套取值 —— 分级由工具自己声明，不由调用方推断。 */
export type ToolRisk = 'read' | 'write' | 'destructive'

/**
 * 一个可被执行的工具。
 *
 * `inputSchema` 是 **JSON Schema**（不是 zod）：协议是跨进程的，只有 JSON 能过线。
 * runtime 拿到之后自己转成模型要的格式（见 `src/tools/raven-bridge.ts`）。
 */
export type ToolDefinition = {
  /** 稳定标识。改名等于改契约。 */
  name: string
  title: string
  /** 给模型看的描述 —— 决定模型会不会用它，比 UI 文案重要得多。 */
  description: string
  inputSchema: JsonSchemaObject
  risk: ToolRisk
  /** 工具自报的预期耗时上限。raven 用它封顶，runtime 用它决定要不要等。 */
  timeoutMs?: number
  /**
   * 非 null 时 UI 应要求用户原样输入它才能批准（对齐 raven 治理动作的做法）。
   * **UI 收不收只是体验**，授权判定不看它。
   */
  confirmationPhrase?: string | null
}

/** 一次执行的终态。**只有这四个**，没有「running」—— 调用是同步等到终态的。 */
export type ExecutionStatus = 'ok' | 'error' | 'cancelled' | 'timeout'

export type ToolError = {
  code: ToolErrorCode
  message: string
  /** 重试同一个请求有没有意义。网络抖动可以，参数错了永远不行。 */
  retryable: boolean
}

export type ToolResult = {
  /** 这次执行的主键。要取消、要对日志，都靠它。 */
  executionId: string
  toolName: string
  workspaceId: string
  status: ExecutionStatus
  /** `status === 'ok'` 时的产出；否则是 null。**不要在这里放错误信息**。 */
  output: unknown
  error: ToolError | null
  startedAt: number
  endedAt: number
  durationMs: number
}

// ---------------------------------------------------------------------------
// 三个操作
// ---------------------------------------------------------------------------

export type ListToolsRequest = {
  op: 'listTools'
  /** 省略 = raven 的默认 workspace（当前实现只有一个）。 */
  workspaceId?: string
}

export type ExecuteToolRequest = {
  op: 'executeTool'
  workspaceId?: string
  toolName: string
  arguments: Record<string, unknown>
  /**
   * **调用方给 = 幂等重试。** 同一个 `executionId` 重复提交，raven 认它是同一次
   * 执行（网络超时后重试全靠这个）。不给则由 raven 生成。
   */
  executionId?: string
  /** 覆盖工具自报的 `timeoutMs`，但不能超过 raven 的硬上限。 */
  timeoutMs?: number
}

export type CancelExecutionRequest = {
  op: 'cancelExecution'
  executionId: string
}

export type ToolProtocolRequest = ListToolsRequest | ExecuteToolRequest | CancelExecutionRequest

// ---------------------------------------------------------------------------
// 回执
// ---------------------------------------------------------------------------

export type ListToolsData = {
  protocolVersion: number
  workspaceId: string
  tools: ToolDefinition[]
  /**
   * 这个 workspace 里**存在但未开放**的工具名。明说而不是让 client 以为漏了，
   * 省掉一轮「为什么我调不了」的排查。
   */
  disabled: string[]
}

export type CancelExecutionData = {
  executionId: string
  /** 取消时它处在什么状态。已经是终态的话，取消是空操作而不是错误。 */
  status: ExecutionStatus | 'running'
  /** 真的发出终止信号了吗。false = 来晚了，它已经结束了。 */
  cancelled: boolean
}

/** 所有响应都套这个信封。**`ok:false` 时 `data` 一定不存在**，别写 `data?.x`。 */
export type ToolProtocolResponse<T> =
  | { ok: true; v: number; data: T }
  | { ok: false; v: number; error: ToolError }

// ---------------------------------------------------------------------------
// 错误码
//
// ⚠️ 这张表是协议的一部分：新增可以，**改名或改 HTTP 状态要升版本号**。
// runtime 按 code 分支决定「要不要重试、要不要换个参数再问一遍」。
// ---------------------------------------------------------------------------

export const TOOL_ERROR_CODES = {
  /** 没带 token 或 token 不对。 */
  unauthorized: { http: 401, retryable: false },
  /** `v` 不是这个服务端支持的版本。 */
  protocol_mismatch: { http: 400, retryable: false },
  /** 请求体形状不对（缺 op、缺 toolName…）。 */
  invalid_request: { http: 400, retryable: false },
  /** raven 没有这个工具。 */
  unknown_tool: { http: 404, retryable: false },
  /** 工具存在但没开放（比如写操作还没过授权验证）。 */
  tool_disabled: { http: 501, retryable: false },
  /** 参数不合法。**模型给错参数时会走到这里**，值得把 message 喂回模型。 */
  invalid_input: { http: 400, retryable: false },
  /** 路径不存在。 */
  not_found: { http: 404, retryable: false },
  /** 越过受管根目录 —— 沙箱拒绝。 */
  outside_root: { http: 403, retryable: false },
  /** 没有权限（不是路径问题，是身份问题）。 */
  permission_denied: { http: 403, retryable: false },
  /** workspace 不存在，或这个调用方碰不到它。 */
  workspace_unknown: { http: 404, retryable: false },
  /** 配额满了。 */
  quota_exceeded: { http: 507, retryable: false },
  /** 执行超过 timeoutMs。 */
  timeout: { http: 504, retryable: false },
  /** 被 cancelExecution 叫停。 */
  cancelled: { http: 409, retryable: false },
  /** 这个 executionId raven 不认识（可能是重启前的，或压根没发过）。 */
  execution_not_found: { http: 404, retryable: false },
  /** raven 自己崩了。 */
  internal_error: { http: 500, retryable: true },
} as const

export type ToolErrorCode = keyof typeof TOOL_ERROR_CODES

export function toolErrorHttpStatus(code: ToolErrorCode): number {
  return TOOL_ERROR_CODES[code]?.http ?? 500
}

export function isRetryableToolError(code: ToolErrorCode): boolean {
  return TOOL_ERROR_CODES[code]?.retryable ?? false
}

/** 从任意异常里取出协议错误码。认不出来一律 `internal_error`。 */
export function toToolErrorCode(value: unknown): ToolErrorCode {
  if (typeof value === 'string' && value in TOOL_ERROR_CODES) return value as ToolErrorCode
  return 'internal_error'
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

/** 单次执行的默认超时。给得宽松些：宁可让工具自己先报错，也不要协议先切断。 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000

/** raven 侧的硬上限，调用方传更大也按这个封顶。 */
export const MAX_EXECUTION_TIMEOUT_MS = 600_000

/** executionId 前缀。与 runId / sessionId 一眼能分开。 */
export const EXECUTION_ID_PREFIX = 'exe_'
