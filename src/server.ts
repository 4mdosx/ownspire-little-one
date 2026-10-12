import http from 'node:http'
import { CONTRACT_VERSION, port, requireToken, version } from './config/env.js'
import { ensureSchema, pingDatabase } from './db/database.js'
import {
  countRuns,
  countSessions,
  createSession,
  deleteSession,
  findRun,
  findSession,
  hasRunningRun,
  listMessages,
  listSessions,
  reconcileInterruptedRuns,
} from './db/sessions.js'
import { HttpError, Router, readJson, requireAuth, sendError, sendJson } from './lib/http.js'
import { id } from './lib/ids.js'
import {
  cancelInflightRun,
  isInflightRun,
  registerInflightRun,
  releaseInflightRun,
} from './lib/run-registry.js'
import { closeChannel, subscribe, type BusEvent } from './lib/event-bus.js'
import { createAgentStream, encodeFrame } from './lib/sse.js'
import { listEvents, saveEvent } from './db/events.js'
import { budgetLimit, setBudgetLimit, usageByModel, usageTotals } from './db/usage.js'
import { runningRunId } from './db/sessions.js'
import { executeTurn, TurnError, type ApprovalResponseInput } from './protocol/turn.js'
import { requireMagpieModel } from './upstream.js'
import { drivers } from './drivers/index.js'
import { store } from './db/store.js'
import { toolCatalog, toolNames, resolveTools, UnknownToolError } from './tools/registry.js'
import { loadRavenTools } from './tools/raven.js'
import './tools/builtin.js'

/**
 * HTTP 层。**每一个路由都在实现 docs/01-contract.md 的一节。**
 *
 * `/healthz` 免鉴权 —— infra 的 deploy 与 navi 的同一套健康检查要在无凭据环境下工作。
 * 它只返回 ok / version / counts，**不返回任何路径与密钥**。
 */
