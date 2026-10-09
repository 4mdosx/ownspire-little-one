import { z } from 'zod'
import type {
  AgentDriver,
  ChatMessage,
  DriverHooks,
  DriverRequest,
  EndpointConfig,
} from '../../src/protocol/driver.js'
import type { Emit } from '../../src/lib/sse.js'
import { tool } from '../../src/tools/registry.js'
import {
  createVercelAiDriver,
  normalizeError,
  type ModelFactory,
} from '../../src/drivers/vercel-ai/driver.js'

/**
 * # 测试组 B · Vercel AI Adapter
 *
 * **这些测试要用 SDK 官方的 mock**（`MockLanguageModelV3`），
 * 不是自己手写的假 provider ——
 * 2026-10-08 那次排查 `ai@7.0.70` 回归时，自写假 provider 与官方 mock
 * 行为不一致，害我以为是自己的问题。**官方 mock 才是对照组。**
 *
 * ## 怎么把 mock 塞进去
 *
 * 用 `createVercelAiDriver(() => mockModel)` 建一个注入版 Driver。
 * ⚠️ **不要把 mock 塞进 `request.model`** —— 那是 `ModelConfig`（纯数据），
 * 塞 SDK 对象进去得到的是 `model.id === undefined`，
 * 症状是 SDK 内部 `modelId.startsWith()` 崩在一个完全不相干的栈里。
 *
 * ## 验什么
 *
 * **翻译层的正确性** —— 协议层给的形状对不对、SDK 的坑有没有被兜住：
 *
 * 1. `ChatMessage[]` → SDK 消息（content 数组，不是 v5 的字段）
 * 2. **并行调用的 seq 按请求顺序**（SDK 用 Promise.all，完成顺序不保证）
 * 3. **`risk` → 审批配置**，且**必须用按名字的对象**（泛函运行时无效）
 * 4. 工具执行完 → `tool.completed` + `onToolResult`
 * 5. 错误归类（model / tool / invalid_tool_input）
 * 6. GLM 的 `thinking` / `reasoning_effort` 透传
 *
 * **不验什么**：事件契约（那是协议层测试的事）、落库（协议层的事）。
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
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`)
}

type MockStep = { type?: string; parts?: MockStep[]; finishReason?: string; [key: string]: unknown }

/** mock 收到的最后一次调用参数。用它验「模型到底收到了什么」。 */
type CapturedCall = { providerOptions?: Record<string, unknown>; [key: string]: unknown }
let lastCall: CapturedCall | null = null

/**
 * ⚠️ **用 SDK 官方的 MockLanguageModelV3。**
 *
 * 它与自写 provider 的差别在 2026-10-08 体现得很清楚：
 * 那个回归 bug 两者都不执行工具，而另一些行为差异两者不一致。
 * **官方 mock 是唯一可靠的对照组。**
 *
 * `doStream` 的入参被记到 `lastCall` —— GLM 的 `thinking` 那些参数
 * 只能在这里验（真验「模型收到没」要真 key，而形状错了的症状是 400）。
 */
async function officialMock(script: MockStep[]): Promise<unknown> {
  const { MockLanguageModelV3 } = (await import('ai/test')) as unknown as {
    MockLanguageModelV3: new (options: { doStream?: unknown }) => unknown
  }
  let turn = 0
  return new MockLanguageModelV3({
    doStream: async (options: CapturedCall) => {
      lastCall = options
      // ⚠️ 剧本用完就**自然收尾**，不要重复最后一步 ——
      // 重复会让循环空转到 maxSteps，真正的断言被 20 条重复事件淹掉。
      const step =
        script[turn++] ??
        ({
          parts: [
            { type: 'text-start', id: 'z' },
            { type: 'text-delta', id: 'z', delta: '（剧本结束）' },
            { type: 'text-end', id: 'z' },
          ],
          finishReason: 'stop',
        } as MockStep)
      return { stream: toStream(step) }
    },
  })
}

function toStream(step: MockStep): ReadableStream<never> {
  const parts: MockStep[] = [
    { type: 'stream-start', warnings: [] },
    ...(Array.isArray(step.parts) ? step.parts : [step]),
    ...(step.finishReason
      ? [
          {
            type: 'finish',
            finishReason: step.finishReason,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ]
      : []),
  ]
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as never)
      controller.close()
    },
  }) as never
}

const testTool = tool({
  name: 'echo',
  title: '回声',
  description: '回显文本',
  inputSchema: z.object({ text: z.string() }),
  risk: 'read',
  execute: async (input) => ({ text: input.text }),
})

