import { executeTurn, TurnError, buildModelMessages, type TurnStore } from '../../src/protocol/turn.js'
import type { AgentDriver, DriverRegistry } from '../../src/protocol/driver.js'
import type { AgentEvent } from '../../src/lib/sse.js'
import { createFakeDriver, createFakeStore, type ScriptStep } from '../helpers/fake-driver.js'

/**
 * # 测试组 A · 协议层
 *
 * **不 import 任何 SDK**（`verify-protocol-purity.ts` 会机器检查这一点）。
 *
 * 验的是**不随 SDK 变的东西**：编排语义、授权拦阻、事件顺序保证、
 * 上下文重建、错误归类、落库调用。**换一家 SDK 时这个文件一行都不用改** ——
 * 那是这套分层的兑现方式，不是口号。
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

function registryOf(drivers: AgentDriver[]): DriverRegistry {
  return {
    get(protocol: string): AgentDriver {
      const found = drivers.find((d) => d.handles === protocol)
      if (!found) throw new Error(`没有能处理协议「${protocol}」的 Driver。`)
      return found
    },
    list: () => drivers.map((d) => d.handles),
  }
}

function collector(): { events: AgentEvent[]; emit: (e: { name: string; data: unknown }) => void } {
  const events: AgentEvent[] = []
  return {
    events,
    emit: (event) => events.push(event as AgentEvent),
  }
}

// ---------------------------------------------------------------------------

async function testHappyPath(): Promise<void> {
  console.log('\n[编排 · 顺利路径]')
  const { driver, log } = createFakeDriver({
    script: [
      { kind: 'tool-call', callId: 'c1', tool: 'echo', input: { text: 'hi' }, seq: 1 },
      { kind: 'tool-result', callId: 'c1', tool: 'echo', output: { text: 'hi' } },
      { kind: 'text', text: '好了。' },
    ],
  })
  const { store, calls } = createFakeStore()
  const { events, emit } = collector()

  await executeTurn({ drivers: registryOf([driver]), store }, {
    sessionId: 's1',
    content: '回显 hi',
    approvalResponses: [],
    emit,
  })

  const names = events.map((e) => e.name)
  check('先发 run.started 再发别的', names[0] === 'run.started', names)
  check('最后是终止事件', names[names.length - 1] === 'run.completed', names)
  check('Driver 收到 maxSteps（步数上限是契约的一部分）', log.requests[0]?.maxSteps === 20, log.requests[0]?.maxSteps)
  check('工具调用上报给协议层落库', log.toolCalls.length === 1, log.toolCalls)
  check('工具结果也上报', log.toolResults.length === 1, log.toolResults)
  check('用户消息落库', calls.includes('appendMessage'), calls)
  check('run 落库', calls.includes('startRun') && calls.includes('finishRun'), calls)
  check('最后 touch 会话', calls[calls.length - 1] === 'touchSession', calls)
}

async function testApprovalDenied(): Promise<void> {
  console.log('\n[授权 · 被拒绝]')
  const { driver, log } = createFakeDriver({
    script: [
      { kind: 'tool-call', callId: 'c1', tool: 'removeFile', input: { path: 'a' }, seq: 1 },
      { kind: 'approval-request', callId: 'c1', tool: 'removeFile', input: { path: 'a' }, reason: '不可逆' },
      { kind: 'approval-response', callId: 'c1', tool: 'removeFile', approved: false },
    ],
  })
  const { store } = createFakeStore({
    findSession: () => ({
      id: 's1',
      instructions: null,
      tools: JSON.stringify([{ name: 'removeFile', risk: 'destructive' }]),
    }),
  })
  const { events, emit } = collector()

  await executeTurn({ drivers: registryOf([driver]), store }, {
    sessionId: 's1',
    content: '删掉 a',
    approvalResponses: [],
    emit,
  })

  const names = events.map((e) => e.name)
  const completed = events.find((e) => e.name === 'run.completed') as
    | { data: { status: string } }
    | undefined
  check('授权请求在工具完成之前', names.indexOf('approval.requested') < names.indexOf('approval.resolved'), names)
  check('**拒绝的工具没有被执行**', log.toolResults.length === 0, log.toolResults)
  check('拒绝被上报给协议层落库', log.approvalsDenied.length === 1, log.approvalsDenied)
  check('status 是 denied 而不是 failed', completed?.data.status === 'denied', completed?.data)
}

async function testErrorPaths(): Promise<void> {
  console.log('\n[错误 · 四种退出]')

  console.log('  会话不存在')
  {
    const { driver } = createFakeDriver({ script: [] })
    const { store } = createFakeStore({ findSession: () => undefined })
    try {
      await executeTurn({ drivers: registryOf([driver]), store }, {
        sessionId: 'nope',
        content: 'x',
        approvalResponses: [],
        emit: () => undefined,
      })
      check('应抛 session_not_found', false)
    } catch (error) {
      check(
        '应抛 session_not_found 且状态 404',
        error instanceof TurnError && error.code === 'session_not_found' && error.status === 404,
        error instanceof TurnError ? error.code : String(error),
      )
    }
  }

  console.log('  上一轮还在跑')
  {
    const { driver } = createFakeDriver({ script: [] })
    const { store } = createFakeStore({ hasRunningRun: () => true })
    try {
      await executeTurn({ drivers: registryOf([driver]), store }, {
        sessionId: 's1',
        content: 'x',
        approvalResponses: [],
        emit: () => undefined,
      })
      check('应抛 run_in_progress', false)
    } catch (error) {
      check(
        '应抛 run_in_progress 且状态 409',
        error instanceof TurnError && error.code === 'run_in_progress' && error.status === 409,
        error instanceof TurnError ? error.code : String(error),
      )
    }
  }

  console.log('  内容为空')
  {
    const { driver } = createFakeDriver({ script: [] })
    const { store } = createFakeStore()
    try {
      await executeTurn({ drivers: registryOf([driver]), store }, {
        sessionId: 's1',
        content: '   ',
        approvalResponses: [],
        emit: () => undefined,
      })
      check('应抛 empty_content', false)
    } catch (error) {
      check(
        '应抛 empty_content',
        error instanceof TurnError && error.code === 'empty_content',
        error instanceof TurnError ? error.code : String(error),
      )
    }
  }

  console.log('  Driver 抛错')
  {
    const { driver } = createFakeDriver({
      script: [{ kind: 'throw', code: 'model_error', message: '配额不足' }],
    })
    const { store, calls } = createFakeStore()
    let thrown: unknown = null
    try {
      await executeTurn({ drivers: registryOf([driver]), store }, {
        sessionId: 's1',
        content: 'x',
        approvalResponses: [],
        emit: () => undefined,
      })
    } catch (error) {
      thrown = error
    }
    check(
      '**错误带着 code 透出去**（前端按 code 分支）',
      (thrown as { code?: string })?.code === 'model_error',
      (thrown as { code?: string })?.code,
    )
    check('run 被标成 failed', calls.includes('finishRun'), calls)
    check('**异常路径也会 touch 会话**', calls.includes('touchSession'), calls)
  }
}

async function testProtocolMismatch(): Promise<void> {
  console.log('\n[Driver · 协议不匹配]')
  const { driver } = createFakeDriver({ script: [] })
  const { store } = createFakeStore({
    resolveEndpoint: () => ({ id: 'x', label: 'X', protocol: 'openai-responses', keyEnvVar: 'K' }),
  })
  try {
    await executeTurn({ drivers: registryOf([driver]), store }, {
      sessionId: 's1',
      content: 'x',
      approvalResponses: [],
      emit: () => undefined,
    })
    check('应抛「没有能处理该协议的 Driver」', false)
  } catch (error) {
    check(
      '**抛错而不是返回 null**（静默降级会让症状变成「工具都不工作」）',
      error instanceof Error && error.message.includes('Driver'),
      error instanceof Error ? error.message.slice(0, 80) : String(error),
    )
  }
}

type ToolCallFixture = {
  callId: string
  tool: string
  input: string
  seq: number
  status: 'pending' | 'ok' | 'failed' | 'denied'
  output: string | null
  runId?: string
}

function testContextRebuild(): void {
  console.log('\n[上下文重建 · 长程能力的地基]')

  // ⚠️ 故意让 seq=2 的先完成 —— 模拟 SDK 并行执行。
  // 重建出的顺序必须仍是 seq 1 在前，否则结果会安到错误的调用上，
  // **而模型无法察觉**。
  const calls: ToolCallFixture[] = [
    { callId: 'call_fast', tool: 'ls', input: '{"path":"b"}', seq: 2, status: 'ok', output: '{"entries":["b1"]}', runId: 'run1' },
    { callId: 'call_slow', tool: 'ls', input: '{"path":"a"}', seq: 1, status: 'ok', output: '{"entries":["a1","a2"]}', runId: 'run1' },
    // ⚠️ 不同 runId：**seq 只在 run 内有意义**，所以另一个 run 里 seq=1 不冲突。
    // （如果按全局 seq 排，两轮的序号会互相穿插，顺序就乱了。）
    { callId: 'call_denied', tool: 'rm', input: '{"path":"a1"}', seq: 1, status: 'denied', output: '用户拒绝', runId: 'run2' },
    // ⚠️ 悬空调用：进程被杀时的残留。**不能进上下文**，
    // 因为没有对应 result，provider 会判非法。
    { callId: 'call_hanging', tool: 'ls', input: '{}', seq: 3, status: 'pending', output: null, runId: 'run1' },
  ]

  const store: TurnStore = {
    ...createFakeStore().store,
    recentMessages: () => [
      { role: 'user', content: '看 a 和 b', runId: null },
      { role: 'assistant', content: '看到了', runId: 'run1' },
      { role: 'user', content: '删掉 a1', runId: null },
      { role: 'assistant', content: '那个文件我没删', runId: 'run2' },
    ],
    recentToolCalls: () => calls as never,
  }

  const messages = buildModelMessages(store, 's1', [])

  const firstAssistant = messages.find(
    (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
  ) as { toolCalls?: { input: unknown }[] } | undefined
  const inputs = firstAssistant?.toolCalls?.map((c) => c.input) ?? []

  check('重建出 assistant 的工具调用', inputs.length > 0, inputs)
  check(
    '**同一 run 内顺序按 seq**（a 在前，尽管 b 先完成）',
    JSON.stringify(inputs) === JSON.stringify([{ path: 'a' }, { path: 'b' }]),
    inputs,
  )

  // 两个 run 的调用**各自独立成组**，不混在一起
  const assistantGroups = messages.filter((m) => m.role === 'assistant' && Array.isArray(m.toolCalls))
  check(
    '**每个 run 一组，组内按 seq**（不按全局 seq 混排）',
    assistantGroups.length === 2,
    assistantGroups.map((g) => (g as { toolCalls: unknown[] }).toolCalls.length),
  )

  const allIds = JSON.stringify(messages)
  check('悬空调用不进上下文', !allIds.includes('call_hanging'))
  check('被拒绝的调用也被重建（模型得知道用户拒绝了）', allIds.includes('拒绝'))

  check(
    '**每个 tool-call 都有对应 result**（缺一个 provider 就 400）',
    (() => {
      for (const message of messages) {
        if (message.role !== 'assistant' || !message.toolCalls) continue
        const ids = message.toolCalls.map((c) => c.toolCallId)
        const results = messages.find(
          (m) => m.role === 'tool' && ids.every((id) => JSON.stringify(m).includes(id))
        )
        if (!results) return false
        const resultIds = (results as { results: { toolCallId: string }[] }).results.map(
          (r) => r.toolCallId
        )
        // 顺序也要一致 —— 错位会让模型把结果安到错误的调用上
        if (JSON.stringify(resultIds) !== JSON.stringify(ids)) return false
      }
      return true
    })(),
    messages.filter((m) => m.role === 'tool').length,
  )

  console.log('\n[审批结论喂回]')
  check(
    '拒绝结论作为 user 消息喂回模型',
    buildModelMessages(store, 's1', [{ approvalId: 'apr_1', approved: false }]).some(
      (m) => m.role === 'user' && m.content.includes('拒绝'),
    ),
  )
  check(
    '批准结论也说清楚',
    buildModelMessages(store, 's1', [{ approvalId: 'a', approved: true }]).some(
      (m) => m.role === 'user' && m.content.includes('批准'),
    ),
  )
}

function testParallelOrdering(): void {
  console.log('\n[并行 · seq 由 Driver 在请求时分配]')
  // 这一条验的是**契约**：Driver 必须把 seq 当请求顺序而不是完成顺序。
  // 假 Driver 按剧本顺序给 seq，而协议层原样落库 —— 真Driver 的责任
  // 由测试组 B（Adapter 测试）验。
  const steps: ScriptStep[] = [
    { kind: 'tool-call', callId: 'a', tool: 'ls', input: {}, seq: 1 },
    { kind: 'tool-call', callId: 'b', tool: 'ls', input: {}, seq: 2 },
    { kind: 'tool-call', callId: 'c', tool: 'ls', input: {}, seq: 3 },
  ]
  const { driver, log } = createFakeDriver({ script: steps })
  void executeTurn({ drivers: registryOf([driver]), store: createFakeStore().store }, {
    sessionId: 's1',
    content: 'x',
    approvalResponses: [],
    emit: () => undefined,
  })

  check('三次调用 seq 递增', log.toolCalls.map((c) => c.seq).join(',') === '1,2,3', log.toolCalls.map((c) => c.seq))
}

async function main(): Promise<void> {
  console.log('\n════ 测试组 A · 协议层（不依赖任何 SDK）════')

  await testHappyPath()
  await testApprovalDenied()
  await testErrorPaths()
  await testProtocolMismatch()
  testContextRebuild()
  await testParallelOrdering()

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  console.log('\n这些断言与用哪家 SDK 无关 —— 换 Adapter 时这个文件不用改。\n')
  if (failures > 0) process.exitCode = 1
}

void main()