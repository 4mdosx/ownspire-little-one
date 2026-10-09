/**
 * SSE 流。事件名与 data 形状是 docs/01-contract.md §四 冻结的契约，
 * **raven 的前端按它写**。改这里之前先改契约文档并升版本号。
 *
 * 与 raven 的 `backstage/lib/sse.ts` 同源同构，那份踩过的三个坑都在注释里：
 *
 * 1. **失败之后 HTTP 状态码改不了了。** `work` 抛错时响应头早已发出，
 *    所以错误只能作为 `run.failed` 事件送出去，HTTP 仍是 200。
 *    契约 §三 里「真状态码」只适用于**流还没开始前**的错误。
 * 2. **`data:` 里不能出现裸换行。** 一律先 stringify。
 * 3. **keepalive 必须是注释行**（`: xxx`）。写 `event: ping` 会让前端的
 *    事件回调被无意义地唤醒，而注释行按规范会被解析器直接丢弃。
 */

export type RunStarted = {
  runId: string
  sessionId: string
  startedAt: number
}

export type MessageDelta = { runId: string; text: string }

export type ToolCalled = { runId: string; callId: string; tool: string; input: unknown }

export type ToolCompleted = {
  runId: string
  callId: string
  tool: string
  ok: boolean
  output: unknown
  durationMs: number
}

export type ApprovalRequested = {
  runId: string
  callId: string
  tool: string
  input: unknown
  risk: 'read' | 'write' | 'destructive'
  reason?: string
}

export type ApprovalResolved = { runId: string; callId: string; approved: boolean }

export type RunCompleted = {
  runId: string
  status: 'done' | 'stopped' | 'denied'
  steps: number
  usage: unknown
}

export type RunFailed = {
  runId: string
  code: string
  error: string
  /**
   * 给用户的可执行提示，一句话说明「现在该做什么」。
   *
   * ⚠️ **加字段不改契约版本**（§八「加字段永远可以」）。raven 按 `code` 分支，
   * `hint` 只是让同一个 code 下的文案不必由前端各写一遍。
   */
  hint?: string
  /**
   * 同样的请求再发一次有没有意义。
   *
   * 单拎出来的原因：前端若靠文案猜「能不能重试」，猜错的代价是
   * 一个永远转圈的进度条 —— 而「限流可以重试、欠费不能」这件事
   * 只有服务端知道。
   */
  retryable?: boolean
}

/**契约 §四 的事件表。加事件可以，改名不行。 */
export type AgentEvent =
  | { name: 'run.started'; data: RunStarted }
  | { name: 'message.delta'; data: MessageDelta }
  | { name: 'tool.called'; data: ToolCalled }
  | { name: 'tool.completed'; data: ToolCompleted }
  | { name: 'approval.requested'; data: ApprovalRequested }
  | { name: 'approval.resolved'; data: ApprovalResolved }
  | { name: 'run.completed'; data: RunCompleted }
  | { name: 'run.failed'; data: RunFailed }

export type Emit = (event: AgentEvent) => void

const encoder = new TextEncoder()

/** 15 秒一次注释行：nginx / Cloudflare 的默认空闲超时多在 60s，留足余量。 */
const KEEPALIVE_MS = 15_000

function encodeFrame(name: string, data: unknown): Uint8Array {
  // 必须先 stringify：裸换行会让 `data:` 帧立刻散架。
  const payload = JSON.stringify(data) ?? 'null'
  return encoder.encode(`event: ${name}\ndata: ${payload}\n\n`)
}

/**
 * 把一段会产生事件的异步工作包成 `text/event-stream` 响应。
 *
 * `work` 立即开始执行但**不阻塞**返回：调用方拿到 Response 就能交出去，
 * 事件边产生边推。`work`结束后流关闭，客户端据此判断「完了」。
 *
 * 客户端断开时**不中断 work**：会话与 run 记录必须写完，否则关掉页面
 * 会在库里留下一条永远 `running` 的记录。SSE 是尽力而为的展示通道，
 * 最终结论以数据库为准。
 */
