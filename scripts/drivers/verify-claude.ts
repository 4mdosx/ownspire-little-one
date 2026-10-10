import type { Options as SdkOptions, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDriver, DriverRequest, DriverResult } from '../../src/protocol/driver.js'
import type { AgentEvent } from '../../src/lib/sse.js'
import type { ToolDefinition } from '../../src/tools/registry.js'
import { z } from 'zod'
import { createClaudeDriver } from '../../src/drivers/claude/driver.js'

/**
 * # claude Driver 验证 · 假 query
 *
 * **不 spawn 真 claude-cli。** 验的是翻译层与治理桥：事件映射、双审批开关、
 * resume 锚、usage 归一化、状态映射 —— 这些与 SDK 版本无关的东西。
 * 真 CLI 的行为（能否 spawn、网关兼容性）属于阶段 0 实验的事。
 *
 * 跑法：`npm run verify:claude`
 */

let failures = 0
let assertions = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  assertions += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}`)
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`)
}

const collect = () => {
  const events: AgentEvent[] = []
  return { events, emit: (e: AgentEvent) => events.push(e) }
}

const businessTool: ToolDefinition = {
  name: 'clipboard.list',
  title: '剪切板列表',
  description: '读 raven 网关的剪切板。',
  inputSchema: z.object({ limit: z.number().optional() }),
  execute: async () => ({ items: [] }),
  risk: 'write',
}

/**
 * 假 query：按脚本吐消息，并把 options 暴露给断言。
 * 脚本用 unknown[] —— SDK 的 result 消息必填字段一大把（duration/cost/uuid），
 * 而翻译层只读其中几个；测试不去伺候 SDK 的类型面。
 */
function fakeQuery(script: unknown[], captured: { options?: SdkOptions }) {
  return (params: { prompt: string | AsyncIterable<unknown>; options?: SdkOptions }) => {
    captured.options = params.options
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const message of script) yield message as SDKMessage
    }
    return gen()
  }
}

const baseRequest = (overrides: Partial<DriverRequest> = {}): DriverRequest => ({
  runId: 'run_x',
  endpoint: {
    id: 'aaa',
    label: 'AAA',
    protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:5919',
    apiKey: 'sk-test',
  },
  model: { id: 'glm-5.3', label: 'GLM', endpointId: 'aaa' },
  messages: [{ role: 'user', content: '干活' }],
  tools: [businessTool as unknown as ToolDefinition<never>],
  maxSteps: 20,
  approvalSecret: 'secret-16-chars-min!!',
  ...overrides,
})

const hooks = () => ({
  onToolCall: () => {},
  onToolResult: () => {},
  onApprovalDenied: () => {},
})

async function runOnce(
  script: unknown[],
  request: DriverRequest,
  captured: { options?: SdkOptions },
): Promise<{ result: DriverResult; events: AgentEvent[] }> {
  const driver: AgentDriver = createClaudeDriver({ queryFn: fakeQuery(script, captured) })
  const { events, emit } = collect()
  const result = await driver.run(request, hooks(), emit)
  return { result, events }
}

const successResult = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  session_id: 'claude-ses-42',
  result: '完成了',
  is_error: false,
  num_turns: 2,
  modelUsage: { 'glm-5.3': { inputTokens: 100, outputTokens: 30 }, 'glm-5.3-mini': { inputTokens: 10, outputTokens: 5 } },
  ...extra,
})

