import { id } from '../lib/ids.js'
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  RAVEN_TOOL_PROTOCOL_VERSION,
  type CancelExecutionData,
  type ListToolsData,
  type ToolError,
  type ToolErrorCode,
  type ToolProtocolRequest,
  type ToolProtocolResponse,
  type ToolResult,
} from '../protocol/raven-tool-protocol.js'
import { toZod } from './json-schema.js'
import { tool } from './registry.js'

/**
 * raven 工具桥 —— **工具定义来自 raven，不在这里手写。**
 *
 * ## 这个文件为什么变薄了
 *
 * 早先这里手抄了五个工具的 zod schema，raven 那边也有一份 `GATEWAY_TOOLS`。
 * 两份定义各自演进，漂移是迟早的事，而漂移的表现是
 * 「模型按 A 的 schema 构造参数，raven 按 B 校验，于是永远 invalid_input」。
 *
 * 现在 `listTools` 是唯一的事实来源：**raven 加一个工具，这里不改一行代码。**
 * 这就是那条窄协议换来的东西 —— 否则协议只是装饰。
 *
 * ## 路径边界不在这里
 *
 * raven 的 `backstage/lib/sandbox.ts` 是唯一一份路径判定，依据是 raven 自己的
 * `rootPath`。**这个文件里一个路径检查都不做。** 在这里复制一份意味着
 * 两套会漂移的判定，而漂移的那一次就是越界。传绝对路径或 `../` 会被 raven 挡掉，
 * 我们只需要把它的错误原样传回给模型。
 */

const RAVEN_URL = () => (process.env.RAVEN_URL?.trim() || 'http://127.0.0.1:5800').replace(/\/+$/, '')
const RAVEN_TOKEN = () => process.env.RAVEN_GATEWAY_TOKEN?.trim() || ''
const GATEWAY_PATH = '/api/agent/gateway'

/**
 * 已经从 raven 注册过的工具名。
 *
 * 重复加载（启动时一次、测试里一次）不该炸：`registry` 的 `tool()` 对重名抛错，
 * 而那本来是防「后注册顶掉先注册」。同一份来源重复注册不算冲突，所以这里跳过。
 */
const registeredNames = new Set<string>()

export type RavenClient = {
  listTools: (workspaceId?: string) => Promise<ListToolsData>
  executeTool: (request: {
    workspaceId?: string
    toolName: string
    arguments: Record<string, unknown>
    executionId?: string
    timeoutMs?: number
  }) => Promise<ToolResult>
  cancelExecution: (executionId: string) => Promise<CancelExecutionData>
}

/** raven 返回的错误。**带 `code`，因为调用方要按它决定「要不要换个参数再试」。 */
export class RavenToolError extends Error {
  readonly code: ToolErrorCode
  readonly retryable: boolean

  constructor(error: ToolError) {
    super(error.message)
    this.name = 'RavenToolError'
    this.code = error.code
    this.retryable = error.retryable
  }
}

/**
 * HTTP 传输层。
 *
 * ⚠️ fetch 有自己的超时，且**比 raven 的执行超时更长**：raven 到点会返回
 * `timeout` 终态，那是有信息量的结果；而网络层面的卡死没有任何信息，
 * 只能由我们这边掐断。给 5 秒余量是为了让 raven 的终态有机会先到。
 */
