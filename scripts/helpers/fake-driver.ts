import type {
  AgentDriver,
  DriverHooks,
  DriverRequest,
  DriverResult,
  EndpointConfig,
} from '../../src/protocol/driver.js'
import type { Emit } from '../../src/lib/sse.js'
import type { StoredToolCall } from '../../src/protocol/turn.js'

/**
 * 假 Driver。**测试组 A（协议层）专用，完全不碰任何 SDK。**
 *
 * ## 为什么要有它
 *
 * 协议层的编排语义（授权拦阻、事件顺序、落库调用、错误归类）
 * **不该依赖 SDK 才能测**。有了它，测协议层就是纯内存操作 ——
 * 毫秒级、不需要 key、不受 SDK 版本影响。
 *
 * 这也是「Adapter 换了协议层测试不用改」的具体兑现：
 * **换 SDK 时这个文件一行都不用动。**
 *
 * ## 剧本机制
 *
 * `script` 是驱动器要按剧本吐的事件序列。协议层只管把这些事件
 * 翻译成自己该有的行为，所以剧本能精确控制「Adapter 在第几步做了什么」。
 */

export type ScriptStep =
  | { kind: 'text'; text: string }
  /** ⚠️ `seq` 可省 —— 省了就按剧本顺序算，省得测试里手填一串数字。 */
  | { kind: 'tool-call'; callId: string; tool: string; input: unknown; seq?: number }
  | { kind: 'approval-request'; callId: string; tool: string; input: unknown; reason?: string }
  | { kind: 'approval-response'; callId: string; tool: string; approved: boolean }
  | { kind: 'tool-result'; callId: string; tool: string; output: unknown }
  | { kind: 'tool-error'; callId: string; tool: string; error: string }
  /** 抛错。用来验错误归类。 */
  | { kind: 'throw'; code: string; message: string }

export type FakeDriverOptions = {
  script: ScriptStep[]
  /**
   * 返回的 status。**默认按剧本推断** —— 出现未批准的审批响应就是 `denied`。
   * 不让调用方手填，是因为「填错 status」会让授权测试变得毫无意义
   *（测的是测试数据，不是协议层的行为）。
   */
  status?: DriverResult['status']
}

/** 记录 Driver 收到的东西，断言用。 */
export type DriverLog = {
  requests: DriverRequest[]
  toolCalls: { callId: string; tool: string; input: unknown; seq: number }[]
  toolResults: { callId: string; tool: string; ok: boolean; durationMs: number }[]
  approvalsDenied: { callId: string; tool: string }[]
}

export function createFakeDriver(options: FakeDriverOptions): { driver: AgentDriver; log: DriverLog } {
  const log: DriverLog = { requests: [], toolCalls: [], toolResults: [], approvalsDenied: [] }
  let stepIndex = 0

  const driver: AgentDriver = {
    handles: 'fake-protocol',

    async run(request: DriverRequest, hooks: DriverHooks, emit: Emit): Promise<DriverResult> {
      log.requests.push(request)
      emit({ name: 'run.started', data: { runId: request.runId, sessionId: 'sess', startedAt: 1 } })

      let text = ''
      /** 有过被拒绝的审批 → status 必须是 denied。 */
      let sawDenial = false
      for (const step of options.script) {
        switch (step.kind) {
          case 'text':
            text += step.text
            emit({ name: 'message.delta', data: { runId: request.runId, text: step.text } })
            break

          case 'tool-call': {
            const seq = step.seq ?? log.toolCalls.length + 1
            log.toolCalls.push({ callId: step.callId, tool: step.tool, input: step.input, seq })
            hooks.onToolCall({
              callId: step.callId,
              tool: step.tool,
              input: step.input,
              seq,
            })
            emit({
              name: 'tool.called',
              data: { runId: request.runId, callId: step.callId, tool: step.tool, input: step.input },
            })
            break
          }

          case 'approval-request':
            emit({
              name: 'approval.requested',
              data: {
                runId: request.runId,
                callId: step.callId,
                tool: step.tool,
                input: step.input,
                risk: 'destructive',
                ...(step.reason ? { reason: step.reason } : {}),
              },
            })
            break

          case 'approval-response':
            if (!step.approved) {
              sawDenial = true
              log.approvalsDenied.push({ callId: step.callId, tool: step.tool })
              hooks.onApprovalDenied({ callId: step.callId, tool: step.tool })
            }
            emit({
              name: 'approval.resolved',
              data: { runId: request.runId, callId: step.callId, approved: step.approved },
            })
            break

          case 'tool-result':
            log.toolResults.push({
              callId: step.callId,
              tool: step.tool,
              ok: true,
              durationMs: 10,
            })
            hooks.onToolResult({
              callId: step.callId,
              tool: step.tool,
              ok: true,
              output: step.output,
              durationMs: 10,
            })
            emit({
              name: 'tool.completed',
              data: {
                runId: request.runId,
                callId: step.callId,
                tool: step.tool,
                ok: true,
                output: step.output,
                durationMs: 10,
              },
            })
            break

          case 'tool-error':
            log.toolResults.push({
              callId: step.callId,
              tool: step.tool,
              ok: false,
              durationMs: 10,
            })
            hooks.onToolResult({
              callId: step.callId,
              tool: step.tool,
              ok: false,
              output: { error: step.error },
              durationMs: 10,
            })
            emit({
              name: 'tool.completed',
              data: {
                runId: request.runId,
                callId: step.callId,
                tool: step.tool,
                ok: false,
                output: { error: step.error },
                durationMs: 10,
              },
            })
            break

          case 'throw':
            throw Object.assign(new Error(step.message), { code: step.code })
        }
      }

      stepIndex += 1
      const status = options.status ?? (sawDenial ? 'denied' : 'done')

      emit({
        name: 'run.completed',
        data: { runId: request.runId, status, steps: options.script.length, usage: { inputTokens: 0, outputTokens: 0 } },
      })
      return {
        status,
        steps: options.script.length,
        usage: { inputTokens: 0, outputTokens: 0 },
        text,
      }
    },
  }

  return { driver, log }
}