export function buildRouter(token: string): Router {
  const router = new Router()

  // ---- 健康检查（免鉴权）-----------------------------------------------------

  router.get('/healthz', ({ res }) => {
    let databaseOk = true
    let sessions = 0
    let runs = 0
    try {
      pingDatabase()
      sessions = countSessions()
      runs = countRuns()
    } catch {
      databaseOk = false
    }
    sendJson(res, databaseOk ? 200 : 503, {
      ok: databaseOk,
      version: version(),
      contractVersion: CONTRACT_VERSION,
      sessions,
      runs,
      running: databaseOk ? countRuns('running') : 0,
      tools: toolNames().length,
    })
  })

  // ---- 枚举（鉴权）----------------------------------------------------------

  router.get('/api/tools', ({ req, res }) => {
    requireAuth(req, token)
    sendJson(res, 200, { tools: toolCatalog() })
  })

  router.get('/api/config', ({ req, res }) => {
    requireAuth(req, token)
    sendJson(res, 200, {
      budget: { limit: budgetLimit() },
    })
  })

  /** token 预算上限。null = 不设防。检查点在 run 启动前（409 budget_exhausted）。 */
  router.put('/api/config/budget', async ({ req, res }) => {
    requireAuth(req, token)
    const body = await readJson<{ limit?: unknown }>(req)
    if (body.limit !== null && (typeof body.limit !== 'number' || !Number.isFinite(body.limit) || body.limit < 0)) {
      throw new HttpError(400, 'invalid_config', 'limit 必须是非负数字或 null（不设防）。')
    }
    setBudgetLimit(body.limit as number | null)
    sendJson(res, 200, { budget: { limit: budgetLimit() } })
  })

  /** 用量统计（契约 §六）。按厂商/模型分组；不换算成钱 —— 那是库外的事。 */
  router.get('/api/usage', ({ req, res }) => {
    requireAuth(req, token)
    const totals = usageTotals()
    const limit = budgetLimit()
    sendJson(res, 200, {
      totals,
      byModel: usageByModel(),
      budget: { limit, used: totals.inputTokens + totals.outputTokens },
    })
  })

  // ---- 会话（契约 §三）------------------------------------------------------

  router.post('/api/sessions', async ({ req, res }) => {
    requireAuth(req, token)
    const body = await readJson<{
      title?: string
      instructions?: string
      tools?: string[]
      engine?: string
      sandboxApproval?: boolean
      businessApproval?: boolean
    }>(req)

    const requested = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : toolNames()
    const unknown = requested.filter((name) => !toolNames().includes(name))
    // 未知工具名 → 400，不静默丢弃。静默丢弃会让「模型用了没注册的工具」
    // 变成一句看不出来的空响应。
    if (unknown.length > 0) {
      throw new HttpError(400, 'unknown_tool', `未知工具：${unknown.join(', ')}`)
    }

    // 引擎白名单（契约 §三）。claude 引擎还没接线时也允许建会话 ——
    // 发消息时才会拿到 409 engine_not_available（那时才需要沙箱就绪）。
    const engine = body.engine ?? 'little-one'
    if (engine !== 'little-one' && engine !== 'claude') {
      throw new HttpError(400, 'invalid_engine', `未知引擎：${engine}（可选 little-one / claude）`)
    }

    const title =
      typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : '新会话'
    const session = createSession({
      title,
      ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
      tools: requested,
      engine,
      ...(typeof body.sandboxApproval === 'boolean' ? { sandboxApproval: body.sandboxApproval } : {}),
      ...(typeof body.businessApproval === 'boolean' ? { businessApproval: body.businessApproval } : {}),
    })

    sendJson(res, 201, {
      sessionId: session.id,
      title: session.title,
      createdAt: session.createdAt,
      tools: JSON.parse(session.tools) as string[],
      engine: session.engine,
      sandboxApproval: session.sandboxApproval,
      businessApproval: session.businessApproval,
    })
  })

  router.get('/api/sessions', ({ req, res }) => {
    requireAuth(req, token)
    sendJson(res, 200, {
      sessions: listSessions().map((row) => ({
        sessionId: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        runCount: row.runCount,
        messageCount: row.messageCount,
        engine: row.engine,
        runningRunId: row.runningRunId,
      })),
    })
  })

  router.get('/api/sessions/:sessionId', ({ req, res, params }) => {
    requireAuth(req, token)
    const session = findSession(params.sessionId!)
    if (!session) throw new HttpError(404, 'session_not_found', '会话不存在。')
    sendJson(res, 200, {
      sessionId: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      instructions: session.instructions,
      tools: JSON.parse(session.tools) as string[],
      // 断线重连（契约 §六）：回来的页面靠它决定「显示进行中」还是「刷新历史」。
      // 轮询这个字段直到变 null —— 事件回放走 GET …/runs/:runId/stream。
      runningRunId: runningRunId(session.id),
      engine: session.engine,
      sandboxApproval: session.sandboxApproval,
      businessApproval: session.businessApproval,
      messages: listMessages(session.id).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        runId: row.runId,
        createdAt: row.createdAt,
      })),
    })
  })

  router.delete('/api/sessions/:sessionId', ({ req, res, params }) => {
    requireAuth(req, token)
    const result = deleteSession(params.sessionId!)
    if (!result) throw new HttpError(404, 'session_not_found', '会话不存在。')
    // 带计数是给 UI 的回执：别让一次误点变成没有回执的抹除。
    sendJson(res, 200, {
      deleted: true,
      sessionId: params.sessionId,
      messages: result.messages,
      runs: result.runs,
    })
  })

  // ---- 发消息（契约 §三 + §四，唯一流式接口）-------------------------------

  router.post('/api/sessions/:sessionId/messages', async ({ req, res, params }) => {
    requireAuth(req, token)
    const sessionId = params.sessionId!

    const body = await readJson<{
      content?: string
      approvalResponses?: ApprovalResponseInput[]
    }>(req)

    const content = typeof body.content === 'string' ? body.content : ''
    const approvals = Array.isArray(body.approvalResponses)
      ? body.approvalResponses.filter(
          (item): item is ApprovalResponseInput =>
            typeof item?.approvalId === 'string' && typeof item?.approved === 'boolean',
        )
      : []

    // ⚠️ 这里是全文件唯一的顺序要求：
    // **先校验，再开流。** 流一旦开始，响应头就发出去了，状态码改不了
    //（契约 §四 规则一）。所以 404 / 400 / 409 必须发生在 createAgentStream 之前，
    // 由这里直接转成真正的 4xx。
    const session = findSession(sessionId)
    if (!session) {
      sendError(res, new HttpError(404, 'session_not_found', '会话不存在。'))
      return
    }
    // 409 必须在这里判（契约 §三 的状态码表）：进了流它就只能变成
    // run.failed 事件了 —— 那会把「上一轮还在跑」显示成一个错误，
    // 而契约里它是「请求与状态冲突」，前端该弹提示而不是重试。
    if (hasRunningRun(sessionId)) {
      sendError(res, new HttpError(409, 'run_in_progress', '这个会话还有一轮在跑。'))
      return
    }
    // 引擎未接线同理必须在开流前判（契约 §三）：进了流它就只能变成
    // run.failed，而「沙箱没就绪」是请求与状态冲突，不是 run 的失败。
    if (session.engine === 'claude' && !drivers.list().includes('claude')) {
      sendError(res, new HttpError(409, 'engine_not_available', 'claude 引擎尚未接线：沙箱里没装 claude-cli，或 drivers 注册表里没有 handles 为 claude 的 Driver。'))
      return
    }
    // 预算闸同理（契约 §六）：「预算用尽」是请求与状态冲突，必须在开流前
    // 给真 409。turn.ts 里还留了一份防御（协议层直跑时生效）。
    const budget = budgetLimit()
    if (budget !== null) {
      const used = usageTotals()
      if (used.inputTokens + used.outputTokens >= budget) {
        sendError(res, new HttpError(
          409,
          'budget_exhausted',
          `token 预算已用尽：累计 ${used.inputTokens + used.outputTokens} / 上限 ${budget}。去 raven 的配置目录调整或清除上限。`,
        ))
        return
      }
    }
    if (content.trim() === '' && approvals.length === 0) {
      sendError(res, new HttpError(400, 'empty_content', 'content 不能为空。'))
      return
    }

    // ⚠️ **工具在这里解析，不在协议层。** registry 是组装层的依赖，
    // 与 drivers 的注入同理 —— 协议层测试不必建真注册表。
    //
    // 跨版本恢复的裁定（契约 §六）：会话创建时工具名已校验并冻结，
    // 但 little-one 升级后 registry 里可能已经没有某个名字。
    // **历史是无条件重放的**（已记录的调用是事实，不是能力），
    // 所以缺了的工具**跳过并警告**，不 400、不拒跑 ——
    // 否则一次升级会把所有旧会话变成不可用。
    const wanted = JSON.parse(session.tools) as string[]
    const missing = wanted.filter((name) => !toolNames().includes(name))
    if (missing.length > 0) {
      console.warn(
        `[agent] 会话 ${sessionId} 里的工具已不在注册表，跳过：${missing.join(', ')}` +
          '（会话创建后工具被移除；历史调用照常重放。）',
      )
    }
    const tools = resolveTools(wanted.filter((name) => !missing.includes(name)))

    // runId 的唯一真相：先在这里生成（id() 排序友好），SSE 的 run.started、
    // 库里的 runs 行、取消接口全都用它 —— 此前 SSE 与 DB 各生成各的，
    // raven 按 runId 关联事件，对不上就是两份真相。
    const runId = id('run')
    const startedAt = Date.now()

    // 取消要递到「正在跑的那一轮」手里，能中断的只有内存里的 AbortController
    // —— 开流前注册，流收尾（含异常）释放，成对出现。
    const controller = new AbortController()
    registerInflightRun(runId, controller)

    try {
      const response = createAgentStream(
        (emit) =>
          executeTurn(
            // ⚠️ deps 显式传进来，不在协议层里 import 具体实现 ——
            // 这样协议层的测试能传假 Driver 与假 store。
            { drivers, store, modelId: requireMagpieModel() },
            {
              sessionId,
              content,
              approvalResponses: approvals,
              emit,
              runId,
              signal: controller.signal,
              tools,
              approvalSecret: token,
              // claude 引擎业务工具的来源（契约 §六）。设 RAVEN_MCP_URL 即切换到
              // raven 的 MCP HTTP 端点；不设 = 进程内包装（缺省）。
              ...(process.env.RAVEN_MCP_URL?.trim()
                ? { businessToolMcpUrl: process.env.RAVEN_MCP_URL.trim() }
                : {}),
            },
          ),
        {
          runId,
          sessionId,
          startedAt,
          engine: session.engine,
          // 事件流是事实源（契约 §六）：每个事件落 events 表，断线重连靠它回放。
          record: (seq, event) => saveEvent({ runId, sessionId, seq, name: event.name, data: event.data }),
        },
      )

      res.writeHead(response.status, Object.fromEntries(response.headers))
      const body_ = response.body
      if (body_) {
        const reader = (body_ as ReadableStream<Uint8Array>).getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
        } catch {
          // 客户端断开。createAgentStream 的 cancel 已经处理了计时器，
          // 而 executeTurn 会把 run 落库 —— 这里不能抛。
        }
      }
      res.end()
    } finally {
      releaseInflightRun(runId)
      // seq 计数与订阅者随 primary 流一起销毁 —— 不清的话 Map 随 uptime 生长。
      closeChannel(runId)
    }
  })

  // ---- 断线重连（契约 §六，2026-10-09 加法）------------------------------
  //
  // 回放 + 续流：先吐库里 after 之后的事件（seq 走 SSE 的 id: 行），再挂到
  // 事件总线续流到终止事件。run 已结束（或被标记 interrupted）时只回放 ——
  // 回放里没有终止事件且流关闭，按契约 §四 的兜底语义显示「异常中断」
  // （interrupted 的权威信号在会话详情的 runningRunId 上）。
  //
  // ⚠️ **这里刻意不走 createAgentStream**：那条路的 emit 是 primary 发布者
  // （分配 seq、推给总线），重连流是订阅者，回放必须用库里已存的 seq 原样写帧。
  router.get('/api/sessions/:sessionId/runs/:runId/stream', ({ req, res, params, query }) => {
    requireAuth(req, token)
    const sessionId = params.sessionId!
    const runId = requireId(params.runId)

    const run = findRun(runId)
    if (!run || run.sessionId !== sessionId) {
      throw new HttpError(404, 'run_not_found', `会话 ${sessionId} 下没有这轮 run：${runId}`)
    }
    const after = Number.parseInt(query.get('after') ?? '0', 10) || 0

    // ⚠️ **先订阅，再查库**，回放后按 seq 去重 —— 否则「查库之后、订阅之前」
    // 落地的事件既不在回放里也不在续流里，恰好丢掉客户端最关心的那几条。
    const pending: BusEvent[] = []
    let live = false
    const unsubscribe = subscribe(runId, (event) => {
      if (live) pending.push(event)
    })
    live = true

    const replayed = listEvents(runId, after)
    const seen = new Set(replayed.map((row) => row.seq))

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let closed = false
    const send = (name: string, data: unknown, seq: number): void => {
      if (closed) return
      try {
        res.write(encodeFrame(name, data, seq))
      } catch {
        closed = true
      }
    }
    const isTerminal = (name: string): boolean => name === 'run.completed' || name === 'run.failed'
    // ⚠️ 定时器必须在 cleanup 之前建：回放是同步的不会触发 tick，
    // 但 cleanup 若在声明前被调用会踩 TDZ，直接炸掉这次响应。
    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n')
    }, 15_000)
    const drain = setInterval(() => {
      for (const event of pending.splice(0)) {
        if (seen.has(event.seq)) continue
        seen.add(event.seq)
        send(event.name, event.data, event.seq)
        if (isTerminal(event.name)) {
          cleanup()
          return
        }
      }
    }, 50)
    const cleanup = (): void => {
      unsubscribe()
      clearInterval(keepalive)
      clearInterval(drain)
      if (!closed) {
        closed = true
        res.end()
      }
    }

    for (const row of replayed) {
      send(row.name, JSON.parse(row.data) as unknown, row.seq)
      if (isTerminal(row.name)) {
        cleanup()
        return
      }
    }

    // run 已不在途：回放即全部。终止事件要么在上面已返回，
    // 要么根本没写进日志（进程死于半途）—— 流关闭即是兜底信号。
    if (!isInflightRun(runId)) {
      cleanup()
      return
    }

    // 在途：续流。pending 里是「订阅之后、回放快照之前」的窗口事件，去重补吐。
    res.on('close', cleanup)
  })

  // ---- 取消一轮（契约 §三，2026-10-09 加法）--------------------------------
  //
  // 加法不升版本（§八）：新端点、`run.completed` 新增 `status: "cancelled"`，
  // 老 raven 未读到时按未知字段忽略即可。
  //
  // ⚠️ **200 只是「信号已递到」的回执，不是「已停」的回执。**
  // 真正的结论是流上的终止事件（`run.completed`，status: "cancelled"），
  // 以及库里的 runs 行 —— SSE 是尽力而为的展示通道，最终结论以数据库为准。
  router.post('/api/sessions/:sessionId/runs/:runId/cancel', ({ req, res, params }) => {
    requireAuth(req, token)
    const sessionId = params.sessionId!
    const runId = requireId(params.runId)

    // runId 必须真的属于这个会话：拿别人的 runId 来取消，不能只因为
    // 「id 存在」就成功 —— 那会让 404 的语义变得不可信。
    const run = findRun(runId)
    if (!run || run.sessionId !== sessionId) {
      throw new HttpError(404, 'run_not_found', `会话 ${sessionId} 下没有这轮 run：${runId}`)
    }
    // 不在本进程在途 = 已经结束 / 已被标记 interrupted / 跨进程留下的历史行。
    // 这三类有一个共同点：**没有可以中断的东西**。这是「请求与状态冲突」，
    // 必须是 409 而不是 500 —— raven 拿到 409 才知道该刷新那一轮的状态，
    // 拿到 500 只会显示「稍后重试」。
    if (!isInflightRun(runId)) {
      throw new HttpError(409, 'run_not_running', `这一轮已经结束（${run.status}），没有可取消的东西。`)
    }

    cancelInflightRun(runId)
    sendJson(res, 200, { cancelling: true, runId, sessionId })
  })

  return router
}