const destructiveTool = tool({
  name: 'removeFile',
  title: '删除',
  description: '删除文件',
  inputSchema: z.object({ path: z.string() }),
  risk: 'destructive',
  confirmationPhrase: 'delete',
  execute: async () => ({ deleted: true }),
})

const ENDPOINT: EndpointConfig = {
  id: 'zhipu-chat',
  label: '智谱',
  protocol: 'openai-chat-completions',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  keyEnvVar: 'ZHIPU_TEST_KEY',
  // ⚠️ GLM 的 thinking 走这里。**用 `disabled` 是直接请求失败**，不是建议。
  extraBody: { thinking: { type: 'enabled' } },
}

function baseRequest(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    runId: 'run_b',
    endpoint: ENDPOINT,
    model: { id: 'glm-5.3', label: 'GLM-5.3', endpointId: 'zhipu-chat', reasoningEffort: 'high' },
    instructions: '测试',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [testTool, destructiveTool] as never,
    maxSteps: 20,
    ...overrides,
  }
}

/** 注入 mock 建一个 Driver。每组测试一个，避免串味。 */
function driverFor(model: unknown): AgentDriver {
  const factory: ModelFactory = () => model as ReturnType<ModelFactory>
  return createVercelAiDriver(factory)
}

function collector(): {
  events: { name: string; data: unknown }[]
  emit: Emit
  hooks: DriverHooks
  log: { calls: { callId: string; seq: number }[]; results: unknown[]; denials: unknown[] }
} {
  const events: { name: string; data: unknown }[] = []
  const log: { calls: { callId: string; seq: number }[]; results: unknown[]; denials: unknown[] } = {
    calls: [],
    results: [],
    denials: [],
  }
  const hooks: DriverHooks = {
    onToolCall: (e) => log.calls.push({ callId: e.callId, seq: e.seq }),
    onToolResult: (e) => log.results.push(e),
    onApprovalDenied: (e) => log.denials.push(e),
  }
  return {
    events,
    log,
    hooks,
    emit: ((event: { name: string; data: unknown }) => events.push(event)) as Emit,
  }
}

/** 剧本片段。复用它们，避免每组测试重写一遍 part 序列。 */
const script = {
  text: (delta: string): MockStep => ({
    parts: [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta },
      { type: 'text-end', id: 't' },
    ],
    finishReason: 'stop',
  }),
  destructiveCall: {
    parts: [
      { type: 'tool-input-start', id: 'd1', toolName: 'removeFile' },
      { type: 'tool-input-delta', id: 'd1', delta: '{"path":"a.txt"}' },
      { type: 'tool-input-end', id: 'd1' },
      { type: 'tool-call', toolCallId: 'd1', toolName: 'removeFile', input: '{"path":"a.txt"}' },
    ],
    finishReason: 'tool-calls',
  } as MockStep,
}

// ---------------------------------------------------------------------------

async function testToolExecution(): Promise<void> {
  console.log('\n[翻译 · 工具调用与执行]')

  const model = await officialMock([
    {
      parts: [
        { type: 'tool-input-start', id: 'c1', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'c1', delta: '{"text":"hi"}' },
        { type: 'tool-input-end', id: 'c1' },
        // ⚠️ input 必须是 **JSON 字符串** —— 类型声明写 unknown，
        // 但运行时会调 .trim()，发对象会炸。
        { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: '{"text":"hi"}' },
      ],
      finishReason: 'tool-calls',
    },
    {
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '好了' },
        { type: 'text-end', id: 't' },
      ],
      finishReason: 'stop',
    },
  ])

  const { events, emit, hooks } = collector()
  const result = await driverFor(model).run(baseRequest(), hooks, emit)

  const names = events.map((e) => e.name)
  check('tool.called 发出', names.includes('tool.called'), names)
  check('**工具真的执行了**（7.0.70 起的回归就是这一步不发生）', names.includes('tool.completed'), names)
  check('message.delta 发出', names.includes('message.delta'), names)
  check(
    'tool.called 在 tool.completed 之前',
    names.indexOf('tool.called') < names.indexOf('tool.completed'),
    names,
  )
  check('两轮循环（调工具 → 收尾）', result.steps === 2, result.steps)
  check('status 是 done', result.status === 'done', result.status)
  check('正文被拼出来', result.text.includes('好了'), result.text)
}

