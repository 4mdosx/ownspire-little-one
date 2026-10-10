import type { DriverRegistry } from './driver.js'
import type { ChatMessage, DriverHooks, EndpointConfig, ModelConfig } from './driver.js'
import type { ToolDefinition } from '../tools/registry.js'
// ⚠️ **不许 import `../drivers/index.js`。** 那会拉进 `@ai-sdk/openai`，
// 协议层就不再是「零 SDK 依赖」了 —— 纯度检查只查直接 import，查不出这种
// 传递依赖。具体用哪个 Driver 由调用方通过 `TurnDeps.drivers` 传进来。
import type { Emit } from '../lib/sse.js'
import { DEFAULT_INSTRUCTIONS } from './instructions.js'

/**
 * # 协议层 · 编排
 *
 * **这个文件不许 import `ai` 或 `@ai-sdk/*`。** `scripts/verify-protocol-purity.ts`
 * 机器检查这一条 —— 因为「不许」写在注释里��人不会看，写进 CI 才会一直成立。
 *
 * ## 它负责什么
 *
 * - 挑 Driver（按端点的 **protocol**，不是厂商）
 * - **授权判定**：工具声明的 `risk` → 需要用户确认还是自动放行
 * - 上下文重建：把库里的消息 + 工具历史整理成模型无关的 `ChatMessage[]`
 * - 落库：工具调用与结果（**Adapter 只报告，存不存是协议层的事**）
 *
 * ## 它不负责什么
 *
 * 任何跟 SDK 有关的事：怎么建消息、怎么解析流、怎么配 providerOptions。
 * 那些全在 `src/drivers/<protocol>/`。
 */

export type ApprovalResponseInput = {
  approvalId: string
  approved: boolean
  reason?: string
}

/** 协议层要落库的工具调用信息。 */
export type ToolCallRecord = {
  callId: string
  tool: string
  input: unknown
  seq: number
}

/**
 * 库里读出来的工具调用行。`ToolCallRecord` 是**写入**的形状，
 * 这个是**读出**的 —— 多出 `status` 与 `output`（写的时候还没结果）。
 */
export type StoredToolCall = ToolCallRecord & {
  status: 'pending' | 'ok' | 'failed' | 'denied'
  output: string | null
  seq: number
  /**
   * 属于哪一轮。**重建上下文靠它把工具调用挂到对应的 assistant 消息后面。**
   *
   * ⚠️ 可以为 null —— 「孤儿调用」：run 建了但助手消息没落库（进程被杀）。
   * 那种调用照样要能被读出来，好让上层决定是丢掉还是补上。
   */
  runId: string | null
}

export type TurnDeps = {
  drivers: DriverRegistry
  /** 落库接口。**用窄接口而不是直接 import db** —— 这样协议层的测试能用假实现。 */
  store: TurnStore
}

export type TurnStore = {
  findSession(sessionId: string): {
    id: string
    instructions: string | null
    tools: string
    engine: 'little-one' | 'claude'
    endpointId: string | null
    modelId: string | null
    /** claude 引擎的会话锚（claude 侧 session id）。 */
    engineSessionId: string | null
    /** 双审批开关（契约 §五）。true = 需要审批。 */
    sandboxApproval: boolean
    businessApproval: boolean
  } | undefined
  /**
   * 归一化用量落账（契约 §六）。厂商归属在 store 实现里解析 ——
   * 协议层只给 endpointId + modelId，不碰 providerId（那是配置层的事）。
   */
  recordUsage(input: {
    runId: string
    sessionId: string
    endpointId: string
    modelId: string
    inputTokens: number
    outputTokens: number
  }): void
  /** 实例累计用量（token）。预算闸的输入。 */
  usageTotals(): { inputTokens: number; outputTokens: number }
  /** 实例预算上限（token）。null = 不设防。 */
  budgetLimit(): number | null
  /** claude 引擎的会话锚落库（契约 §六）。 */
  setEngineSession(sessionId: string, engineSessionId: string): void
  hasRunningRun(sessionId: string): boolean
  appendMessage(input: {
    sessionId: string
    runId: string | null
    role: 'user' | 'assistant'
    content: string
  }): void
  recentMessages(sessionId: string): { role: 'user' | 'assistant'; content: string; runId: string | null }[]
  recentToolCalls(sessionId: string, runLimit?: number): StoredToolCall[]
  recordToolCall(input: {
    sessionId: string
    runId: string
    seq: number
    callId: string
    tool: string
    input?: unknown
    output?: unknown
    ok?: boolean
    durationMs?: number
    status: 'pending' | 'ok' | 'failed' | 'denied'
  }): void
  startRun(sessionId: string, options?: { id?: string; parentRunId?: string }): { id: string }
  finishRun(runId: string, result: {
    status: 'done' | 'stopped' | 'denied' | 'cancelled' | 'failed'
    steps?: number
    usage?: unknown
    code?: string
    error?: string
  }): void
  touchSession(sessionId: string): void
resolveEndpoint(endpointId: string): EndpointConfig | undefined
    /** 不给modelId 时**返回第一个可用模型** —— 而不是 undefined。 */
    resolveModel(modelId?: string, endpointId?: string): ModelConfig | undefined
}

