import { createOpenAI } from '@ai-sdk/openai'
import {
  ToolLoopAgent,
  isStepCount,
  tool as aiTool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { AgentDriver, ChatMessage, DriverHooks, DriverRequest, DriverResult } from '../../protocol/driver.js'
import type { Emit } from '../../lib/sse.js'
import type { Risk } from '../../tools/registry.js'

/**
 * # Vercel AI SDK 协议族 Adapter
 *
 * **这是唯一 import `ai` / `@ai-sdk/*` 的地方之一**（另一个是 registry 本身）。
 * 协议层永远见不到它们。
 *
 * ## 覆盖哪些端点
 *
 * 全部 OpenAI Chat Completions 协议的厂商共用这一个 adapter：
 * GLM / DeepSeek / Kimi / OpenAI 官方 —— 差别只是 baseURL 与扩展参数。
 *
 * ## ⚠️ 版本锁定
 *
 * `ai@7.0.60`。**7.0.70 起工具不再被执行**（无报错，`steps` 停在 1）——
 * 详见仓库 README「已知 SDK 问题」。换大版本时这里第一个要验。
 *
 * ## 三处 SDK 的「声明与实现不一致」，全部在这里被兜住
 *
 * 1. **`toolApproval` 必须用按名字的对象**，泛函形式类型合法但运行时无效。
 * 2. **tool-call 的 `input` 必须是 JSON 字符串**（声明写 `unknown`，运行时调 `.trim()`）。
 * 3. **tool 级 `needsApproval` 已废弃**，写了被静默忽略 —— 审批配在 Agent 级。
 *
 * 4. **`system` 消息必须转成 `instructions`** —— 留在 messages 里会让
 *    `ToolLoopAgent` 抛 `AI_InvalidPromptError`，而它在 `ModelMessage` 里是合法的。
 *
 * 这四条都是「代码看起来对但静默不生效 / 报错位置离原因很远」的类型，
 * 所以写在这里而不是散进协议层：
 * **换 SDK 时要改的地方，应该恰好是这一整个文件。**
 */

/** GLM 系列模型 id 的判定前缀。⚠️ 按模型判，不按 baseURL —— 同一端点上可能有多家模型。 */
const GLM_MODEL_PREFIX = /^glm-/i

/**
 * 「怎么把 (endpoint, model) 变成一个 LanguageModel」。
 *
 * ## 为什么这是个可注入的接缝，而不是写死在 run() 里
 *
 * 没有它，Adapter 测试只能**真的发 HTTP 请求**，而那验不出任何东西 ——
 * 网络抖动会让「翻译是否正确」的断言随机红。有了它，测试注入 SDK 官方
 * 的 `MockLanguageModelV3`，验的是**形状与翻译**，与网络无关。
 *
 * ⚠️ 这个接缝**只留在 Adapter 内部**，不进 `DriverRequest` ——
 * 一旦进协议层，`LanguageModel` 这个 SDK 类型就泄漏过去了，协议层纯度检查会红。
 */
export type ModelFactory = (request: DriverRequest) => LanguageModel

export function createVercelAiDriver(createModel: ModelFactory = defaultModelFactory): AgentDriver {
  return {
  handles: 'openai-chat-completions',

  async run(request: DriverRequest, hooks: DriverHooks, emit: Emit): Promise<DriverResult> {
    // 请求内的风险索引。**局部而非模块级** —— 两个会话交错时不会互相污染。
    const riskByTool = new Map<string, Risk>(
      request.tools.map((definition) => [definition.name, definition.risk]),
    )

    const toolSet: ToolSet = {}
    for (const definition of request.tools) {
      toolSet[definition.name] = aiTool({
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: definition.execute as (input: never) => Promise<unknown>,
      }) as ToolSet[string]
    }

    /** 已被拒绝过。每轮重置。 */
    let denied = false
    /** 已发过 `tool.called` 的 callId，保证一次调用只发一次事件。 */
    const announced = new Set<string>()
    const startedAt = new Map<string, number>()
    /**
     * 并行的保序序号。**在请求工具时分配，不在完成时** ——
     * SDK 用 `Promise.all` 并发执行，谁先返回取决于工具有多快。
     * 拿完成顺序当顺序，重建上下文时结果会安到错误的调用上，
     * **而模型无法察觉**。
     */
    let seqCounter = 0

    const announce = (callId: string, tool: string, input: unknown): void => {
      if (announced.has(callId)) return
      announced.add(callId)
      startedAt.set(callId, Date.now())
      seqCounter += 1
      hooks.onToolCall({ callId, tool, input, seq: seqCounter })
      emit({ name: 'tool.called', data: { runId: request.runId, callId, tool, input } })
    }

    const elapsedSince = (callId: string): number =>
      Date.now() - (startedAt.get(callId) ?? Date.now())

    // ⚠️ **system 消息必须走 instructions，不能留在 messages 里**（见文件头第4 条）。
    // ToolLoopAgent 见到 system 直接抛 AI_InvalidPromptError，
    // 而 `ChatMessage` 里 system 是合法角色 —— 所以翻译在**这里**做。
    const systemText = request.messages
      .filter((message): message is { role: 'system'; content: string } => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const instructions = [request.instructions, systemText].filter((s) => s).join('\n\n')

    const agent = new ToolLoopAgent({
      model: createModel(request),
      ...(instructions ? { instructions } : {}),
      tools: toolSet,
      stopWhen: isStepCount(request.maxSteps),
      // ⚠️ **必须是按名字的对象**（见文件头第1 条）。
      toolApproval: buildApprovalConfig(riskByTool, request.skipApproval === true),
      ...(request.approvalSecret
        ? { experimental_toolApprovalSecret: request.approvalSecret }
        : {}),
    })

    const result = await agent.stream({
      messages: toSdkMessages(request.messages.filter((message) => message.role !== 'system')) as ModelMessage[],
      ...providerOptionsFor(request),
      onStepEnd: (step) => {
        for (const call of step.toolCalls ?? []) {
          announce(call.toolCallId, call.toolName, call.input)
        }
      },
    })

    for await (const part of result.fullStream as AsyncIterable<unknown>) {
      switch ((part as { type?: string }).type) {
        case 'text-delta':
          emit({
            name: 'message.delta',
            data: { runId: request.runId, text: (part as { text: string }).text },
          })
          break

        case 'tool-approval-request': {
          const { toolCall, reason } = part as {
            toolCall: { toolCallId: string; toolName: string; input: unknown }
            reason?: string
          }
          // ⚠️ **seq 照样分配** —— 工具确实被调用了，只是不需要用户批准。
          announce(toolCall.toolCallId, toolCall.toolName, toolCall.input)
          //
          // ⚠️ **skipApproval 时连事件都不发。** SDK 在自动批准的情况下
          // 仍然会发 `tool-approval-request`，原样转发会让前端弹出一张
          // 瞬间就被解决的授权卡 —— 那是纯噪音，还会让人以为授权流程没生效。
          if (request.skipApproval === true) break
          emit({
            name: 'approval.requested',
            data: {
              runId: request.runId,
              callId: toolCall.toolCallId,
              tool: toolCall.toolName,
              input: toolCall.input,
              risk: riskByTool.get(toolCall.toolName) ?? 'write',
              ...(reason ? { reason } : {}),
            },
          })
          break
        }

        case 'tool-approval-response': {
          const { toolCall, approved } = part as {
            toolCall: { toolCallId?: string; toolName: string }
            approved: boolean
          }
          const callId = toolCall.toolCallId ?? toolCall.toolName
          if (!approved) {
            denied = true
            hooks.onApprovalDenied({ callId, tool: toolCall.toolName })
          }
          // 同上：自动批准的那次「响应」没有告知价值。
          if (request.skipApproval === true) break
          emit({
            name: 'approval.resolved',
            data: { runId: request.runId, callId, approved },
          })
          break
        }

        case 'tool-call': {
          const call = part as { toolCallId: string; toolName: string; input: unknown }
          announce(call.toolCallId, call.toolName, call.input)
          break
        }

        case 'tool-result': {
          const done = part as { toolCallId: string; toolName: string; output: unknown }
          const durationMs = elapsedSince(done.toolCallId)
          hooks.onToolResult({
            callId: done.toolCallId,
            tool: done.toolName,
            ok: true,
            output: done.output,
            durationMs,
          })
          emit({
            name: 'tool.completed',
            data: {
              runId: request.runId,
              callId: done.toolCallId,
              tool: done.toolName,
              ok: true,
              output: done.output,
              durationMs,
            },
          })
          break
        }

        case 'tool-error': {
          const failed = part as { toolCallId: string; toolName: string; error: unknown }
          const durationMs = elapsedSince(failed.toolCallId)
          const output = { error: describe(failed.error) }
          hooks.onToolResult({
            callId: failed.toolCallId,
            tool: failed.toolName,
            ok: false,
            output,
            durationMs,
          })
          emit({
            name: 'tool.completed',
            data: {
              runId: request.runId,
              callId: failed.toolCallId,
              tool: failed.toolName,
              ok: false,
              output,
              durationMs,
            },
          })
          break
        }

        case 'error':
          // ⚠️ 模型侧的失败（配额、网络、内容过滤）在这里。
          // 必须归到 `model_error` —— 前端按 code 分支，
          // 显示成「Runtime 崩了，请重试」会误导用户去重启服务。
          throw normalizeError((part as { error: unknown }).error)

        default:
          // 未知 part 忽略。SDK 会加新 part 类型，
          // 这里的任务是**不知道的东西不炸**，而不是穷举。
          break
      }
    }

    const steps = await result.steps
    const [usage, text] = await Promise.all([
      Promise.resolve(result.usage).catch(() => null),
      result.text,
    ])

    const status: DriverResult['status'] = denied
      ? 'denied'
      : steps.length >= request.maxSteps
        ? 'stopped'
        : 'done'

    return { status, steps: steps.length, usage, text }
  },
  }
}

/** 生产实例：模型由 `createOpenAI` 建。测试注入 mock 时用 `createVercelAiDriver()`。 */
export const vercelAiDriver: AgentDriver = createVercelAiDriver()

// ---------------------------------------------------------------------------
// 翻译：协议层消息 → SDK 消息
// ---------------------------------------------------------------------------

/**
 * ⚠️ **`ai@7` 用 content 数组**，不是 v5 那套 `{toolCalls, toolCallId}` 字段：
 *
 * ```ts
 * { role:'assistant', content:[{type:'tool-call', toolCallId, toolName, input}] }
 * { role:'tool',      content:[{type:'tool-result', toolCallId, toolName, output:{type:'text',value}}] }
 * ```
 *
 * 写错形状的症状是 provider 报 400 且**不指出形状问题**。
 * 而**顺序必须与协议层给的完全一致** —— 协议层已经按 `seq` 排好，
 * 这里只能原样传递。
 */
function toSdkMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content }
      case 'user':
        return { role: 'user', content: message.content }
      case 'assistant': {
        const parts: unknown[] = []
        // ⚠️ 正文与 tool-call 可以在同一条消息里，顺序必须先正文后调用 ——
        // 反过来的话有些 provider 会认为「说完了又调工具」，拒掉整条。
        if (message.content) parts.push({ type: 'text', text: message.content })
        for (const call of message.toolCalls ?? []) {
          parts.push({
            type: 'tool-call' as const,
            toolCallId: call.toolCallId,
            toolName: call.tool,
            input: call.input,
          })
        }
        return { role: 'assistant', content: parts }
      }
      case 'tool':
        return {
          role: 'tool',
          content: message.results.map((result) => ({
            type: 'tool-result' as const,
            toolCallId: result.toolCallId,
            toolName: result.tool,
            output: { type: 'text' as const, value: result.output },
          })),
        }
      default: {
        // 协议层加了新角色而这里没跟上 —— **吵出来**，别静默吞掉。
        const exhaustive: never = message
        throw new Error(`未处理的角色：${JSON.stringify(exhaustive)}`)
      }
    }
  })
}