async function testParallelSeqOrder(): Promise<void> {
  console.log('\n[翻译 · 并行的 seq 顺序]')

  const model = await officialMock([
    {
      parts: [
        { type: 'tool-input-start', id: 'slow', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'slow', delta: '{"text":"A"}' },
        { type: 'tool-input-end', id: 'slow' },
        { type: 'tool-input-start', id: 'fast', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'fast', delta: '{"text":"B"}' },
        { type: 'tool-input-end', id: 'fast' },
        // ⚠️ **请求顺序**：slow 先请求，所以 seq=1。
        { type: 'tool-call', toolCallId: 'slow', toolName: 'echo', input: '{"text":"A"}' },
        { type: 'tool-call', toolCallId: 'fast', toolName: 'echo', input: '{"text":"B"}' },
      ],
      finishReason: 'tool-calls',
    },
  ])

  const { emit, hooks, log } = collector()
  await driverFor(model).run(baseRequest(), hooks, emit)

  const seqs = log.calls.map((c) => c.seq)
  const order = log.calls.map((c) => c.callId)
  check('两个调用都记了 seq', seqs.length === 2, seqs)
  check('**seq 按请求顺序递增**（不是完成顺序）', seqs.join(',') === '1,2', seqs)
  check('callId 顺序与请求一致', order.join(',') === 'slow,fast', order)
}

async function testApprovalConfig(): Promise<void> {
  console.log('\n[翻译 · 授权配置]')

  // destructive 工具：先发授权请求，等批准后才执行。
  const model = await officialMock([script.destructiveCall])

  const { events, emit, hooks } = collector()
  await driverFor(model).run(baseRequest(), hooks, emit)

  const names = events.map((e) => e.name)
  check('destructive 工具发授权请求', names.includes('approval.requested'), names)
  check(
    '**授权请求在工具执行之前**（顺序错了授权就形同虚设）',
    !names.includes('tool.completed') ||
      names.indexOf('approval.requested') < names.indexOf('tool.completed'),
    names,
  )

  const request = events.find((e) => e.name === 'approval.requested') as
    | { data: { risk?: string } }
    | undefined
  check('授权请求带 risk=destructive', request?.data.risk === 'destructive', request?.data)

  console.log('\n[翻译 · skipApproval]')
  // ⚠️ 必须用**新的 mock** —— 上面那个的剧本已经用完了，
  // 复用会得到「一步没跑」的假绿。
  const { events: e2, emit: emit2, hooks: h2 } = collector()
  await driverFor(await officialMock([script.destructiveCall])).run(
    baseRequest({ skipApproval: true }),
    h2,
    emit2,
  )
  const names2 = e2.map((e) => e.name)
  check('skipApproval 时工具直接执行', names2.includes('tool.completed'), names2)
  check('skipApproval 时不发授权请求', !names2.includes('approval.requested'), names2)
}

async function testMessageTranslation(): Promise<void> {
  console.log('\n[翻译 · 消息形状]')

  // ⚠️ **v7 用 content 数组**，不是 v5 的 {toolCalls, toolCallId} 字段。
  // 写错形状 → provider 报 400 且**不指出形状问题**。
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '看看目录' },
    {
      role: 'assistant',
      toolCalls: [{ toolCallId: 'c1', tool: 'echo', input: { text: 'hi' } }],
    },
    {
      role: 'tool',
      results: [{ toolCallId: 'c1', tool: 'echo', output: '{"text":"hi"}' }],
    },
    { role: 'user', content: '继续' },
  ]

  const model = await officialMock([
    {
      parts: [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '好' },
        { type: 'text-end', id: 't' },
      ],
      finishReason: 'stop',
    },
  ])

  const { emit, hooks } = collector()
  const result = await driverFor(model).run(baseRequest({ messages }), hooks, emit)
  check('带工具历史的消息被 SDK 接受', result.status === 'done', result.status)
  check('没抛 400 形状错误', result.text.length > 0, result.text)

  // 真验形状：mock 收到的 prompt 里，assistant 必须是 content 数组。
  const prompt = (lastCall as { prompt?: unknown[] } | null)?.prompt ?? []
  const assistantMsg = prompt.find((m) => (m as { role?: string }).role === 'assistant') as
    | { content?: { type?: string }[] }
    | undefined
  const toolMsg = prompt.find((m) => (m as { role?: string }).role === 'tool') as
    | { content?: { type?: string }[] }
    | undefined
  check('assistant 是 content 数组而不是 v5 字段', Array.isArray(assistantMsg?.content), assistantMsg)
  check(
    'content 里是 tool-call part',
    assistantMsg?.content?.some((p) => p.type === 'tool-call') === true,
    assistantMsg?.content,
  )
  check(
    'tool 消息的 part 是 tool-result',
    toolMsg?.content?.some((p) => p.type === 'tool-result') === true,
    toolMsg?.content,
  )
}