async function main(): Promise<void> {
  console.log('\n════ claude Driver · 假 query ════')

  // ---- 1. 事件翻译 + usage 归一化 + 引擎会话锚 + spawn env ----
  {
    const script: unknown[] = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } },
      {
        type: 'assistant',
        session_id: 's-1',
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a' } }] },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        session_id: 's-1',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: [{ type: 'text', text: '内容' }] }],
        },
        parent_tool_use_id: null,
      },
      successResult(),
    ]
    const captured: { options?: SdkOptions } = {}
    const { result, events } = await runOnce(script, baseRequest(), captured)
    const names = events.map((e) => e.name)
    check('text_delta → message.delta', names.includes('message.delta'), names)
    check('tool_use → tool.called（原生工具原名）', events.some((e) => e.name === 'tool.called' && (e.data as any).tool === 'Read'), names)
    check('tool_result → tool.completed（ok: true）', events.some((e) => e.name === 'tool.completed' && (e.data as any).ok === true), names)
    check('modelUsage 求和 → usage 归一化', result.usage.inputTokens === 110 && result.usage.outputTokens === 35, result.usage)
    check('引擎会话锚带回（engineSessionId）', result.engineSessionId === 'claude-ses-42', result.engineSessionId)
    check('success → status done', result.status === 'done', result.status)
    check('resume 未设时 options 无 resume', (captured.options as any)?.resume === undefined, captured.options?.resume)
    check('maxSteps 映射为 maxTurns', captured.options?.maxTurns === 20, captured.options?.maxTurns)
    check('endpoint.baseUrl → ANTHROPIC_BASE_URL', (captured.options?.env as any)?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:5919')
    check('endpoint.apiKey → ANTHROPIC_AUTH_TOKEN', (captured.options?.env as any)?.ANTHROPIC_AUTH_TOKEN === 'sk-test')
    check('业务工具挂成进程内 MCP server', 'ownspire' in (captured.options?.mcpServers ?? {}), Object.keys(captured.options?.mcpServers ?? {}))
  }

  // ---- 2. 业务工具自动通过（businessApproval=false）→ 事件对带 auto ----
  {
    const captured: { options?: SdkOptions } = {}
    const driver: AgentDriver = createClaudeDriver({ queryFn: fakeQuery([successResult()], captured) })
    const { events, emit } = collect()
    await driver.run(baseRequest({ businessApproval: false }), hooks(), emit)
    const canUseTool = (captured.options as any).canUseTool
    const decision = await canUseTool('mcp__ownspire__clipboard_list', { limit: 5 }, { signal: new AbortController().signal })
    check('开关关 → 业务工具自动放行', decision.behavior === 'allow', decision)
    const requested = events.find((e) => e.name === 'approval.requested')
    const resolved = events.find((e) => e.name === 'approval.resolved')
    check('自动通过也发 requested（原名 clipboard.list）', requested !== undefined && (requested.data as any).tool === 'clipboard.list', requested?.data)
    check('resolved 带 auto: true', resolved !== undefined && (resolved.data as any).auto === true, resolved?.data)
    check(
      'requested 带签名 approvalId',
      typeof (requested?.data as any)?.approvalId === 'string' && (requested?.data as any).approvalId.startsWith('apr_'),
      requested?.data,
    )
  }

  // ---- 3. 需要审批：deny 收场 → 下轮签名消费 ----
  {
    const captured: { options?: SdkOptions } = {}
    const driver: AgentDriver = createClaudeDriver({ queryFn: fakeQuery([successResult()], captured) })
    const { events, emit } = collect()
    await driver.run(baseRequest({ businessApproval: true }), hooks(), emit)
    const canUseTool = (captured.options as any).canUseTool
    const decision = await canUseTool('mcp__ownspire__clipboard_list', { limit: 5 }, { signal: new AbortController().signal })
    check('开关开 → 本轮 deny（决策走下一条消息）', decision.behavior === 'deny', decision)
    const requested = events.find((e) => e.name === 'approval.requested') as any
    check('发 approval.requested 带 approvalId', typeof requested?.data?.approvalId === 'string', requested)

    // 下轮：带批准结论 resume → 同一入参放行 + 补发 resolved（不带 auto）
    const approvalId = requested.data.approvalId
    const captured2: { options?: SdkOptions } = {}
    const driver2: AgentDriver = createClaudeDriver({ queryFn: fakeQuery([successResult()], captured2) })
    const events2: AgentEvent[] = []
    await driver2.run(
      baseRequest({
        businessApproval: true,
        engineSessionId: 'claude-ses-42',
        approvalResponses: [{ approvalId, approved: true }],
      }),
      hooks(),
      (e) => events2.push(e),
    )
    check('resume 锚传回 SDK', (captured2.options as any)?.resume === 'claude-ses-42', captured2.options?.resume)
    const canUseTool2 = (captured2.options as any).canUseTool
    const decision2 = await canUseTool2('mcp__ownspire__clipboard_list', { limit: 5 }, { signal: new AbortController().signal })
    check('签名匹配的批准 → allow', decision2.behavior === 'allow', decision2)
    const resolved2 = events2.find((e) => e.name === 'approval.resolved') as any
    check('消费批准补发 resolved（无 auto）', resolved2 !== undefined && resolved2.auto === undefined, resolved2)

    // 篡改入参 → 签名不匹配 → 仍然 deny（契约 §五「审批不可被伪造」）
    const decision3 = await canUseTool2('mcp__ownspire__clipboard_list', { limit: 9999 }, { signal: new AbortController().signal })
    check('入参被篡改 → 签名不匹配 → deny', decision3.behavior === 'deny', decision3)
  }

  // ---- 4. 拒绝结论 → denied 状态 ----
  {
    const script: unknown[] = [successResult({ result: '不删了' })]
    // 先跑一轮并触发 canUseTool,拿到待批事件的合法 approvalId（HMAC 绑定工具与入参）
    const captured0: { options?: SdkOptions } = {}
    const driver0: AgentDriver = createClaudeDriver({ queryFn: fakeQuery(script, captured0) })
    const events0: AgentEvent[] = []
    await driver0.run(baseRequest(), hooks(), (e) => events0.push(e))
    const canUseTool0 = (captured0.options as any).canUseTool
    await canUseTool0('mcp__ownspire__clipboard_list', { limit: 5 }, { signal: new AbortController().signal })
    const requestedId = (events0.find((e) => e.name === 'approval.requested') as any)?.data?.approvalId
    check('待批事件携带 approvalId', typeof requestedId === 'string' && requestedId.startsWith('apr_'), requestedId)

    // 带拒绝结论重跑：canUseTool 消费拒绝 → 再次 deny，run 收成 denied
    const captured3: { options?: SdkOptions } = {}
    const driver3: AgentDriver = createClaudeDriver({ queryFn: fakeQuery(script, captured3) })
    const events3: AgentEvent[] = []
    const result3 = await driver3.run(
      baseRequest({ approvalResponses: [{ approvalId: requestedId, approved: false }] }),
      hooks(),
      (e) => events3.push(e),
    )
    const canUseTool3 = (captured3.options as any).canUseTool
    const decision = await canUseTool3('mcp__ownspire__clipboard_list', { limit: 5 }, { signal: new AbortController().signal })
    check('拒绝结论消费 → deny', decision.behavior === 'deny', decision)
    // ⚠️ Driver 层不自行改状态：deny 已经给到模型，收尾状态由 turn 层按
    // 「有拒绝结论 + done → denied」提升（引擎无关）。Driver 只负责消费结论。
    check('拒绝消费后 Driver 照常收尾（提升在 turn 层）', result3.status === 'done', result3.status)
    const resolved3 = events3.find((e) => e.name === 'approval.resolved') as any
    check('补发 resolved(approved: false)', resolved3 !== undefined && resolved3.data.approved === false, resolved3)
  }

  // ---- 5. max turns → stopped ----
  {
    const script: unknown[] = [
      { type: 'result', subtype: 'error_max_turns', session_id: 's', result: '', is_error: false, num_turns: 20, modelUsage: {} },
    ]
    const captured: { options?: SdkOptions } = {}
    const { result } = await runOnce(script, baseRequest(), captured)
    check('error_max_turns → stopped（不是错误）', result.status === 'stopped', result.status)
  }

  // ---- 6. resume 语义：只送新增消息 ----
  {
    let prompt = ''
    const driver: AgentDriver = createClaudeDriver({
      queryFn: (params) => {
        prompt = String(params.prompt)
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield successResult() as unknown as SDKMessage
        }
        return gen()
      },
    })
    await driver.run(
      baseRequest({
        messages: [
          { role: 'user', content: '第一条' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '第二条' },
        ],
      }),
      hooks(),
      () => {},
    )
    check('prompt 只含最后一条 assistant 之后的新增消息', prompt === '第二条', JSON.stringify(prompt))
  }

  // ---- 7. HTTP MCP 模式（businessToolMcpUrl）----
  {
    const captured: { options?: SdkOptions } = {}
    const driver: AgentDriver = createClaudeDriver({ queryFn: fakeQuery([successResult()], captured) })
    await driver.run(
      baseRequest({ businessToolMcpUrl: 'http://127.0.0.1:5800/api/agent/mcp' }),
      hooks(),
      () => {},
    )
    const mcp = (captured.options?.mcpServers ?? {}) as Record<string, any>
    check('HTTP 模式挂 raven 端点', mcp.raven?.type === 'http' && mcp.raven?.url === 'http://127.0.0.1:5800/api/agent/mcp', Object.keys(mcp))
    check('HTTP 模式鉴权头用共享 token', mcp.raven?.headers?.Authorization === 'Bearer secret-16-chars-min!!', mcp.raven?.headers)
    check('HTTP 模式不再进程内包装', mcp.ownspire === undefined, Object.keys(mcp))
    const canUseTool = captured.options?.canUseTool as any
    const decision = await canUseTool('mcp__raven__clipboard_list', { limit: 1 }, { signal: new AbortController().signal })
    check('raven 前缀走业务审批桥（缺省需批准 → deny）', decision.behavior === 'deny', decision)
  }

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  if (failures > 0) process.exitCode = 1
}

void main()
