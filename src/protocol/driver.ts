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
 * # 协议族 · Adapter 的切分依据
 *
 * ⚠️ **Adapter 按协议切，不按厂商切** —— 但**协议是厂商的一个属性**，
 * 所以 endpoint 表里同时有两列（providerId + protocol）。
 *
 * ## 为什么不是「一家厂商一个 Adapter」
 *
 * GLM / DeepSeek / Kimi / OpenAI 官方全都是 OpenAI Chat Completions，
 * 一个 Adapter + 四行配置就够。它们真正需要适配的差别只有
 * baseURL 与扩展参数，**不是流形状**。
 *
 * ## 为什么协议不能挂在「厂商」名下
 *
 * 因为**同一家厂商的多个端点协议不同**：
 *
 * | 端点 | 协议 |
 * |---|---|
 * | `open.bigmodel.cn/api/paas/v4` | OpenAI Chat Completions |
 * | `open.bigmodel.cn/api/v1` | **OpenAI Responses** |
 * | `open.bigmodel.cn/api/anthropic` | **Anthropic Messages** |
 *
 * 所以结构是**厂商 → 端点 → 协议**（端点里的 protocol 列可以覆盖厂商默认）。
 * GLM 的 v4 端点挂 vercel-ai adapter，anthropic 端点挂 claude adapter，
 * 两个都用智谱的 key —— **key 属于厂商，adapter 属于协议。**
 */
export type ProtocolFamily =
  /** OpenAI Chat Completions（`/chat/completions`）。GLM / DeepSeek / Kimi / OpenAI。 */
  | 'openai-chat-completions'
  /** OpenAI Responses（`/responses`）。智谱 `/api/v1`、OpenAI 官方。 */
  | 'openai-responses'
  /** Anthropic Messages（`/messages`）。智谱 `/api/anthropic`、Claude。 */
  | 'anthropic-messages'
  /** 自家 SDK，不走协议。 */
  | 'sdk'

/**
 * 一个模型端点的配置。**Adapter 用它决定怎么调模型。**
 *
 * ⚠️ **2026-10-09 变化**：`apiKey` 现在存在了。此前这里刻意没有它，
 * 理由是「协议层用不到，却会被日志和错误信息带出去」。
 * 那个理由对**协议层仍然成立** —— 所以它只是「路过」，不是被解释：
 * 协议层任何代码都不读它、不写进错误信息、不打日志。
 * 之所以要搬进来，是因为 key 的来源变成了两处（库里 / 环境变量），
 * 而**优先级只能有一个地方判**。分散在 driver 里判等于没有规则。
 */
export type EndpointConfig = {
  /** 端点 id，如 `zhipu` / `deepseek`。**只是标识，不决定用哪个 Adapter。** */
  id: string
  label: string
  /** 走哪种协议。**这一列才决定 Adapter。** */
  protocol: ProtocolFamily
  /** HTTP 端点。用 SDK 协议族时可以留空（SDK 有默认值）。 */
  baseUrl?: string
  /**
   * **key 的环境变量名**，不是 key 本身。
   * 比如 `OPENAI_API_KEY`。理由见上面 `apiKey` 的注释。
   */
  keyEnvVar: string
  /**
   * **已经解析好的 key**：库里填的值优先，没有则回退到
   * `process.env[keyEnvVar]`。解析在 db 层做（只有一处判优先级）。
   *
   * undefined 表示两处都没有 —— 此时**不要自己编一句「缺少 key」**，
   * 把 undefined 交给 SDK，它报的错误会指出这个厂商没配。
   */
  apiKey?: string
  /**
   * 该协议下的厂商扩展参数。**key 是 OpenAI 的参数名空间**
   * （用 `@ai-sdk/openai` 时它读的就是 `providerOptions.openai`）。
   *
   * 例：GLM 要 `{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }`。
   * 放这里而不是散在代码里，是因为**它随厂商变、不随协议变** ——
   * GLM 与 DeepSeek 都是 OpenAI Chat Completions，但只有前者要 thinking。
   */
  extraBody?: Record<string, unknown>
}

/** 模型清单里的一项。 */
export type ModelConfig = {
  id: string
  label: string
  /** 属于哪个端点。 */
  endpointId: string
  /** 默认档位。GLM 的 `reasoning_effort` 默认是 `max`（最贵），所以要显式记。 */
  reasoningEffort?: 'low' | 'high' | 'max'
}

/** 驱动一轮对话所需的全部输入。**协议层与 Adapter 的唯一交界面。** */
export type DriverRequest = {
  runId: string
  endpoint: EndpointConfig
  model: ModelConfig
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
 * ⚠️ `status` 是契约的一部分（`done` / `stopped` / `denied`），
 * Adapter **不许自己发明**别的值 —— 前端按它分支。
 */
export type DriverResult = {
  status: 'done' | 'stopped' | 'denied'
  steps: number
  usage: unknown
  /** 助手正文。空字符串是合法的（模型可能只调了工具没说话）。 */
  text: string
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
 * 1. 按 `endpoint` 决定用哪个 SDK / 哪个原生 HTTP
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
  /** 端点 id。Driver 自己声明能接哪些 —— 协议层按它挑 Driver。 */
  readonly handles: string

  /** 一轮对话。实现**必须**在 `emit` 里发终止事件（`run.completed` 或 `run.failed`）。 */
  run(request: DriverRequest, hooks: DriverHooks, emit: Emit): Promise<DriverResult>
}

/**
 * 按端点挑 Driver。
 *
 * ⚠️ **挑不中时抛错，不返回 null。** 返回 null 会让调用点写
 * `if (!driver)` 分支，而那种分支的典型处理是「静默降级」——
 * 于是配置写错端点 id 的症状变成「工具都不工作了」，很难查。
 */
export type DriverRegistry = {
  get(endpointId: string): AgentDriver
  list(): string[]
}

export type { AgentEvent, Emit, Risk, ToolDefinition }