/**
 * 路径里的 id。空串或带斜杠的一律拒 —— 它们在 SQL 与文件路径里的含义都不干净。
 *
 * ⚠️ 参数类型是 `string | undefined`：`params` 是 `Record<string, string>`，
 * 而 tsconfig 开了 `noUncheckedIndexedAccess`，所以索引访问可能是 undefined。
 * 与其到处写 `params.id ?? ''`，不如在这里把「缺参数」当成非法 id 处理 ——
 * 它本来就该被拒。
 */
function requireId(raw: string | undefined): string {
  const id = (raw ?? '').trim()
  if (id === '' || id.includes('/')) {
    throw new HttpError(400, 'invalid_id', `非法的 id：${JSON.stringify(raw ?? '')}`)
  }
  return id
}

/** 启动前检查。`ensureSchema` 幂等，撞到旧表直接抛错不自动搬数据。 */
/**
 * 把 Router 接成 Node 的 request listener。
 *
 * ⚠️ **导出来是为了让验证脚本走同一份接线** —— 之前这段内联在 `startServer` 里，
 * 于是 `scripts/protocol/verify-config-api.ts` 只能自己拼一个 listener，
 * 而拼错的那次症状是「请求发出去没响应、脚本挂到超时」——
 * 一个看起来像测试环境问题、实际是接线写错的问题。
 * 同一份接线有两次实现时，第二次一定会走偏。
 */