function testErrorClassification(): void {
  console.log('\n[翻译 · 错误归类]')
  check(
    '缺 key → model_error（**不是 internal_error**，否则用户以为 Runtime 崩了）',
    normalizeError(Object.assign(new Error('OpenAI API key is missing'), { name: 'LoadAPIKeyError' }))
      .code === 'model_error',
  )
  check(
    '入参不合法 → invalid_tool_input',
    normalizeError(Object.assign(new Error('bad input'), { name: 'AI_InvalidToolInputError' })).code ===
      'invalid_tool_input',
  )
  check(
    '已有 code 的原样透传',
    normalizeError(Object.assign(new Error('x'), { code: 'custom_code' })).code === 'custom_code',
  )
  check('别的归 internal_error', normalizeError(new Error('something odd')).code === 'internal_error')
  check(
    '429 → model_error（配额问题不该显示成崩了）',
    normalizeError(Object.assign(new Error('rate limited'), { statusCode: 429 })).code === 'model_error',
  )
}

async function testGlmProviderOptions(): Promise<void> {
  console.log('\n[翻译 · 厂商扩展参数的两档来源]')

  const model = await officialMock([script.text('好')])
  const { emit, hooks } = collector()
  await driverFor(model).run(baseRequest(), hooks, emit)

  // ⚠️ `providerOptions` 的键是 **provider 名**（openai），不是模型名。
  const openaiOptions = (lastCall?.providerOptions as { openai?: Record<string, unknown> } | undefined)
    ?.openai
  check('providerOptions.openai 存在', openaiOptions !== undefined, lastCall?.providerOptions)
  check(
    '**thinking.type = enabled**（GLM 漏了这个直接请求失败）',
    (openaiOptions?.thinking as { type?: string } | undefined)?.type === 'enabled',
    openaiOptions,
  )
  check(
    'reasoning_effort 显式带了 high（不落到默认的 max，那是最贵一档）',
    openaiOptions?.reasoning_effort === 'high',
    openaiOptions,
  )

  console.log('\n[翻译 · 安全网：没配 extraBody 也兜底]')
  // 端点没配 extraBody，但模型 id 是 glm- → 仍要带上 thinking。
  // 这是「忘记配库也不会炸」那道防线：GLM 漏了 thinking 是**请求失败**，不是降级。
  const bareEndpoint: EndpointConfig = { ...ENDPOINT, extraBody: undefined }
  const { emit: e2, hooks: h2 } = collector()
  await driverFor(await officialMock([script.text('好')])).run(
    baseRequest({ endpoint: bareEndpoint }),
    h2,
    e2,
  )
  const bare = (lastCall?.providerOptions as { openai?: Record<string, unknown> } | undefined)?.openai
  check('GLM 模型即使端点没配也带 thinking', (bare as { thinking?: unknown } | undefined)?.thinking !== undefined, bare)

  console.log('\n[翻译 · 不该发的就别发]')
  // 非 GLM 模型 + 没配 extraBody 的端点 → 一个扩展参数都不该有。
  // 发给不支持的厂商是 400，而 400 的文案通常指不到是哪个参数。
  const { emit: e3, hooks: h3 } = collector()
  await driverFor(await officialMock([script.text('好')])).run(
    baseRequest({
      endpoint: bareEndpoint,
      model: { id: 'deepseek-chat', label: 'DS', endpointId: 'zhipu-chat' },
    }),
    h3,
    e3,
  )
  const dsOptions = (lastCall?.providerOptions as { openai?: Record<string, unknown> } | undefined)
    ?.openai
  check('**非 GLM 模型不带 thinking**（按模型 id 判，不按 baseURL）', dsOptions?.thinking === undefined, dsOptions)
  check('也不带 reasoning_effort（没配就不发）', dsOptions?.reasoning_effort === undefined, dsOptions)
}

async function main(): Promise<void> {
  console.log('\n════ 测试组 B · Vercel AI Adapter ════')
  process.env.ZHIPU_TEST_KEY = 'test-key-not-real'

  await testToolExecution()
  await testParallelSeqOrder()
  await testApprovalConfig()
  await testMessageTranslation()
  testErrorClassification()
  await testGlmProviderOptions()

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  console.log('\n换成别家 SDK 时：协议层测试（组 A）不用改，只有这个文件重写。\n')
  if (failures > 0) process.exitCode = 1
}

void main()