/**
 * 厂商扩展参数。**走 `providerOptions`，不塞进 Prompt** ——
 * Prompt 里写它们等于没写。
 *
 * ⚠️ 键是 **provider 名**（`openai`，因为用的是 `@ai-sdk/openai`），
 * 不是模型名也不是端点名。
 */
function providerOptionsFor(request: DriverRequest): { providerOptions?: Record<string, Record<string, unknown>> } {
  const extra = request.endpoint.extraBody
  const isGlm = GLM_MODEL_PREFIX.test(request.model.id)

  /**
   * **两档来源，后者盖前者（优先级从低到高）：**
   *
   * 1. **模型 id 判出的安全网**：GLM 硬要求 `thinking.type=enabled`
   *    （用 `disabled` 直接请求失败），所以即使没人配也要带。
   *    这一步按**模型 id** 判，不按 baseURL —— 同一端点上可能挂多家模型，
   *    按 baseURL 会把参数发给不支持它的厂商，那是 400。
   * 2. **端点的 `extraBody`（库里配的）**：它是权威来源，覆盖上面的默认。
   *    理由：加一家新厂商应该只改数据库，不该改这个文件。
   *
   * `reasoning_effort` 只有显式配了才带 —— 省掉就是用厂商默认值，
   * 而 GLM 的默认是 `max`（最贵的一档）。
   */
  const body: Record<string, unknown> = {}
  if (isGlm) body.thinking = { type: 'enabled' }
  if (request.model.reasoningEffort) body.reasoning_effort = request.model.reasoningEffort
  Object.assign(body, extra ?? {})

  return Object.keys(body).length > 0 ? { providerOptions: { openai: body } } : {}
}

