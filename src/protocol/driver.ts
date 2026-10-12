import type { AgentEvent, Emit } from '../lib/sse.js'
import type { Risk, ToolDefinition } from '../tools/registry.js'

/**
 * # 协议层 · AgentDriver
 *
 * **这个文件不许 import `ai` 或 `@ai-sdk/*`。** 这是唯一的硬规则，
 * 而且它必须能被机器检查 —— 见 `scripts/verify-protocol-purity.ts`。
 *
 * ## 它抽象的是什么
 *
 * **「跑一轮对话」这一件事**：给它消息与工具，它产出事件流。
 *
 * 刻意**不抽象**「发一次模型请求」—— 那样循环与审批就得留在协议层，
 * 而每家 SDK 的流形状差异（async iterator / event emitter / SSE 字符串）
 * 会从 Adapter 渗进协议层。抽象到「一轮」这一层，差异全被关在 Adapter 里。
 *
 * ## 为什么这个形状能同时容下 async iterator 与 event emitter
 *
 * 因为协议层**只认事件**。Adapter 把 SDK 那个 async iterator 摊平成
 * `Emit` 调用，协议层完全不知道下面是什么。所以换一家 SDK 时，
 * 协议层与它的测试**一行都不用改**。
 *
 * ## 协议层负责什么（不变的部分）
 *
 * - 事件形状与顺序保证（`run.started` 首、`run.completed`/`run.failed` 末）
 * - 授权判定：工具声明的 `risk` → 需要用户确认还是自动放行
 * - 步数上限
 * - 上下文重建（跨轮工具历史）
 *
 * 这些**不随 SDK 变**，所以它们的测试也不随 SDK 变。
 */

/**
 * little-one 引擎出站只说 OpenAI Chat Completions，打到本机 Magpie。
 * Chat / Responses / Messages 的互译、厂商 key、推理档位都在 Magpie。
 * `drivers.get` 对这个引擎永远拿这个值。
 */
export const LITTLE_ONE_WIRE = 'openai-chat-completions'

/** 驱动一轮对话所需的全部输入。**协议层与 Adapter 的唯一交界面。** */
export type DriverRequest = {
  runId: string
  /** Magpie 认识的模型名。协议层不解释它属于哪家厂商。 */
  modelId: string
  instructions?: string
  /**
   * 对话历史。**已经是模型无关的形状了** —— 见 `ChatMessage`。
   *
   * ⚠️ 这不是 `ai` 包的 `ModelMessage`，是我们自己的。Adapter 负责翻译。
   * 这样协议层与上下文重建逻辑都与 SDK 无关。
   */
  messages: ChatMessage[]
  tools: ToolDefinition<never>[]
  /** 步数上限。Adapter 必须遵守 —— 它是循环的终止条件。 */
  maxSteps: number
  /**
   * HMAC 密钥。设了就给审批请求签名，堵住客户端伪造。
   * 契约 §五。**Adapter 必须实现签名与校验** —— 那是它那侧的安全边界。
   */
  approvalSecret?: string
  /**
   * 取消信号。给了就必须接进 SDK 的 `abortSignal` —— **取消必须停止底层的工作**，
   * 只会话层标记取消而模型请求继续在飞，那是假取消。
   *
   * 被取消的 run **不是失败**：`DriverResult.status` 必须是 `'cancelled'`，
   * 不许发 `run.failed`（契约 §三「取消一轮」）。
   */
  signal?: AbortSignal
  /**
   * 双审批开关（契约 §五，2026-10-09）。生产路径**始终显式传递**；
   * 字段真的缺失（老调用方）时保守按 true 处理 = 需要审批。
   *
   * - `businessApproval`：raven 业务工具。false = 自动通过，但事件对照发
   *   （`approval.resolved` 带 `auto: true`）—— 审批卡片的逻辑只有一套，
   *   审计线索（events 表）完整。
   * - `sandboxApproval`：沙箱内工具（引擎原生能力）。对本协议的 Driver
   *   （工具全是业务工具）是 no-op；claude 引擎消费它。
   */
  businessApproval?: boolean
  sandboxApproval?: boolean
  /**
   * claude 引擎的会话锚（claude 侧 session id）。第一轮没有；之后每轮传回，
   * claude 侧凭它 resume 自己的历史。其他 Driver 忽略。
   */
  engineSessionId?: string
  /**
   * claude 引擎的业务工具来源（2026-10-09 加法）。设了 = 业务工具走 raven 的
   * MCP HTTP 端点（执行离开本进程）；不设 = 进程内包装（现状，token 半径最小）。
   * 两种模式的审批桥一致：工具都带 mcp 前缀，businessApproval 照常判。
   * 其他 Driver 忽略。
   */
  businessToolMcpUrl?: string
  /**
   * 上一轮审批的结论（结构化，契约 §五）。little-one 引擎把它喂进上下文重建；
   * claude 引擎用它消费 canUseTool 里签名匹配的授权。两引擎同语义。
   */
  approvalResponses?: { approvalId: string; approved: boolean; reason?: string }[]
  /** 测试用：跳过审批。生产路径不要用。 */
  skipApproval?: boolean
}

