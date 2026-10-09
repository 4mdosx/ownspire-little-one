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
  CascadeRequiredError,
  ConfigError,
  defaultModelId,
  tryDefaultModelId,
  deleteEndpoint,
  deleteModel,
  deleteProvider,
  listEndpointRows,
  listEndpoints,
  listModels,
  listProviderViews,
  missingKeys,
  ensureConfiguredModel,
  seedBuiltinProviders,
  toProtocol,
  usableEndpoints,
  upsertEndpoint,
  upsertModel,
  upsertProvider,
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

  // ---- 配置目录（鉴权）：厂商 / 端点 / 模型 的增删改 ----------------
  //
  // ⚠️ 这组接口服务 raven 的「模型与厂商」管理界面。
  //
  // **一条不能破的：明文 key 永不出现在任何响应里。** 出口只有
  // `listProviderViews()`那一个形状，它连apiKey 字段都没有 ——
  // 「key 存在但不许出站」这条纪律做成了类型，而不是靠每个路由记得脱敏。
  // 界面上要看key 状态，看 `apiKeySet` / `apiKeySource` / `apiKeyHint`。
  //
  // ⚠️ **写操作一律立即落库，不走「改配置要重启」那套缓存。**
  // 目录层的缓存存在的理由是「一半请求用旧配置一半用新的很难查」，
  // 而配置界面的整个意义就是「改完立刻能用」。
  // 真正需要重启的是 key 那部分——它从库里读，不用重启。

  router.get('/api/config', ({ req, res }) => {
    requireAuth(req, token)
    sendJson(res, 200, {
      providers: listProviderViews(),
      endpoints: listEndpointRows(),
      models: listModels(),
      // ⚠️ 用 try 版：刚删掉当前默认模型时，「查一下默认是谁」不该让整个查询失败。
      // 「配置坏了」是用户的编辑结果，不是「这个接口出错」。
      defaultModel: tryDefaultModelId(),
    })
  })

  /** 配置类错误 → 400。用类型区分而不是匹配 message（那是把文案变成了控制流）。 */
  function guardConfig<T>(fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new HttpError(400, 'invalid_config', error.message)
      }
      if (error instanceof CascadeRequiredError) {
        throw new HttpError(409, 'cascade_required', error.message)
      }
      throw error
    }
  }

  router.put('/api/config/providers/:id', async ({ req, res, params }) => {
    requireAuth(req, token)
    const body = await readJson<{
      label?: unknown
      keyEnvVar?: unknown
      defaultProtocol?: unknown
      apiKey?: unknown
      clearApiKey?: unknown
    }>(req)
    const id = requireId(params.id)
    const existing = listProviderViews().find((item) => item.id === id)
    guardConfig(() =>
      upsertProvider({
        id,
        label: requireText(body.label, existing?.label ?? id),
        keyEnvVar: requireText(body.keyEnvVar, existing?.keyEnvVar ?? `${id.toUpperCase()}_API_KEY`),
        defaultProtocol:
          typeof body.defaultProtocol === 'string'
            ? toProtocol(body.defaultProtocol)
            : (existing?.defaultProtocol ?? 'openai-chat-completions'),
        // ⚠️ 字段不存在 = **不改**，不是清空。界面「保存」一个没碰 key 的表单
        // 是常态，缺省等于清空的话用户改个标签就把 key 弄丢了。
        ...(typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? { apiKey: body.apiKey } : {}),
        ...(body.clearApiKey === true ? { clearApiKey: true } : {}),
      })
    )
    sendJson(res, 200, { provider: listProviderViews().find((item) => item.id === id) })
  })

  router.put('/api/config/endpoints/:id', async ({ req, res, params }) => {
    requireAuth(req, token)
    const body = await readJson<Record<string, unknown>>(req)
    const id = requireId(params.id)
    // ⚠️ 这里要providerId（部分更新时回退到原厂商），而协议层的 EndpointConfig
    // 不带它 —— 所以走界面专用的行视图。两个形状各有各的用处，别混用。
    const existing = listEndpointRows().find((item) => item.id === id)
    guardConfig(() =>
      upsertEndpoint({
        id,
        providerId: requireText(body.providerId, existing?.providerId ?? ''),
        label: requireText(body.label, existing?.label ?? id),
        ...(typeof body.protocol === 'string'
          ? { protocol: toProtocol(body.protocol) }
          : existing?.protocol
            ? { protocol: existing.protocol }
            : {}),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(body.extraBody !== undefined && body.extraBody !== null
          ? { extraBody: body.extraBody as Record<string, unknown> }
          : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      })
    )
    sendJson(res, 200, { endpoint: listEndpointRows().find((item) => item.id === id) })
  })

  router.put('/api/config/models', async ({ req, res }) => {
    requireAuth(req, token)
    const body = await readJson<Record<string, unknown>>(req)
    const id = requireText(body.id, '')
    const endpointId = requireText(body.endpointId, '')
    const existing = listModels().find((item) => item.id === id && item.endpointId === endpointId)
    guardConfig(() =>
      upsertModel({
        id,
        endpointId,
        label: requireText(body.label, existing?.label ?? id),
        ...(typeof body.reasoningEffort === 'string'
          ? { reasoningEffort: body.reasoningEffort as 'low' | 'high' | 'max' }
          : existing?.reasoningEffort
            ? { reasoningEffort: existing.reasoningEffort as 'low' | 'high' | 'max' }
            : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      })
    )
    sendJson(res, 200, { model: listModels().find((item) => item.id === id && item.endpointId === endpointId) })
  })

  // ⚠️ **删除一律要求显式 cascade**，且回执里报清连带删了什么。
  // 静默级联会让「我只是想删这个厂商」变成「它的模型全没了」，
  // 而不可逆的动作没有回执是最糟的组合。
  router.delete('/api/config/providers/:id', ({ req, res, params }) => {
    requireAuth(req, token)
    const id = requireId(params.id)
    const result = guardCascade(() => deleteProvider(id, cascadeOf(req)))
    if (!result.deleted) throw new HttpError(404, 'provider_not_found', `厂商 ${id} 不存在。`)
    sendJson(res, 200, { ...result, defaultModel: tryDefaultModelId() })
  })

  router.delete('/api/config/endpoints/:id', ({ req, res, params }) => {
    requireAuth(req, token)
    const id = requireId(params.id)
    const result = guardCascade(() => deleteEndpoint(id, cascadeOf(req)))
    if (!result.deleted) throw new HttpError(404, 'endpoint_not_found', `端点 ${id} 不存在。`)
    sendJson(res, 200, result)
  })

  router.delete('/api/config/models/:endpointId/:id', ({ req, res, params }) => {
    requireAuth(req, token)
    const removed = deleteModel(requireId(params.id), requireId(params.endpointId))
    if (!removed) throw new HttpError(404, 'model_not_found', `模型 ${params.id} 不存在。`)
    sendJson(res, 200, { deleted: true })
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

/** 字段必须是非空字符串；没给就回退到现值（部分更新语义）。 */
function requireText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    if (fallback === '') throw new HttpError(400, 'missing_field', '这个字段是必填的。')
    return fallback
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_field', '这个字段必须是非空字符串。')
  }
  return value.trim()
}

/**
 * 级联删除的开关。**只能是显式的 `cascade=1`/`true`** ——
 * 缺省一律当「不级联」，然后由下层报「还有 N 个端点/模型」并让用户确认。
 * 反过来（缺省就级联）的话，一次误点就没了，而用户看不到自己误点了什么。
 */
function cascadeOf(req: http.IncomingMessage): boolean {
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cascade')
  return raw === '1' || raw === 'true'
}

/**
 * 把「还有下级」翻成 **409**。
 *
 * ⚠️ 必须是 409 而不是落回500：500 的意思是「服务端坏了」，而这里服务端好得很，
 * 是请求与当前状态冲突。raven 拿到 409 才知道「该弹确认框问用户」，
 * 拿到 500 只会显示一句「稍后重试」—— 而重试一万次也是同样的冲突。
 */
function guardCascade<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof CascadeRequiredError) {
      throw new HttpError(409, 'cascade_required', error.message)
    }
    throw error
  }
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

  const server = http.createServer(createRequestListener(router))

  server.listen(listenPort, () => {
    console.log(`[agent] 监听 ${listenPort}，契约 v${CONTRACT_VERSION}，模型 ${defaultModelId()}，工具 ${toolNames().length} 个。`)
  })

  return server
}

export { HttpError }