/**
 * ⚠️ **必须显式用 `provider.chat()`，不能用 `provider(modelId)`。**
 *
 * `provider(modelId)` 走**默认路由**：它按模型名猜该用哪个 OpenAI API
 * （Chat Completions 还是 Responses）。而它猜的方式是解析模型名里的版本号
 * —— 对 `glm-5.3` 这种非 OpenAI 的名字，猜测路径上会调`modelId.startsWith(...)`
 * 而 `modelId` 传进来是 undefined，**直接崩**：
 *
 * ```
 * TypeError: Cannot read properties of undefined (reading 'startsWith')
 *   at getOpenAILanguageModelCapabilities (@ai-sdk/openai/...)
 * ```
 *
 * 而且即使不崩，猜错API 也是错的（GLM 的 `/api/paas/v4` 只有 Chat Completions）。
 *
 * 所以：**协议族叫 `openai-chat-completions`，就该用 `chat()`，名字与实现对齐。**
 */
function defaultModelFactory(request: DriverRequest): LanguageModel {
  const provider = createOpenAI({
    ...(request.endpoint.baseUrl ? { baseURL: request.endpoint.baseUrl } : {}),
    // ⚠️ key 从环境变量取，且**缺失时让 SDK 自己报错** ——
    // 那条错误信息会指出缺哪个变量名，比自己编一句「模型调用失败」有用。
    apiKey: process.env[request.endpoint.keyEnvVar],
  })
  return provider.chat(request.model.id)
}