export function createRequestListener(router: Router): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    const matched = router.match(req.method ?? 'GET', url.pathname)
    if (!matched) {
      sendJson(res, 404, { code: 'not_found', error: `没有这个接口：${url.pathname}` })
      return
    }

    // ⚠️ handler 可能是同步函数（鉴权就在最前面，是同步 throw）。
    // 所以必须用 `Promise.resolve().then(() => handler(...))` 把**调用本身**
    // 包进微任务 —— 直接 `Promise.resolve(handler(...))` 的话，
    // 同步 throw 会在 Promise 构造之前就发生，catch 抓不到。
    // 症状是：401变成进程级 uncaughtException，连接被直接断掉（curl 拿到 000）。
    void Promise.resolve()
      .then(() => matched.handler({ req, res, params: matched.params, query: url.searchParams }))
      .catch((error) => {
        if (res.headersSent) {
          // 头已发出（流已开始），状态码改不了 —— 这个错误由
          // createAgentStream 的 catch 作为 `run.failed` 送出去了。
          // 这里只结束响应，不能再 sendError。
          res.end()
          return
        }
        sendError(res, error)
      })
  }
}

export function bootstrap(): { interrupted: number } {
  ensureSchema()
  return { interrupted: reconcileInterruptedRuns() }
}

export async function startServer(): Promise<http.Server> {
  const token = requireToken()

  // ⚠️ **bootstrap 必须在配置检查之前。** 内置厂商/端点/模型是在 bootstrap
  // 里写进库的，顺序反了会「库是空的 → 判成没配 → 拒绝启动」，
  // 而真正的原因只是还没 seed。
  const { interrupted } = bootstrap()
  if (interrupted > 0) {
    // 契约 §六：进行中的 run 不跨重启恢复。明确标记成 interrupted，
    // 而不是让它永远挂在 running —— 那会让会话永久「还有一轮在跑」。
    console.warn(`[agent] 上一进程留下 ${interrupted} 轮未完成，已标记为 interrupted。`)
  }

  const modelId = requireMagpieModel()

  // ⚠️ 必须在 buildRouter 之前：路由里 `/api/tools` 直接读注册表，
  // 晚一步加载的话首屏会看到「0 个工具」，而工具其实是好的。
  const ravenTools = await loadRavenTools()
  if (ravenTools.error) {
    console.warn(`[agent] ${ravenTools.error}（runtime 照常启动，只是没有 raven 的工具。）`)
  } else {
    console.log(
      `[agent] raven 工具 ${ravenTools.registered} 个` +
        (ravenTools.disabled.length > 0 ? `，未开放 ${ravenTools.disabled.length} 个：${ravenTools.disabled.join(', ')}` : '')
    )
  }

  const router = buildRouter(token)
  const listenPort = port()

  const server = http.createServer(createRequestListener(router))

  server.listen(listenPort, () => {
    console.log(`[agent] 监听 ${listenPort}，契约 v${CONTRACT_VERSION}，模型 ${modelId}，工具 ${toolNames().length} 个。`)
  })

  return server
}

export { HttpError }