/** 测试用的假 store。**只实现协议层用到的方法**，其余抛「不该被调用」。 */
export function createFakeStore(overrides: Partial<import('../../src/protocol/turn.js').TurnStore> = {}): {
  store: import('../../src/protocol/turn.js').TurnStore
  calls: string[]
} {
  const calls: string[] = []
  const record = (name: string) => {
    calls.push(name)
  }

  const base: import('../../src/protocol/turn.js').TurnStore = {
    findSession(sessionId) {
      record('findSession')
      return {
        id: sessionId,
        instructions: null,
        tools: JSON.stringify([{ name: 'echo', risk: 'read' }]),
        engine: 'little-one',
        endpointId: null,
        modelId: null,
        engineSessionId: null,
        sandboxApproval: false,
        businessApproval: true,
      }
    },
    hasRunningRun() {
      record('hasRunningRun')
      return false
    },
    appendMessage() {
      record('appendMessage')
    },
    recentMessages() {
      record('recentMessages')
      return []
    },
    recentToolCalls(): StoredToolCall[] {
      record('recentToolCalls')
      return []
    },
    recordToolCall() {
      record('recordToolCall')
    },
    startRun() {
      record('startRun')
      return { id: 'run_fake' }
    },
    finishRun() {
      record('finishRun')
    },
    touchSession() {
      record('touchSession')
    },
    resolveEndpoint() {
      record('resolveEndpoint')
      return { id: 'fake', label: 'fake', protocol: FAKE_PROTOCOL }
    },
    resolveModel() {
      record('resolveModel')
      return { id: 'fake-model', label: 'Fake', endpointId: 'fake' }
    },
    recordUsage() {
      record('recordUsage')
    },
    usageTotals() {
      return { inputTokens: 0, outputTokens: 0 }
    },
    budgetLimit() {
      return null
    },
    setEngineSession() {
      record('setEngineSession')
    },
  }

  return { store: { ...base, ...overrides }, calls }
}

/**
 * 假 Driver 声明的协议。**故意不是一个真实协议** —— 这样「这组测试跑的是假
 * Driver」在代码里就看得出来：真 Driver 永远不会 handles 它，
 * 所以万一注册表被装错了，查不到 Driver 会立刻炸而不是静默用真的。
 *
 * ⚠️ 这个 `as` 是测试代码里唯一允许的类型断言：协议层的 `ProtocolFamily`
 * 是生产概念，不该为了测试往里加一个 'fake'。
 */
export const FAKE_PROTOCOL = 'fake-protocol' as EndpointConfig['protocol']

export const TEST_ENDPOINT: EndpointConfig = {
  id: 'fake',
  label: 'Fake',
  protocol: FAKE_PROTOCOL,
}