/**
 * **我们自己的消息形状**，不是任何 SDK 的。
 *
 * 跨轮工具历史已经在这里被整理好（含并行调用的顺序），
 * 所以 Adapter 只需要做一次形状翻译，不用懂顺序是怎么定的。
 */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      /**
       * 正文。**可空** —— 只调了工具没说话的那一轮就没有。
       * ⚠️ 早期版本把它写成必填，结果「先调工具再说话」这种最常见的
       * 轮次建不出来，只能在协议层塞空串，而空串会被一些 provider 拒。
       */
      content?: string
      /** 工具调用。**顺序即并行调用的原始顺序**（按 seq 排好）。 */
      toolCalls?: { toolCallId: string; tool: string; input: unknown }[]
    }
  | {
      role: 'tool'
      /** 与上面 assistant 的 toolCalls **一一对应且同序**。 */
      results: { toolCallId: string; tool: string; output: string }[]
    }

/**
 * 一轮对话的结果。
 *
 * ⚠️ `status` 是契约的一部分（`done` / `stopped` / `denied` / `cancelled`），
 * Adapter **不许自己发明**别的值 —— 前端按它分支。
 * `cancelled` 只能由 `request.signal` 触发，不许挪作他用。
 */
export type DriverResult = {
  status: 'done' | 'stopped' | 'denied' | 'cancelled'
  steps: number
  /**
   * **归一化过的用量**（2026-10-09，契约 §六 预算）。协议层只认
   * `{ inputTokens, outputTokens }` 这个形状 —— 各 SDK 的原始 usage
   * 字段名不同，翻译是 Adapter 的职责。拿不到就是 0，不许编。
   */
  usage: { inputTokens: number; outputTokens: number }
  /** 助手正文。空字符串是合法的（模型可能只调了工具没说话）。 */
  text: string
  /** claude 引擎的会话锚（本轮产生/延续的 claude session id）。其他 Driver 不发。 */
  engineSessionId?: string
}

/**
 * 工具执行的可观测回调。**落库由协议层做，Adapter 只报告。**
 *
 * 这是职责边界的关键：Adapter 不该知道数据库存在，
 * 否则每加一家 SDK 就要在 Adapter 里重写一遍落库逻辑。
 */
export type DriverHooks = {
  /**
   * 工具**被请求**时（执行之前）。
   *
   * ⚠️ `seq` 是**请求顺序**，不是完成顺序 —— SDK 并行执行，
   * 顺序不保证。协议层靠它保序，所以 Adapter 必须在调用工具**之前**分配。
   */
  onToolCall: (event: { callId: string; tool: string; input: unknown; seq: number }) => void
  onToolResult: (event: {
    callId: string
    tool: string
    ok: boolean
    output: unknown
    durationMs: number
  }) => void
  /** 用户拒绝了某个授权。 */
  onApprovalDenied: (event: { callId: string; tool: string }) => void
}

/**
 * ## 一个 Driver 的完整职责
 *
 * 1. 用 `modelId` 向唯一上游发这一轮（地址与 key 不在这份请求里）
 * 2. 把 `ChatMessage[]` 翻译成 SDK 的消息格式
 * 3. 把 `tools` 翻译成 SDK 的工具定义
 * 4. **把工具声明的 `risk` 翻译成 SDK 的审批机制**
 * 5. 跑循环，直到模型收尾 / 达到 `maxSteps` / 工具被拒
 * 6. 把 SDK 的流翻译成协议层事件（`Emit`），保证形状与顺序
 * 7. 调 `hooks` 报告工具调用，供协议层落库
 *
 * **不许做**：改事件形状、自己发明 status、决定工具是否需要授权（那是 `risk` 决定的）。
 */
export interface AgentDriver {
  /** 这条 Driver 接的线。little-one 引擎是 `LITTLE_ONE_WIRE`，claude 引擎是 `claude`。 */
  readonly handles: string

  /** 一轮对话。实现**必须**在 `emit` 里发终止事件（`run.completed` 或 `run.failed`）。 */
  run(request: DriverRequest, hooks: DriverHooks, emit: Emit): Promise<DriverResult>
}

/**
 * 按出站协议挑 Driver。
 *
 * 挑不中时抛错，不返回 null。返回 null 会让调用点写 `if (!driver)`，
 * 那种分支的典型处理是静默降级，症状变成「工具都不工作了」。
 */
export type DriverRegistry = {
  get(wire: string): AgentDriver
  list(): string[]
}

export type { AgentEvent, Emit, Risk, ToolDefinition }