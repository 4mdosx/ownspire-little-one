import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  createSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
  type Options as SdkOptions,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentDriver,
  ChatMessage,
  DriverHooks,
  DriverRequest,
  DriverResult,
} from '../../protocol/driver.js'
import type { Emit } from '../../lib/sse.js'
import type { Risk, ToolDefinition } from '../../tools/registry.js'
import { toJsonSchema } from '../../tools/registry.js'
import { magpieApiKey, magpieOrigin } from '../../upstream.js'
import { jsonSchemaToShape } from './json-schema-to-shape.js'

/**
 * # claude 引擎 Driver —— 把沙箱里的 claude-cli 嫁接进 little-one 的契约
 *
 * ## 定位（契约 §六「多引擎」）
 *
 * claude-cli 是**另一个 loop 引擎**，不是工具：循环、上下文工程、原生工具
 * （Bash/Edit/Read…）都是它的。raven 不复刻工作区能力；本 Driver 只做三件事：
 *
 * 1. **事件翻译**：SDK 消息流 → 本项目 SSE 契约。归一化的锚是契约，
 *    raven 前端不知道背后换了引擎。
 * 2. **治理桥**：双审批开关（§五）通过 `canUseTool` 落地 —— 业务工具走
 *    businessApproval，引擎原生工具走 sandboxApproval；自动通过也发事件对
 *    （auto: true），审计落在 events 表。**需要审批的操作本轮以 deny 收场**
 *    （决策走下一条消息，§五 既定形状）；批准/拒绝的结论在下一轮 resume 时
 *    经 `approvalResponses` 消费 —— 签名匹配的放行并补发 resolved，
 *    被拒的再次 deny 并把 run 收成 `status: "denied"`。
 * 3. **上游是 Magpie**：spawn 时 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 *    指向本机网关。claude-cli 说 Messages，Magpie 再译到真正的厂商。
 *    端点表上的厂商地址和 key 不进环境变量。
 *
 * ## resume 语义
 *
 * claude 侧自己持有完整历史，每轮只送**新增**的 user 消息（新指令 + 审批结论）；
 * 重放全部历史等于把上下文灌两遍。引擎会话锚经 `DriverResult.engineSessionId`
 * 返回，turn 层落库，下轮经 `DriverRequest.engineSessionId` 传回。
 *
 * ## 依赖说明
 *
 * `@anthropic-ai/claude-agent-sdk` 的 peer 写的是 zod ^4，但实际 import 的是
 * `zod/v4` 子路径 —— 项目根的 zod 3.25.x 自带同一子路径，功能上满足。
 * 安装用 `--legacy-peer-deps`，理由在此存档。**升级 SDK 或 zod 时这里先验。**
 */

/**
 * query 的最小结构面：driver 只迭代消息。SDK 的 `Query` 还带 interrupt /
 * setModel 等控制面 —— 那是它的能力,不是本 Driver 的依赖,
 * 收窄成 AsyncIterable 让假实现不必伺候 SDK 的控制面。
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>
  options?: SdkOptions
}) => AsyncIterable<SDKMessage>

export type ClaudeDriverDeps = {
  /** 测试注入假 query。生产用 SDK 的。 */
  queryFn?: QueryFn
}

/** `claude --version` 能跑通才注册（drivers/index.ts）。CLI 不在时引擎不可用。 */
export function isClaudeCliAvailable(): boolean {
  try {
    return spawnSync('claude', ['--version'], { timeout: 5_000 }).status === 0
  } catch {
    return false
  }
}

/**
 * 引擎原生工具的风险表（§五）。**未知工具按 write 保守处理。**
 * 业务工具（mcp__ownspire__*）不用这张表 —— risk 由工具定义自己声明。
 */
const NATIVE_RISK: Record<string, Risk> = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', TodoWrite: 'read',
  WebFetch: 'read', WebSearch: 'read', Task: 'read', BashOutput: 'read',
  Write: 'write', Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'destructive', KillShell: 'destructive',
}

const BUSINESS_SERVER = 'ownspire'
const BUSINESS_PREFIX = `mcp__${BUSINESS_SERVER}__`
/** HTTP 模式下 raven 的 mcpServers 键名 → claude 侧工具前缀。 */
const HTTP_BUSINESS_PREFIX = 'mcp__raven__'