export type ExecuteTurnInput = {
  sessionId: string
  content: string
  approvalResponses: ApprovalResponseInput[]
  /**
   * ⚠️ 类型是 `Emit`（具名事件的联合），不是 `(event: {name: string}) => void`。
   * 用松散类型的话，协议层就能发出契约里没有的事件名而编译照样过 ——
   * 那正是「前端按 code 分支却收到了没见过的事件」这类 bug 的来源。
   */
  emit: Emit
  /**
   * 这一轮的 run id。**给了就用作库里的 runs.id**，没给才由 startRun 生成。
   *
   * server 层先于开流生成它，让 `run.started`、`tool.called`、库里的 runs 行、
   * 取消接口指向**同一个** id —— 此前是两个来源各生成各的，
   * raven 按 runId 关联事件，对不上就是两份真相。
   */
  runId?: string
  /**
   * 取消信号。server 层在取消接口里 abort 它；**取消了就不是失败**：
   * Driver 应返回 `status: 'cancelled'`，协议层按正常收尾处理（run.completed），
   * 不发 `run.failed`。见契约 §三「取消一轮」。
   */
  signal?: AbortSignal
  /**
   * 已经解析好的工具定义。**协议层不解析名字** —— registry 在组装层
   * （src/server.ts）注入，与 drivers 的注入方式同理：协议层测试不必建真注册表。
   *
   * 「会话里的工具在注册表里已经不存在」怎么处理是**组装层**的裁定
   * （跳过并警告，契约 §六），协议层只管把拿到的定义原样交给 Driver。
   */
  tools?: ToolDefinition<never>[]
  /** 会话固定了端点/模型时用它，否则用默认。 */
  endpointId?: string
  modelId?: string
  approvalSecret?: string
  /** 步数上限。默认见 `DEFAULT_MAX_STEPS`。 */
  maxSteps?: number
}

/** 步数上限。**不是错误** —— 触发时如实告诉用户「达到步数上限」。 */
export const DEFAULT_MAX_STEPS = 20

export class TurnError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'TurnError'
  }
}