/**
 * ⚠️ **必须用按名字的对象**（见文件头第1 条）。泛函形式类型合法但运行时无效：
 * SDK 内部走 `getOwn(toolApproval, toolName)`，传泛函时这个查找返回 undefined，
 * 所有工具被归成 `not-applicable`，而那条分支**既不发审批请求，
 * 也不把工具放进待执行队列**。
 *
 * 症状极具迷惑性：`tool.called` 正常发出（那来自 `onStepEnd`），但工具永不执行。
 */
function buildApprovalConfig(
  riskByTool: Map<string, Risk>,
  skipApproval: boolean
): Record<string, 'approved' | 'user-approval' | 'not-applicable'> {
  const config: Record<string, 'approved' | 'user-approval' | 'not-applicable'> = {}
  for (const [name, risk] of riskByTool) {
    if (skipApproval) {
      config[name] = 'approved'
      continue
    }
    config[name] =
      risk === 'read' ? 'not-applicable' : 'user-approval'
  }
  return config
}

// ---------------------------------------------------------------------------
// 错误归类
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把 SDK / provider 的错误归到契约 §四 的 code 上。
 * **前端按 code 分支，不匹配文案**（契约 §四），所以这张表是契约的一部分。
 */
export function normalizeError(error: unknown): Error & { code: string } {
  const message = describe(error)
  const name = error instanceof Error ? error.name : ''
  const raw = error as { code?: unknown; statusCode?: unknown } | null

  if (raw && typeof raw.code === 'string' && raw.code !== '') {
    return Object.assign(new Error(message), { code: raw.code })
  }

  if (name === 'AI_InvalidToolInputError' || name === 'AI_ToolCallRepairError') {
    return Object.assign(new Error(message), { code: 'invalid_tool_input' })
  }

  const status = typeof raw?.statusCode === 'number' ? raw.statusCode : undefined
  if (
    name === 'LoadAPIKeyError' ||
    name === 'NoSuchModelError' ||
    name === 'APICallError' ||
    status === 401 ||
    status === 403 ||
    status === 429 ||
    /api key|API key|apiKey|rate limit|quota|model/i.test(message)
  ) {
    return Object.assign(new Error(message), { code: 'model_error' })
  }

  return Object.assign(new Error(message), { code: 'internal_error' })
}