function nativeRisk(toolName: string): Risk {
  return NATIVE_RISK[toolName] ?? 'write'
}

/** 稳定字符串化：键排序，HMAC 才能对同一入参算出同一 approvalId。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function approvalIdOf(secret: string, toolName: string, input: unknown): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${toolName}\n${stableStringify(input)}`)
    .digest('hex')
  return `apr_${digest.slice(0, 24)}`
}

export function createClaudeDriver(deps: ClaudeDriverDeps = {}): AgentDriver {
  const queryFn = deps.queryFn ?? sdkQuery

  return {
    handles: 'claude',

    async run(request: DriverRequest, hooks: DriverHooks, emit: Emit): Promise<DriverResult> {
      // ---- 业务工具的两种来源（契约 §六「多引擎」）--------------------------
      //
      // HTTP 模式（businessToolMcpUrl 设了）：claude 直连 raven 的 MCP 端点，
      // 执行彻底离开本进程；进程内模式（缺省）：本 Driver 包装成 SDK MCP server，
      // 经 little-one 的 raven 客户端转发 —— token 半径最小。
      // 两种模式审批桥一致：工具都带 mcp 前缀，businessApproval 照常判。
      const businessBySdkName = new Map<string, ToolDefinition<never>>()
      for (const definition of request.tools) {
        // MCP 工具名不允许「.」，业务名里的点做替换；事件里仍发原始名（契约 §一）。
        // raven 的 MCP 端点用同一套替换（backstage/lib/mcp.ts），两边对得上。
        const sdkName = definition.name.replace(/[^a-zA-Z0-9_-]/g, '_')
        const prefix = request.businessToolMcpUrl ? HTTP_BUSINESS_PREFIX : BUSINESS_PREFIX
        businessBySdkName.set(`${prefix}${sdkName}`, definition)
      }
      const sdkTools =
        request.businessToolMcpUrl
          ? []
          : request.tools.map((definition) => {
              const sdkName = definition.name.replace(/[^a-zA-Z0-9_-]/g, '_')
              return sdkTool(
                sdkName,
                definition.description,
                jsonSchemaToShape(toJsonSchema(definition.inputSchema)),
                async (args) => {
                  const output = await definition.execute(args as never)
                  return { content: [{ type: 'text' as const, text: JSON.stringify(output ?? null) }] }
                },
              )
            })

      // ---- 上一轮的审批结论：本轮 resume 时消费 ---------------------------
      const grants = new Map<string, boolean>()
      for (const response of request.approvalResponses ?? []) {
        grants.set(response.approvalId, response.approved)
      }

      const announced = new Set<string>()
      const callIdName = new Map<string, string>()
      const lastCallIdByTool = new Map<string, string>()
      const startedAt = new Map<string, number>()
      let seqCounter = 0
      let denied = false
      let streamedAnyDelta = false

      const announce = (callId: string, tool: string, input: unknown): void => {
        if (announced.has(callId)) return
        announced.add(callId)
        callIdName.set(callId, tool)
        startedAt.set(callId, Date.now())
        seqCounter += 1
        hooks.onToolCall({ callId, tool, input, seq: seqCounter })
        emit({ name: 'tool.called', data: { runId: request.runId, callId, tool, input } })
      }

      const riskOf = (toolName: string): Risk => {
        const business = businessBySdkName.get(toolName)
        return business ? business.risk : nativeRisk(toolName)
      }

      // ---- canUseTool：治理桥（§五）--------------------------------------
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
      ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => {
        const risk = riskOf(toolName)
        // read 永远静默放行（对齐 little-one 的 not-applicable：没有审批机器）。
        if (risk === 'read') return { behavior: 'allow' }

        const isBusiness = toolName.startsWith(BUSINESS_PREFIX) || toolName.startsWith(HTTP_BUSINESS_PREFIX)
        const needsApproval = isBusiness
          ? request.businessApproval !== false
          : request.sandboxApproval === true
        const originalName = businessBySdkName.get(toolName)?.name ?? toolName

        // callId 关联：assistant 消息通常先到（已 announce）；
        // canUseTool 抢先时用临时 id 占位 announce，assistant 到达后靠去重不重发。
        let callId = lastCallIdByTool.get(toolName)
        if (callId === undefined || !announced.has(callId)) {
          callId = `tmp_${crypto.randomUUID().slice(0, 12)}`
          announce(callId, originalName, input)
        }
        const approvalId = approvalIdOf(request.approvalSecret ?? '', originalName, input)

        const granted = grants.get(approvalId)
        if (granted !== undefined) {
          if (granted) {
            emit({ name: 'approval.resolved', data: { runId: request.runId, callId, approved: true } })
            return { behavior: 'allow' }
          }
          denied = true
          emit({ name: 'approval.resolved', data: { runId: request.runId, callId, approved: false } })
          return {
            behavior: 'deny',
            message: '用户已经拒绝了这个操作。不要重试，向用户说明情况并给出替代方案，然后收尾。',
          }
        }

        if (!needsApproval) {
          // 开关放行：**事件对照发**（auto: true）—— 审批卡片逻辑一套、审计完整（§五）。
          emit({
            name: 'approval.requested',
            data: { runId: request.runId, callId, tool: originalName, input, risk, approvalId },
          })
          emit({
            name: 'approval.resolved',
            data: { runId: request.runId, callId, approved: true, auto: true },
          })
          return { behavior: 'allow' }
        }

        // 需要审批：本轮以 deny 收场，决策走下一条消息（§五 的既定形状）。
        emit({
          name: 'approval.requested',
          data: { runId: request.runId, callId, tool: originalName, input, risk, approvalId },
        })
        return {
          behavior: 'deny',
          message:
            '这个操作需要用户批准,批准结论会在下一轮给出。本轮不要重试这个调用；' +
            '请向用户说明你想做什么,然后收尾。',
        }
      }

      // ---- spawn env：claude-cli 说 Messages，地址是 Magpie ----------------
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') env[key] = value
      }
      const gatewayKey = magpieApiKey()
      env.ANTHROPIC_BASE_URL = magpieOrigin()
      env.ANTHROPIC_AUTH_TOKEN = gatewayKey
      env.ANTHROPIC_API_KEY = gatewayKey
      env.ANTHROPIC_MODEL = request.modelId

      const abortController = new AbortController()
      if (request.signal) {
        if (request.signal.aborted) abortController.abort()
        else request.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }

      const options: SdkOptions = {
        ...(request.engineSessionId ? { resume: request.engineSessionId } : {}),
        maxTurns: request.maxSteps,
        abortController,
        canUseTool,
        env,
        // 业务工具来源二选一：进程内 SDK server（缺省）或 raven 的 MCP HTTP 端点。
        // HTTP 模式的鉴权用 approvalSecret —— 它就是共享的 AGENT_RUNTIME_TOKEN,
        // raven 的 MCP 端点认的正是这一把（两把尺是刻意的,见两边路由头注释）。
        ...((sdkTools.length > 0 || request.businessToolMcpUrl)
          ? {
              mcpServers: {
                ...(sdkTools.length > 0
                  ? { [BUSINESS_SERVER]: createSdkMcpServer({ name: BUSINESS_SERVER, tools: sdkTools }) }
                  : {}),
                ...(request.businessToolMcpUrl
                  ? {
                      raven: {
                        type: 'http' as const,
                        url: request.businessToolMcpUrl,
                        headers: { Authorization: `Bearer ${request.approvalSecret ?? ''}` },
                      },
                    }
                  : {}),
              },
            }
          : {}),
        // 系统提示：claude_code 预设 + 会话指令追加。不要裸字符串覆盖 ——
        // 那会把 Claude Code 的工具编排提示整个丢掉，引擎就只剩个壳。
        ...(request.instructions
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: request.instructions } }
          : { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const } }),
      }

      // ---- 事件翻译循环 ---------------------------------------------------
      let text = ''
      let usage = { inputTokens: 0, outputTokens: 0 }
      let sessionId: string | undefined
      let endSubtype = 'success'

      const consume = (async () => {
        for await (const message of queryFn({ prompt: buildPrompt(request.messages), options }) as AsyncIterable<SDKMessage>) {
          switch (message.type) {
            case 'stream_event': {
              streamedAnyDelta = true
              const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
              if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
                emit({ name: 'message.delta', data: { runId: request.runId, text: event.delta.text } })
              }
              break
            }
            case 'assistant': {
              const blocks = (message as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []
              for (const block of blocks) {
                if (block.type === 'tool_use') {
                  const originalName = businessBySdkName.get(String(block.name))?.name ?? String(block.name)
                  announce(String(block.id), originalName, block.input)
                  lastCallIdByTool.set(String(block.name), String(block.id))
                }
                // 正文增量的职责在 stream_event；partial 流缺席时才整块兜底
                // （某些兼容网关不给 partial，一条 delta 总比黑屏强）。
                if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 && !streamedAnyDelta) {
                  emit({ name: 'message.delta', data: { runId: request.runId, text: block.text } })
                }
              }
              break
            }
            case 'user': {
              const content = (message as { message?: { content?: Array<Record<string, unknown>> } }).message?.content
              if (!Array.isArray(content)) break
              for (const block of content) {
                if (block.type !== 'tool_result') continue
                const callId = String(block.tool_use_id ?? '')
                const isError = block.is_error === true
                const durationMs = Date.now() - (startedAt.get(callId) ?? Date.now())
                const output = extractToolOutput(block.content)
                hooks.onToolResult({ callId, tool: callIdName.get(callId) ?? callId, ok: !isError, output, durationMs })
                emit({
                  name: 'tool.completed',
                  data: { runId: request.runId, callId, tool: callIdName.get(callId) ?? callId, ok: !isError, output, durationMs },
                })
              }
              break
            }
            case 'result': {
              const result = message as unknown as Record<string, unknown>
              sessionId = typeof result.session_id === 'string' ? result.session_id : undefined
              endSubtype = String(result.subtype ?? 'success')
              text = String(result.result ?? '')
              usage = sumModelUsage(result.modelUsage)
              break
            }
            default:
              // SDK 会加新消息类型 —— 不知道的东西不炸（与 vercel driver 同一纪律）。
              break
          }
        }
      })()

      // abort 竞态：SDK 的流在取消时可能抛 AbortError，也可能静默结束 ——
      // 两者都视为取消，由下方 status 判定统一收口。败者的 rejection 必须接住，
      // 否则是进程级 unhandledRejection。
      const abortError = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener(
          'abort',
          () => reject(new Error('The operation was aborted')),
          { once: true },
        )
      })
      const guarded = consume.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const outcome = await Promise.race([guarded, abortError.then(() => ({ ok: true as const }))])
      if (outcome.ok === false) throw outcome.error

      const status: DriverResult['status'] =
        request.signal?.aborted
          ? 'cancelled'
          : endSubtype === 'error_max_turns'
            ? 'stopped'
            : denied
              ? 'denied'
              : 'done'

      return {
        status,
        steps: seqCounter,
        usage,
        text,
        ...(sessionId ? { engineSessionId: sessionId } : {}),
      }
    },
  }
}

/**
 * resume 语义下只送**新增**消息：最后一条 assistant 之后的全部 user 内容
 * （新指令 + 审批结论），join 成一个 prompt。历史在 claude 侧的会话里，
 * 重放全部历史等于把上下文灌两遍。
 */
function buildPrompt(messages: ChatMessage[]): string {
  let lastAssistant = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role === 'assistant') lastAssistant = i
  }
  const suffix = messages.slice(lastAssistant + 1).flatMap((m) => (m.role === 'user' ? [m.content] : []))
  if (suffix.length === 0) {
    // 没有新 user 消息（理论不可达：发消息必有 content 或审批结论）——
    // 给一句空转提示让模型收尾，而不是把整个历史当 prompt。
    return '（没有新的用户输入。请总结当前状态并收尾。）'
  }
  return suffix.filter((t) => t !== '').join('\n\n')
}

function extractToolOutput(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join('\n')
  }
  return content ?? null
}

function sumModelUsage(modelUsage: unknown): { inputTokens: number; outputTokens: number } {
  if (typeof modelUsage !== 'object' || modelUsage === null) return { inputTokens: 0, outputTokens: 0 }
  let input = 0
  let output = 0
  for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as { inputTokens?: unknown; outputTokens?: unknown }
    input += typeof row.inputTokens === 'number' ? row.inputTokens : 0
    output += typeof row.outputTokens === 'number' ? row.outputTokens : 0
  }
  return { inputTokens: input, outputTokens: output }
}