export async function executeTurn(deps: TurnDeps, input: ExecuteTurnInput): Promise<void> {
  const { sessionId, content, emit } = input

  const session = deps.store.findSession(sessionId)
  if (!session) throw new TurnError('session_not_found', 404, '会话不存在。')
  if (deps.store.hasRunningRun(sessionId)) {
    // 409 必须在**开流之前**判 —— 流一旦开始状态码就改不了（契约 §四 规则一）。
    throw new TurnError('run_in_progress', 409, '这个会话还有一轮在跑。')
  }

  // 预算闸（契约 §六）。和 409 同理必须在开流前判，否则「预算用尽」会变成
  // 流里的 run.failed —— 而它是「请求与状态冲突」，不是错误。
  // 检查点只有 run 启动前：运行中逐 token 掐断做不到（usage 收尾才给全量），
  // 运行中的超支由工具调用次数上限兜底。
  const limit = deps.store.budgetLimit()
  if (limit !== null) {
    const used = deps.store.usageTotals()
    if (used.inputTokens + used.outputTokens >= limit) {
      throw new TurnError(
        'budget_exhausted',
        409,
        `token 预算已用尽：累计 ${used.inputTokens + used.outputTokens} / 上限 ${limit}。` +
          '去 raven 的配置目录调整或清除上限。',
      )
    }
  }

  const trimmed = content.trim()
  if (trimmed === '' && input.approvalResponses.length === 0) {
    throw new TurnError('empty_content', 400, 'content 不能为空。')
  }

  // ⚠️ **两个都可选**：没指定就取第一个可用模型。
  //
  // 早先的版本写成「没指定就是没配置」，那会让「库里配好了模型、
  // 但这个会话没指定」变成 503 —— 而那是最常见的正常状态。
  // 「模型没配」的判定属于**启动期**（key 缺不缺），不��每轮。
  // 会话固定的端点/模型（2026-10-09 落库）优先于「取默认」——
  // claude 引擎的会话必须固定在 Anthropic 协议端点上，取默认会拿到错协议的模型。
  const sessionModelId = input.modelId ?? session.modelId ?? undefined
  const sessionEndpointId = input.endpointId ?? session.endpointId ?? undefined
  const model = sessionModelId
    ? deps.store.resolveModel(sessionModelId, sessionEndpointId)
    : (deps.store.resolveModel(undefined) ?? undefined)
  const endpoint = (sessionEndpointId ? deps.store.resolveEndpoint(sessionEndpointId) : undefined) ??
    (model ? deps.store.resolveEndpoint(model.endpointId) : undefined)

  if (!model || !endpoint) {
    // **到这里说明库里一个模型都没有** —— 那是真的没配，
    // 而不是一个会话没指定。说清楚怎么修。
    throw new TurnError(
      'model_not_configured',
      503,
      '没有可用的模型：models 表是空的，或指定的模型不存在。' +
        '去 raven 的「模型与厂商」界面确认 providers / endpoints / models 三张表。'
    )
  }

  if (trimmed !== '') {
    deps.store.appendMessage({ sessionId, runId: null, role: 'user', content: trimmed })
  }

  // runId 的唯一真相：server 层给的就用它（SSE 的 run.started 已经带它了），
  // 没给（协议层直跑、验证脚本）才在这里生成。
  const run = deps.store.startRun(sessionId, input.runId ? { id: input.runId } : {})

  // ⚠️ **协议层不读 risk、不判授权** —— 那是 Adapter 的活。
  // `risk` 的唯一用途在 Adapter 里（`buildApprovalConfig`）。
  // 协议层若也判一遍，就会出现两个判定来源，而它们迟早会不一致。
  try {
    // 引擎选择（契约 §三）：claude 引擎不走端点协议这条轴 ——
    // 它是「换整个 loop 引擎」，声明 handles: 'claude' 的 Driver。
    // 还没接线时这里明确拒绝（409），不让它掉进 registry 的 500。
    if (session.engine === 'claude' && !deps.drivers.list().includes('claude')) {
      throw new TurnError(
        'engine_not_available',
        409,
        'claude 引擎尚未接线。确认沙箱里装了 claude-cli，且 drivers 注册表里有 handles 为 claude 的 Driver。',
      )
    }
    const driver = deps.drivers.get(session.engine === 'claude' ? 'claude' : endpoint.protocol)
    const messages = buildModelMessages(deps.store, sessionId, input.approvalResponses)

    const hooks: DriverHooks = {
      onToolCall: ({ callId, tool, input: toolInput, seq }) => {
        deps.store.recordToolCall({
          sessionId,
          runId: run.id,
          seq,
          callId,
          tool,
          input: toolInput,
          status: 'pending',
        })
      },
      onToolResult: ({ callId, tool, ok, output, durationMs }) => {
        deps.store.recordToolCall({
          sessionId,
          runId: run.id,
          seq: 0, // 已存在，ON CONFLICT 更新时不改 seq
          callId,
          tool,
          output,
          ok,
          durationMs,
          status: ok ? 'ok' : 'failed',
        })
      },
      onApprovalDenied: ({ callId, tool }) => {
        deps.store.recordToolCall({
          sessionId,
          runId: run.id,
          seq: 0,
          callId,
          tool,
          output: '用户拒绝',
          ok: false,
          status: 'denied',
        })
      },
    }

    const result = await driver.run(
      {
        runId: run.id,
        endpoint,
        model,
        ...(session.instructions ?? DEFAULT_INSTRUCTIONS
          ? { instructions: session.instructions ?? DEFAULT_INSTRUCTIONS }
          : {}),
        messages,
        tools: input.tools ?? [],
        ...(input.signal ? { signal: input.signal } : {}),
        ...(session.engineSessionId ? { engineSessionId: session.engineSessionId } : {}),
        ...(input.approvalResponses.length > 0 ? { approvalResponses: input.approvalResponses } : {}),
        // 双审批开关（契约 §五）：**始终显式传递**，不留「缺省」的二义 ——
        // 两个开关的产品缺省不同（业务开、沙箱关），字段级缺省语义再叠一层
        // 迟早拧包。Driver 侧只在「字段真的缺失」（老调用方）时保守取需审批。
        ...(session.businessApproval ? { businessApproval: true } : { businessApproval: false }),
        ...(session.sandboxApproval ? { sandboxApproval: true } : { sandboxApproval: false }),
        maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
        ...(input.approvalSecret ? { approvalSecret: input.approvalSecret } : {}),
      },
      hooks,
      emit as never,
    )

    if (result.text.trim() !== '') {
      deps.store.appendMessage({
        sessionId,
        runId: run.id,
        role: 'assistant',
        content: result.text,
      })
    }

    // claude 引擎的会话锚：每轮都可能变化（resume 会 fork 新 id），
    // 以本轮结果为准覆盖落库，下轮传回。
    if (result.engineSessionId) {
      deps.store.setEngineSession(sessionId, result.engineSessionId)
    }
    // denied 提升（契约 §四）：用户拒绝了授权、Driver 返回 done —— 说明模型
    // 接受了拒绝结论并收尾（它甚至可能没再碰那个工具，canUseTool 没机会再被调）。
    // 这条判定是引擎无关的：little-one 的 SDK 会自己置 denied，claude 靠这里兜底。
    const userDenied = input.approvalResponses.some((response) => !response.approved)
    const finalStatus = userDenied && result.status === 'done' ? 'denied' : result.status
    deps.store.finishRun(run.id, { status: finalStatus, steps: result.steps, usage: result.usage })
    // 用量落账（契约 §六）：成功收尾的 run 都记（含 stopped/denied/cancelled ——
    // 它们一样烧了 token）。失败路径不记：usage 半途拿不到，宁可少记。
    deps.store.recordUsage({
      runId: run.id,
      sessionId,
      endpointId: endpoint.id,
      modelId: model.id,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })

    emit({
      name: 'run.completed',
      data: { runId: run.id, status: finalStatus, steps: result.steps, usage: result.usage },
    })
  } catch (error) {
    // ⚠️ **取消不是失败。** abort 穿透到 Driver 之后它可能以异常收场
    // （SDK 会把 AbortError 从流里抛出来），但契约上这是正常收尾：
    // 发 `run.completed`（status: "cancelled"），不发 `run.failed`。
    // raven 的终止指示器只认「恰好一个终止事件」，这里换成 failed 就是误导。
    if (input.signal?.aborted) {
      deps.store.finishRun(run.id, { status: 'cancelled' })
      emit({
        name: 'run.completed',
        data: { runId: run.id, status: 'cancelled', steps: 0, usage: null },
      })
      return
    }
    const described = describe(error)
    deps.store.finishRun(run.id, { status: 'failed', code: described.code, error: described.message })
    // ⚠️ **不自己发 `run.failed`** —— `createAgentStream` 的 catch 会发。
    // 发两次会让前端终止指示器触发两次，而 raven 那边是「收到终止事件就关指示器」。
    //
    // ⚠️ **hint 与 retryable 必须一起带过去**：这里是唯一一次重新包装，
    //只捞code 与 message 就等于把「该充值还是该等待」这个判断扔掉了 ——
    // 而它恰好是 raven 显示什么、以及要不要给重试按钮的依据。
    throw Object.assign(new Error(described.message), {
      code: described.code,
      ...(described.hint !== undefined ? { hint: described.hint } : {}),
      ...(described.retryable !== undefined ? { retryable: described.retryable } : {}),
    })
  } finally {
    deps.store.touchSession(sessionId)
  }
}