export function createAgentStream(
  work: (emit: Emit) => Promise<void>,
  options: { runId: string; sessionId: string; startedAt: number },
): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const write = (chunk: Uint8Array): void => {
    if (closed || controller === null) return
    try {
      controller.enqueue(chunk)
    } catch {
      closed = true
      stopTimer()
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    stopTimer()
    try {
      controller?.close()
    } catch {
      // 已经关了（重复 close 会抛 TypeError）。
    }
  }

  const emit: Emit = (event) => write(encodeFrame(event.name, event.data))

  const stream = new ReadableStream<Uint8Array>({
    start(startController) {
      controller = startController
      timer = setInterval(() => write(encoder.encode(': keepalive\n\n')), KEEPALIVE_MS)
      // `run.started` 必须是第一个事件：前端靠它拿到 runId 来关联后续所有事件。
      emit({
        name: 'run.started',
        data: { runId: options.runId, sessionId: options.sessionId, startedAt: options.startedAt },
      })
      void (async () => {
        try {
          await work(emit)
        } catch (error) {
          const { code, error: message, hint, retryable } = describeError(error)
          emit({
            name: 'run.failed',
            data: {
              runId: options.runId,
              code,
              error: message,
              ...(hint !== undefined ? { hint } : {}),
              ...(retryable !== undefined ? { retryable } : {}),
            },
          })
        } finally {
          close()
        }
      })()
    },
    cancel() {
      closed = true
      stopTimer()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx 默认会把响应缓冲起来，SSE 就变成「跑完一次性吐出」。
      'X-Accel-Buffering': 'no',
    },
  })
}

/**
 * 把异常转成 `run.failed` 的三个字段。
 *
 * ⚠️ `hint` 与 `retryable` 是**加字段**（契约 §八：加字段永远可以，改名要升版本）。
 * 加它们是因为 raven 只能拿到 `code` + `error` 时，两个真正要采取的行动不同的
 * 错误（余额不足 / 被限流）在前端长得一样 —— 用户只能去读厂商原文，
 * 而「余额不足或无可用资源包,请充值。」这句话里没有「现在该做什么」。
 */
function describeError(error: unknown): { code: string; error: string; hint?: string; retryable?: boolean } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      code?: unknown
      message?: unknown
      name?: unknown
      hint?: unknown
      retryable?: unknown
    }
    if (typeof candidate.code === 'string' && candidate.code !== '') {
      return {
        code: candidate.code,
        error: typeof candidate.message === 'string' ? candidate.message : '未知错误。',
        ...(typeof candidate.hint === 'string' ? { hint: candidate.hint } : {}),
        ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
      }
    }
  }
  if (error instanceof Error) {
    // SDK 的几个错误类名字本身就说明了成因，映射成契约里的稳定 code。
    const mapped = ERROR_NAMES[error.name]
    return { code: mapped ?? 'internal_error', error: error.message }
  }
  return { code: 'internal_error', error: String(error) }
}

/**
 * 错误类名 → 契约 §四 的 code。
 * **前端按 code 分支，不匹配文案**，所以这张表是契约的一部分：
 * 换 SDK 时如果 SDK 改了错误类名，这里必须跟着补。
 */
const ERROR_NAMES: Record<string, string> = {
  AI_NoSuchToolError: 'internal_error',
  AI_InvalidToolInputError: 'invalid_tool_input',
  AI_ToolCallRepairError: 'invalid_tool_input',
  AI_ToolChoiceViolationError: 'internal_error',
  AI_MissingToolResultsError: 'internal_error',
  AI_ToolCallNotFoundForApprovalError: 'internal_error',
  AI_InvalidToolApprovalError: 'internal_error',
  AI_InvalidToolApprovalSignatureError: 'internal_error',
}