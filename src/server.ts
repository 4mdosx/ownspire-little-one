import http from 'node:http'
import { CONTRACT_VERSION, port, requireToken, version } from './config/env.js'
import { ensureSchema, pingDatabase } from './db/database.js'
import {
  countRuns,
  countSessions,
  createSession,
  deleteSession,
  findSession,
  listMessages,
  listSessions,
  reconcileInterruptedRuns,
} from './db/sessions.js'
import { HttpError, Router, readJson, requireAuth, sendError, sendJson } from './lib/http.js'
import { createAgentStream } from './lib/sse.js'
import { executeTurn, TurnError, type ApprovalResponseInput } from './protocol/turn.js'
import { drivers } from './drivers/index.js'
import { store } from './db/store.js'
import {
  defaultModelId,
  listEndpoints,
  listModels,
  missingKeys,
  ensureConfiguredModel,
  seedBuiltinProviders,
  usableEndpoints,
} from './db/registry-store.js'
import { toolCatalog, toolNames, UnknownToolError } from './tools/registry.js'
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
      // ⚠️ **只报数量，不报 id。** key 属于厂商且永远不入库，
      // 而端点 id 与厂商 id 是配置信息 —— 「有哪些模型可用」要给，
      // 「有哪些 key」绝不能出现在免鉴权的接口里（契约 §二）。
      models: databaseOk ? listModels().length : 0,
      endpoints: databaseOk ? listEndpoints().length : 0,
      tools: toolNames().length,
    })
  })

  // ---- 枚举（鉴权）----------------------------------------------------------

  router.get('/api/models', ({ req, res }) => {
    requireAuth(req, token)
    // ⚠️ **附上 endpointId 与 protocol**，因为前端可能需要按协议分组显示
    // （比如「走智谱 Anthropic 协议的」放一起）。契约 §三的形状不变，
    // 只是多了可选字段 —— 按契约 §八，加字段不需要升版本号。
    const models = listModels().map((model) => {
      const endpoint = listEndpoints().find((item) => item.id === model.endpointId)
      return {
        ...model,
        ...(endpoint ? { endpointId: endpoint.id, protocol: endpoint.protocol } : {}),
      }
    })
    sendJson(res, 200, { models, default: defaultModelId() || null })
  })

  router.get('/api/tools', ({ req, res }) => {
    requireAuth(req, token)
    sendJson(res, 200, { tools: toolCatalog() })
  })

  // ---- 会话（契约 §三）------------------------------------------------------

  router.post('/api/sessions', async ({ req, res }) => {
    requireAuth(req, token)
    const body = await readJson<{ title?: string; instructions?: string; tools?: string[] }>(req)

    const requested = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : toolNames()
    const unknown = requested.filter((name) => !toolNames().includes(name))
    // 未知工具名 → 400，不静默丢弃。静默丢弃会让「模型用了没注册的工具」
    // 变成一句看不出来的空响应。
    if (unknown.length > 0) {
      throw new HttpError(400, 'unknown_tool', `未知工具：${unknown.join(', ')}`)
    }

    const title =
      typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : '新会话'
    const session = createSession({
      title,
      ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
      tools: requested,
    })

    sendJson(res, 201, {
      sessionId: session.id,
      title: session.title,
      createdAt: session.createdAt,
      tools: JSON.parse(session.tools) as string[],
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
    //（契约 §四 规则一）。所以 404 / 400 必须发生在 createAgentStream 之前，
    // 由外层 catch 转成真正的 4xx。
    if (!findSession(sessionId)) {
      sendError(res, new HttpError(404, 'session_not_found', '会话不存在。'))
      return
    }
    if (content.trim() === '' && approvals.length === 0) {
      sendError(res, new HttpError(400, 'empty_content', 'content 不能为空。'))
      return
    }

    const startedAt = Date.now()
    const runId = `run_${startedAt.toString(36)}${Math.random().toString(36).slice(2, 8)}`

    const response = createAgentStream(
      (emit) =>
        executeTurn(
          // ⚠️ deps 显式传进来，不在协议层里 import 具体实现 ——
          // 这样协议层的测试能传假 Driver 与假 store。
          { drivers, store },
          {
            sessionId,
            content,
            approvalResponses: approvals,
            emit,
            approvalSecret: token,
          },
        ),
      { runId, sessionId, startedAt },
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
  })

  return router
}

/** 启动前检查。`ensureSchema` 幂等，撞到旧表直接抛错不自动搬数据。 */
export function bootstrap(): { interrupted: number } {
  ensureSchema()
  // ⚠️ **先建目录再检查配置** —— 内置的厂商/端点是在库里的，
  // 顺序反了会「库是空的 → 判成没配模型 → 拒绝启动」，而真正的原因只是没 seed。
  seedBuiltinProviders()
  ensureConfiguredModel()
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

  // ⚠️ **启动时就检查模型配置，不留到第一次对话。**
  //
  // 「没配 key 就起来、健康检查全绿、用户发消息才看到『模型调用失败』」
  // 是一类很难查的问题：运维看不出哪里不对，而报错文案指向模型，
  // 排查方向会被带去调 key —— 而真正的原因是压根没配模型 id。
  //
  // ⚠️ **按注册表检查，不硬认某一个环境变量。** 多家厂商各有自己的
  // keyEnvVar，写死 OPENAI_API_KEY 会让「配了智谱的 key」也被判成没配。
  // ⚠️ **缺 key 的厂商只警告，不拦启动。** 内置厂商是自动 seed 的，
  // 拿「所有厂商都有 key」当启动条件等于「不配 DeepSeek 就起不来」。
  // 真正要保证的是**至少有一个端点能连上**。
  for (const item of missingKeys()) {
    console.warn(`[agent] 厂商 ${item.provider} 的 ${item.envVar} 未设置，它的端点不会被使用。`)
  }
  if (usableEndpoints().length === 0) {
    throw new Error(
      '没有任何可用端点：所有启用的端点都缺 key，或一个启用端点都没有。' +
        '给要用的厂商配它 keyEnvVar 指向的环境变量（key 本身不进库）。'
    )
  }
  if (defaultModelId() === '') {
    throw new Error(
      '没有指定模型。设 AGENT_MODEL（或 AGENT_MODELS 的第一项）。' +
        '不配的话每个请求都会打一个空模型 id，报错信息会指向 key 而不是缺配置。'
    )
  }

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

  const server = http.createServer((req, res) => {
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
  })

  server.listen(listenPort, () => {
    console.log(`[agent] 监听 ${listenPort}，契约 v${CONTRACT_VERSION}，模型 ${defaultModelId()}，工具 ${toolNames().length} 个。`)
  })

  return server
}

export { HttpError }