/**
 * 上下文重建。**模型无关** —— 输出 `ChatMessage[]`，不是任何 SDK 的类型。
 *
 * 这是「长程工具调用」的实现处：模型必须记得上一轮调过什么、
 * 拿到什么输出，否则它会重复查或者直接编。
 *
 * ⚠️ **并行调用的顺序必须按 `seq`，不能按完成顺序** ——
 * SDK 并行执行（`Promise.all`），谁先返回取决于工具本身有多快。
 * 顺序错了模型会把A 的结果当成 B 的，**而它无法察觉**。
 */
export function buildModelMessages(
  store: TurnStore,
  sessionId: string,
  approvals: ApprovalResponseInput[]
): ChatMessage[] {
  const toolCalls = store.recentToolCalls(sessionId)
  const messages: ChatMessage[] = []

  /** runId → 该 run 的工具调用。 */
  const byRun = new Map<string, typeof toolCalls>()
  for (const call of toolCalls) {
    const list = byRun.get(call.runId ?? '') ?? []
    list.push(call)
    byRun.set(call.runId ?? '', list)
  }

  const history = store.recentMessages(sessionId)
  for (const row of history) {
    messages.push({ role: row.role, content: row.content })
    // 工具调用插在这条消息之后（它们属于同一轮），一轮只插一次。
    if (row.runId !== null) {
      const calls = byRun.get(row.runId)
      if (calls && calls.length > 0) {
        byRun.delete(row.runId)
        messages.push(...toChatToolMessages(calls))
      }
    }
  }

  // **孤儿工具调用**：run 存在但对应的 assistant 消息没落库（进程在落库前被杀）。
  // 照样补上 —— 少一次工具结果比顺序错乱好处理。
  for (const [, calls] of byRun) {
    messages.push(...toChatToolMessages(calls))
  }

  // 审批结论要喂回模型，否则它不知道自己的工具被拒了。
  for (const approval of approvals) {
    messages.push({
      role: 'user',
      content: approval.approved
        ? `授权请求 ${approval.approvalId} 已被用户批准，可以继续。`
        : `授权请求 ${approval.approvalId} 已被用户拒绝。请不要重试同一个调用，向用户说明情况并给出替代方案。`,
    })
  }

  if (messages.length === 0) messages.push({ role: 'user', content: '（空会话）' })
  return messages
}