async function transport<T>(request: ToolProtocolRequest, timeoutMs: number): Promise<T> {
  const token = RAVEN_TOKEN()
  if (!token) {
    throw new Error('没有配置 RAVEN_GATEWAY_TOKEN，无法调用 raven。先把 raven 的 gateway 配起来。')
  }

  const response = await fetch(`${RAVEN_URL()}${GATEWAY_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ v: RAVEN_TOOL_PROTOCOL_VERSION, ...request }),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  })

  const payload = (await response.json().catch(() => null)) as ToolProtocolResponse<T> | null

  if (payload === null) {
    throw new RavenToolError({
      code: 'internal_error',
      message: `raven ${request.op} 返回了无法解析的响应（HTTP ${response.status}）。`,
      retryable: true,
    })
  }

  if (payload.ok !== true) throw new RavenToolError(payload.error)
  return payload.data
}

export function createRavenClient(): RavenClient {
  return {
    listTools: (workspaceId) =>
      transport<ListToolsData>(
        { op: 'listTools', ...(workspaceId ? { workspaceId } : {}) },
        DEFAULT_EXECUTION_TIMEOUT_MS
      ),

    executeTool: (request) =>
      transport<ToolResult>(
        {
          op: 'executeTool',
          toolName: request.toolName,
          arguments: request.arguments,
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          ...(request.executionId ? { executionId: request.executionId } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        },
        request.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
      ),

    cancelExecution: (executionId) =>
      transport<CancelExecutionData>({ op: 'cancelExecution', executionId }, DEFAULT_EXECUTION_TIMEOUT_MS),
  }
}

// ---------------------------------------------------------------------------
// 在飞追踪：取消接口要有东西可指
// ---------------------------------------------------------------------------

/**
 * 已发出但还没回来的执行。
 *
 * 它存在的理由只有一个：**让「中断这一轮」能真的把 raven 那边也停掉。**
 * 不记的话，runtime 只能断开自己的流，而 raven 那头的命令还在跑 ——
 * 「取消成功」就成了一句只对一半的话。
 */
const inflight = new Map<string, { toolName: string; startedAt: number }>()

export function ravenInflightExecutions(): { executionId: string; toolName: string; startedAt: number }[] {
  return [...inflight.entries()].map(([executionId, value]) => ({ executionId, ...value }))
}

/** 取消在飞的执行。不给参数 = 全部取消。返回成功发出取消信号的条数。 */
export async function cancelRavenExecutions(
  executionIds?: string[]
): Promise<{ cancelled: number; failed: number }> {
  const targets = executionIds ?? [...inflight.keys()]
  const client = createRavenClient()
  let cancelled = 0
  let failed = 0
  for (const executionId of targets) {
    try {
      const outcome = await client.cancelExecution(executionId)
      if (outcome.cancelled) cancelled += 1
    } catch {
      // 取消失败不该影响其它取消：有的是来晚了（已终态），有的确实没发出去。
      // 区分它们不重要 —— 重要的是别因为一条失败就放弃剩下的。
      failed += 1
    }
  }
  return { cancelled, failed }
}

// ---------------------------------------------------------------------------
// 发现并注册
// ---------------------------------------------------------------------------

export type LoadRavenToolsResult = {
  /** 成功注册的工具数。 */
  registered: number
  /** 跳过（已注册）的数量。 */
  skipped: number
  /** raven 那边存在但未开放的工具。 */
  disabled: string[]
  /** 没连上时的原因。**不是错误** —— raven 没起不影响 runtime 启动。 */
  error: string | null
}

/**
 * 从 raven 拉工具清单并注册进 runtime 的 Tool Registry。
 *
 * ⚠️ **raven 不可用时不抛错。** 契约 §二只要求「没配模型就拒绝启动」；
 * raven 是一个**工具来源**，不是运行前提。让 runtime 因为 raven 没起而拒绝启动，
 * 等于把一个可选的依赖变成硬依赖 —— 而且这个失败会在每次重启时重复出现。
 */
export async function loadRavenTools(client: RavenClient = createRavenClient()): Promise<LoadRavenToolsResult> {
  const empty: LoadRavenToolsResult = { registered: 0, skipped: 0, disabled: [], error: null }

  if (!RAVEN_TOKEN()) {
    return { ...empty, error: '没有配置 RAVEN_GATEWAY_TOKEN，跳过 raven 工具加载。' }
  }

  let data: ListToolsData
  try {
    data = await client.listTools()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...empty, error: `连不上 raven（${RAVEN_URL()}）：${message}` }
  }

  let registered = 0
  let skipped = 0

  for (const definition of data.tools) {
    if (registeredNames.has(definition.name)) {
      skipped += 1
      continue
    }
    registeredNames.add(definition.name)

    tool({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: toZod(definition.inputSchema),
      risk: definition.risk,
      ...(definition.confirmationPhrase ? { confirmationPhrase: definition.confirmationPhrase } : {}),
      execute: async (input) => {
        const executionId = id('exe')
        inflight.set(executionId, { toolName: definition.name, startedAt: Date.now() })
        try {
          const result = await client.executeTool({
            toolName: definition.name,
            arguments: (input ?? {}) as Record<string, unknown>,
            executionId,
            ...(definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {}),
          })
          if (result.status === 'ok') return result.output
          // ⚠️ 错误要带着 raven 的原话抛出去 —— 模型能改的只有参数，
          // 而「参数 path 必须是非空字符串」是唯一对它有用的信息。
          throw new RavenToolError(
            result.error ?? {
              code: 'internal_error',
              message: `raven 执行 ${definition.name} 失败但没有说明原因。`,
              retryable: true,
            }
          )
        } finally {
          inflight.delete(executionId)
        }
      },
    })
    registered += 1
  }

  return { registered, skipped, disabled: data.disabled, error: null }
}

/** 验证脚本用：清空「已注册」记忆，让重复加载真的重新注册一遍。 */
export function resetRavenToolMemory(): void {
  registeredNames.clear()
  inflight.clear()
}