/**
 * 工具调用 → 模型消息。
 *
 * ⚠️ **`status: 'pending'` 的不在里面** —— 悬空的 tool-call 没有 result，
 * 重建进上下文会让 provider 直接判非法。
 */
function toChatToolMessages(
  calls: (ToolCallRecord & { status: string; output: string | null })[]
): ChatMessage[] {
  const sorted = [...calls]
    .filter((call) => call.status !== 'pending')
    .sort((a, b) => a.seq - b.seq || (a.callId < b.callId ? -1 : 1))

  if (sorted.length === 0) return []

  return [
    {
      role: 'assistant',
      toolCalls: sorted.map((call) => ({
        toolCallId: call.callId,
        tool: call.tool,
        input: safeParse(call.input),
      })),
    },
    {
      role: 'tool',
      // ⚠️ 顺序与上面**严格一致**。错位会让模型把结果安到错误的调用上。
      results: sorted.map((call) => ({
        toolCallId: call.callId,
        tool: call.tool,
        output: toolResultContent(call),
      })),
    },
  ]
}

function toolResultContent(call: { status: string; output: string | null }): string {
  if (call.status === 'denied') {
    return '用户拒绝了这次调用。不要重试同一个调用，向用户说明情况并给替代方案。'
  }
  if (call.status === 'failed') return `工具执行失败：${call.output ?? '未知原因'}`
  return call.output ?? ''
}

/** ⚠️ 解析失败返回原始字符串而不抛 —— 一次坏 JSON 不该让整轮对话失败。 */
function safeParse(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * 把异常转成 `{ code, message, hint?, retryable? }`。
 *
 * ⚠️ **hint 与 retryable 要在这里读出来**，因为上面 catch 里会重新包装错误，
 * 只捞 code 与 message 就等于把「该充值还是该等待」这个判断扔在中间那一层。
 */
function describe(error: unknown): {
  code: string
  message: string
  hint?: string
  retryable?: boolean
} {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      code?: unknown
      message?: unknown
      hint?: unknown
      retryable?: unknown
    }
    if (typeof candidate.code === 'string' && candidate.code !== '') {
      return {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : '未知错误。',
        ...(typeof candidate.hint === 'string' ? { hint: candidate.hint } : {}),
        ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
      }
    }
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * ⚠️ 这里**故意不导出一个默认的 `drivers`**。
 *
 * 协议层一旦提供「默认用哪个 Adapter」，就等于把它自己和某个 SDK 绑在一起 ——
 * 于是「换 SDK」要改的就不再只有 `src/drivers/` 一个目录。
 * 组装在 `src/server.ts` 做（`{ drivers, store }`），协议层只认接口。
 */