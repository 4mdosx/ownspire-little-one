import type { EndpointConfig, ModelConfig, ProtocolFamily } from '../protocol/driver.js'
import { all, get, run } from './database.js'
import { now } from '../lib/ids.js'

/**
 * 厂商 / 端点 / 模型三张表的读写。
 *
 * ## 结构：厂商 → 端点 → 模型
 *
 * **key 属于厂商**（同一家的多个端点共用一个 key），
 * **协议挂在端点上**（同一家的不同端点协议可能不同：
 * 智谱的 `/api/paas/v4` 是 OpenAI Chat，而 `/api/anthropic` 是 Anthropic Messages）。
 *
 * 所以 Adapter 的选择依据是 `endpoint.protocol`，而 key 的来源是 `endpoint.providerId`。
 * **这两个是独立的** —— 别把它们合成一个「厂商 = Adapter」的假设。
 *
 * ## 为什么配置缓存在内存
 *
 * 一轮对话查好几次配置，而配置在进程生命周期里几乎不变。
 * 缓存在内存里让「改了配置要重启」这件事变得明确 ——
 * 现在改库不重启是**不生效**的，那是有意的
 * （否则一半请求用旧配置一半用新的，那种 bug 更难查）。
 */

type ProviderRow = {
  id: string
  label: string
  keyEnvVar: string
  apiKey: string | null
  defaultProtocol: string
  createdAt: number
  updatedAt: number
}

type EndpointRow = {
  id: string
  providerId: string
  label: string
  protocol: string | null
  baseUrl: string | null
  extraBody: string | null
  enabled: number
  providerLabel?: string
  providerKeyEnvVar?: string
  providerApiKey?: string | null
  providerDefaultProtocol?: string
}

type ModelRow = {
  id: string
  endpointId: string
  label: string
  reasoningEffort: string | null
  enabled: number
}

/**
 * `protocol` 列是 TEXT 而 TS 侧是联合类型 —— 拼错协议名在这里被抓住，
 * 而不是等到「找不到能处理该协议的 Driver」。
 */
export function toProtocol(raw: string): ProtocolFamily {
  const known: ProtocolFamily[] = [
    'openai-chat-completions',
    'openai-responses',
    'anthropic-messages',
    'sdk',
  ]
  if (!known.includes(raw as ProtocolFamily)) {
    throw new ConfigError(
      `protocol 写错了：${raw}。合法的值是 ${known.join(' / ')}。` +
        '⚠️ 它是**协议名**不是厂商名 —— GLM 与 OpenAI 官方都是 openai-chat-completions。'
    )
  }
  return raw as ProtocolFamily
}

/** 一次 JOIN 把端点与厂商都取出来 —— key 在厂商上，不在端点上。 */
const ENDPOINT_SELECT = `
  SELECT e.*, p.label AS providerLabel, p.keyEnvVar AS providerKeyEnvVar,
         p.apiKey AS providerApiKey,
         p.defaultProtocol AS providerDefaultProtocol
    FROM endpoints e JOIN providers p ON p.id = e.providerId`

/**
 * key 的取值优先级 —— **全项目只有这一处判**。
 *
 * 库里填的（管理界面）优先，环境变量兜底（容器部署的既有方式）。
 * 顺序反过来的后果是：容器里注入的 env 会盖掉用户在界面上刚填的 key，
 * 而界面显示「已保存」—— 那比不提供界面更糟。
 *
 * ⚠️ 两者都没有时返回 undefined，**不返回空字符串**：
 * SDK 用 `undefined` 报「缺少凭据」，而空字符串会被它当成「有一把空 key」
 * 于是请求照发、拿回一个语焉不详的 401。
 */
export function resolveProviderKey(row: { apiKey?: string | null; keyEnvVar: string }): string | undefined {
  const fromDb = row.apiKey?.trim()
  if (fromDb) return fromDb
  const fromEnv = process.env[row.keyEnvVar]?.trim()
  return fromEnv ? fromEnv : undefined
}

function toEndpoint(row: EndpointRow): EndpointConfig {
  if (!row.providerKeyEnvVar) {
    throw new ConfigError(`端点 ${row.id} 关联的厂商 ${row.providerId} 不存在。数据不完整。`)
  }
  const apiKey = resolveProviderKey({ apiKey: row.providerApiKey, keyEnvVar: row.providerKeyEnvVar })
  return {
    id: row.id,
    label: row.label,
    //端点自己的协议优先，留空则继承厂商默认。
    protocol: toProtocol(row.protocol ?? row.providerDefaultProtocol ?? 'openai-chat-completions'),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    // key 的环境变量名**从厂商取** —— 端点不持有凭据。
    keyEnvVar: row.providerKeyEnvVar,
    ...(apiKey ? { apiKey } : {}),
    ...(row.extraBody ? { extraBody: JSON.parse(row.extraBody) as Record<string, unknown> } : {}),
  }
}

function toModel(row: ModelRow): ModelConfig {
  const effort = row.reasoningEffort
  if (effort !== null && effort !== 'low' && effort !== 'high' && effort !== 'max') {
    throw new ConfigError(`模型 ${row.id} 的 reasoningEffort 写错了：${effort}。只能是 low / high / max。`)
  }
  return {
    id: row.id,
    label: row.label,
    endpointId: row.endpointId,
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export function listEndpoints(includeDisabled = false): EndpointConfig[] {
  const where = includeDisabled ? '' : ' WHERE e.enabled = 1'
  return all<EndpointRow>(`${ENDPOINT_SELECT}${where} ORDER BY p.label, e.label`).map(toEndpoint)
}

export function listModels(includeDisabled = false): ModelConfig[] {
  const where = includeDisabled ? '' : ' WHERE enabled = 1'
  return all<ModelRow>(`SELECT * FROM models${where} ORDER BY endpointId, label`).map(toModel)
}

export function findEndpoint(id: string): EndpointConfig | undefined {
  const row = get<EndpointRow>(`${ENDPOINT_SELECT} WHERE e.id = :id`, { id })
  return row ? toEndpoint(row) : undefined
}

/**
 * 第一个可用模型。**没指定模型时用这个**，而不是返回 undefined ——
 * 「会话没指定模型」不该等于「跑不了」，只有一个模型可用时它就是默认。
 */
export function firstModel(endpointId?: string): ModelConfig | undefined {
  const list = listModels()
  return endpointId ? list.find((model) => model.endpointId === endpointId) : list[0]
}

export function findModel(modelId: string, endpointId?: string): ModelConfig | undefined {
  // 不给 endpointId 时按 (endpointId, id) 唯一约束反查，
  // 而不能只按 id 查 —— 不同端点可能有同名模型。
  const row = endpointId
    ? get<ModelRow>('SELECT * FROM models WHERE endpointId = :e AND id = :id', {
        e: endpointId,
        id: modelId,
      })
    : get<ModelRow>('SELECT * FROM models WHERE id = :id ORDER BY endpointId LIMIT 1', {
        id: modelId,
      })
  return row ? toModel(row) : undefined
}

export function listProviders(): ProviderRow[] {
  return all<ProviderRow>('SELECT * FROM providers ORDER BY label')
}

// ---------------------------------------------------------------------------
// 出口：脱敏视图
// ---------------------------------------------------------------------------

/**
 * **出站用的厂商形状 —— 唯一允许发给 raven 的那个。**
 *
 * ⚠️ 为什么要有这个而不是「HTTP 层记得脱敏」：
 * 「记得」这种约束在下一个人改路由时就失效了，而 key 一旦进过一次响应，
 * 它就进了浏览器的 devtools、前端的日志、以及任何抓包工具。
 * 把「不包含明文 key」做成一个**类型**，让想泄漏都泄漏不出去。
 *
 * `apiKeyHint` 只给末四位。够用户确认「我填的是不是那把」，不足以还原。
 */
export type ProviderView = {
  id: string
  label: string
  /** 兜底的环境变量名。界面上要显示它 —— 用户得知道还能从哪儿配。 */
  keyEnvVar: string
  /** key 是否已配置（库里或环境变量里任一处有）。 */
  apiKeySet: boolean
  /** key 来源。分清「界面上填的」与「环境变量注入的」，否则用户会去改错地方。 */
  apiKeySource: 'db' | 'env' | 'none'
  apiKeyHint: string | null
  defaultProtocol: ProtocolFamily
  updatedAt: number
}

export function providerView(row: ProviderRow): ProviderView {
  const fromDb = row.apiKey?.trim() ?? ''
  const fromEnv = !fromDb ? (process.env[row.keyEnvVar]?.trim() ?? '') : ''
  const effective = fromDb || fromEnv
  return {
    id: row.id,
    label: row.label,
    keyEnvVar: row.keyEnvVar,
    apiKeySet: effective !== '',
    apiKeySource: fromDb ? 'db' : fromEnv ? 'env' : 'none',
    apiKeyHint: effective === '' ? null : `****${effective.slice(-4)}`,
    defaultProtocol: toProtocol(row.defaultProtocol),
    updatedAt: row.updatedAt,
  }
}

export function listProviderViews(): ProviderView[] {
  return listProviders().map(providerView)
}

/**
 * 给管理界面用的端点行 —— **带 providerId，而协议层的 EndpointConfig 不带**。
 *
 * 界面要按厂商分组、部分更新时要回退到原来的厂商，两者都需要它；
 * 而 Adapter 用不到，所以它不进协议层。
 */
export type EndpointRowView = {
  id: string
  providerId: string
  label: string
  protocol: ProtocolFamily
  baseUrl: string | null
  extraBody: Record<string, unknown> | null
  enabled: number
  modelCount: number
}

export function listEndpointRows(): EndpointRowView[] {
  return all<{
    id: string
    providerId: string
    label: string
    protocol: string | null
    baseUrl: string | null
    extraBody: string | null
    enabled: number
    providerDefaultProtocol: string
  }>(
    `SELECT e.*, p.defaultProtocol AS providerDefaultProtocol
       FROM endpoints e JOIN providers p ON p.id = e.providerId
      ORDER BY p.label, e.label`
  ).map((row) => ({
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    protocol: toProtocol(row.protocol ?? row.providerDefaultProtocol ?? 'openai-chat-completions'),
    baseUrl: row.baseUrl,
    extraBody: row.extraBody ? (JSON.parse(row.extraBody) as Record<string, unknown>) : null,
    enabled: row.enabled,
    modelCount: countModelsOn(row.id),
  }))
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/**
 * 新增 / 更新一个厂商。**`apiKey` 不传等于不改**，而不是「清空」。
 *
 * ⚠️ 这个区分很要紧：界面上「保存」一个没碰 key 的表单是常态，
 * 而如果缺省等于清空，那改个标签就把 key 弄丢了 ——
 * 而 key 丢了的表现是「突然报 key 无效」，用户完全想不到是自己刚才那次保存干的。
 * 要清空用 `clearApiKey: true`，那是个显式的动作。
 */
export function upsertProvider(input: {
  id: string
  label: string
  keyEnvVar: string
  defaultProtocol: ProtocolFamily
  apiKey?: string
  clearApiKey?: boolean
}): void {
  toProtocol(input.defaultProtocol)
  if (input.clearApiKey && input.apiKey) {
    throw new ConfigError('clearApiKey 与 apiKey 不能同时给 —— 清空和设置是相反的意图。')
  }
  const current = get<{ apiKey: string | null }>('SELECT apiKey FROM providers WHERE id = :id', { id: input.id })
  const nextApiKey = input.clearApiKey
    ? null
    : (input.apiKey?.trim() || current?.apiKey || null)

  run(
    `INSERT INTO providers (id, label, keyEnvVar, apiKey, defaultProtocol, createdAt, updatedAt)
     VALUES (:id, :label, :keyEnvVar, :apiKey, :defaultProtocol, :ts, :ts)
     ON CONFLICT(id) DO UPDATE SET
       label           = excluded.label,
       keyEnvVar       = excluded.keyEnvVar,
       apiKey          = excluded.apiKey,
       defaultProtocol = excluded.defaultProtocol,
       updatedAt       = :ts`,
    // ⚠️ **不能 `{ ...input }`** —— 那样会把 clearApiKey 一起当具名参数传进去，
    // 而 SQL 里没有它，node:sqlite 会直接抛 `Unknown named parameter`。
    // 这类「控制字段混进 SQL 参数」的错误只在真的执行到才暴露，所以要显式列。
    {
      id: input.id,
      label: input.label,
      keyEnvVar: input.keyEnvVar,
      defaultProtocol: input.defaultProtocol,
      apiKey: nextApiKey,
      ts: now(),
    },
  )
}

export function upsertEndpoint(input: {
  id: string
  providerId: string
  label: string
  /** 留空则继承厂商默认协议。 */
  protocol?: ProtocolFamily
  baseUrl?: string
  extraBody?: Record<string, unknown>
  enabled?: boolean
}): void {
  if (input.protocol) toProtocol(input.protocol)
  // ⚠️ 外键：厂商不存在就报错，而不是让端点挂在一个空引用上 ——
  // 后者的症状是「key 永远读不到」，而报错点在别处。
  if (!get<{ id: string }>('SELECT id FROM providers WHERE id = :id', { id: input.providerId })) {
    throw new ConfigError(`端点 ${input.id} 引用了不存在的厂商 ${input.providerId}。`)
  }
  run(
    `INSERT INTO endpoints (id, providerId, label, protocol, baseUrl, extraBody, enabled, createdAt, updatedAt)
     VALUES (:id, :providerId, :label, :protocol, :baseUrl, :extraBody, :enabled, :ts, :ts)
     ON CONFLICT(id) DO UPDATE SET
       providerId = excluded.providerId,
       label      = excluded.label,
       protocol   = excluded.protocol,
       baseUrl    = excluded.baseUrl,
       extraBody  = excluded.extraBody,
       enabled    = excluded.enabled,
       updatedAt  = :ts`,
    {
      id: input.id,
      providerId: input.providerId,
      label: input.label,
      protocol: input.protocol ?? null,
      baseUrl: input.baseUrl ?? null,
      extraBody: input.extraBody ? JSON.stringify(input.extraBody) : null,
      enabled: (input.enabled ?? true) ? 1 : 0,
      ts: now(),
    },
  )
}

export function upsertModel(input: ModelConfig & { enabled?: boolean }): void {
  if (input.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(input.reasoningEffort)) {
    throw new ConfigError(`reasoningEffort 只能是 low / high / max，收到「${input.reasoningEffort}」。`)
  }
  run(
    `INSERT INTO models (id, endpointId, label, reasoningEffort, enabled, createdAt, updatedAt)
     VALUES (:id, :endpointId, :label, :reasoningEffort, :enabled, :ts, :ts)
     ON CONFLICT(endpointId, id) DO UPDATE SET
       label           = excluded.label,
       reasoningEffort = excluded.reasoningEffort,
       enabled         = excluded.enabled,
       updatedAt       = :ts`,
    {
      id: input.id,
      endpointId: input.endpointId,
      label: input.label,
      reasoningEffort: input.reasoningEffort ?? null,
      enabled: (input.enabled ?? true) ? 1 : 0,
      ts: now(),
    },
  )
}

// ---------------------------------------------------------------------------
// 删
// ---------------------------------------------------------------------------

/**
 * 「用户给的数据不合法」。
 *
 * ⚠️ 为什么要一个类：这些校验散落在 db 层（协议名、reasoningEffort、id 重复、
 * 相反的两个 flag），而 HTTP 层要把它们翻成 **400**。
 * 落回通用 Error 就是 500 —— 而 500 的意思是「服务端坏了，请重试」，
 * 于是用户对着一个「参数写错了」重试一万次。
 *
 * 同理不能用 message 匹配来区分：那是把显示文案变成了控制流，
 * 改一次文案就悄悄改了状态码。
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * 「还有下级，要删就显式声明 cascade」。
 *
 * ⚠️ 单独一个类而不是通用 Error：路由要把它翻成 **409 Conflict**，
 * 而「参数不合法」是400、「服务端坏了」是 500。用 message 匹配来区分
 * 是把一个显示文案变成了控制流 —— 改一次文案就悄悄改了 HTTP 状态码。
 */
export class CascadeRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CascadeRequiredError'
  }
}

/**
 * 删除模型。
 *
 * ⚠️ **外键是声明了但没开的**（`PRAGMA foreign_keys` 默认 off，
 * 而打开它会让 seed 阶段的插入顺序变成硬约束）。所以级联必须**显式做** ——
 * 不做的话会留下指向不存在端点的模型行，而症状出现在很久之后：
 * 用户在界面里选那个模型，Runtime 才说「找不到端点」。
 */
export function deleteModel(id: string, endpointId: string): boolean {
  const row = get<{ n: number }>(
    'SELECT count(*) AS n FROM models WHERE id = :id AND endpointId = :endpointId',
    { id, endpointId }
  )
  if (!row || row.n === 0) return false
  run('DELETE FROM models WHERE id = :id AND endpointId = :endpointId', { id, endpointId })
  return true
}

/** 删端点前先报一下会连带删掉几个模型 —— 让调用方能把这句话转给用户。 */
export function countModelsOn(endpointId: string): number {
  const row = get<{ n: number }>('SELECT count(*) AS n FROM models WHERE endpointId = :id', { id: endpointId })
  return row?.n ?? 0
}

export function deleteEndpoint(id: string, cascade: boolean): { deleted: boolean; removedModels: number } {
  const models = countModelsOn(id)
  const exists = get<{ n: number }>('SELECT count(*) AS n FROM endpoints WHERE id = :id', { id })
  if (!exists || exists.n === 0) return { deleted: false, removedModels: 0 }
  // ⚠️ 不给 cascade 就拒绝，**不静默连带删** —— 删端点连带删掉几个模型
  // 是一次不可逆的动作，用户可能只以为删了一个地址。
  if (models > 0 && !cascade) {
    throw new CascadeRequiredError(`端点 ${id} 上还有 ${models} 个模型。要一起删请显式声明 cascade。`)
  }
  if (cascade) run('DELETE FROM models WHERE endpointId = :id', { id })
  run('DELETE FROM endpoints WHERE id = :id', { id })
  return { deleted: true, removedModels: models }
}

export function countEndpointsOn(providerId: string): number {
  const row = get<{ n: number }>('SELECT count(*) AS n FROM endpoints WHERE providerId = :id', {
    id: providerId,
  })
  return row?.n ?? 0
}

/**
 * 删厂商。**级联删端点，端点再级联删模型** —— 但仍要显式声明。
 *
 * ⚠️ 为什么不静默级联：删厂商通常意味着「这个厂商不用了」，
 * 而用户可能不知道它的端点下还挂着模型。报出数量让他确认，比替他决定好。
 */
export function deleteProvider(
  id: string,
  cascade: boolean
): { deleted: boolean; removedEndpoints: number; removedModels: number } {
  const endpoints = countEndpointsOn(id)
  const exists = get<{ n: number }>('SELECT count(*) AS n FROM providers WHERE id = :id', { id })
  if (!exists || exists.n === 0) return { deleted: false, removedEndpoints: 0, removedModels: 0 }
  if (endpoints > 0 && !cascade) {
    throw new CascadeRequiredError(`厂商 ${id} 下还有 ${endpoints} 个端点。要一起删请显式声明 cascade。`)
  }
  let removedModels = 0
  if (cascade) {
    removedModels = get<{ n: number }>(
      'SELECT count(*) AS n FROM models WHERE endpointId IN (SELECT id FROM endpoints WHERE providerId = :id)',
      { id }
    )?.n ?? 0
    run('DELETE FROM models WHERE endpointId IN (SELECT id FROM endpoints WHERE providerId = :id)', { id })
    run('DELETE FROM endpoints WHERE providerId = :id', { id })
  }
  run('DELETE FROM providers WHERE id = :id', { id })
  return { deleted: true, removedEndpoints: endpoints, removedModels }
}

// ---------------------------------------------------------------------------
// 内置配置
// ---------------------------------------------------------------------------

/**
 * 内置厂商与端点。**启动时幂等写入**，所以不额外配置也能跑。
 *
 * ⚠️ **只写 key 的环境变量名**，不写 key 本身 —— 所以 key 仍要靠环境变量提供。
 * 这样「配置在库、凭据在环境」这条边界不会被自己破坏。
 *
 * ⚠️ **智谱有三个端点、两种协议**，这是「Adapter 按协议切」的现实依据：
 * 同一个 key，`/api/paas/v4` 走 OpenAI Chat，`/api/anthropic` 走 Anthropic Messages。
 */
export function seedBuiltinProviders(): void {
  upsertProvider({
    id: 'openai',
    label: 'OpenAI',
    keyEnvVar: 'OPENAI_API_KEY',
    defaultProtocol: 'openai-chat-completions',
  })
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM',
    keyEnvVar: 'ZHIPU_API_KEY',
    defaultProtocol: 'openai-chat-completions',
  })
  upsertProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    defaultProtocol: 'openai-chat-completions',
  })

  upsertEndpoint({
    id: 'openai',
    providerId: 'openai',
    label: 'OpenAI 官方',
  })
  upsertEndpoint({
    id: 'zhipu-chat',
    providerId: 'zhipu',
    label: '智谱（OpenAI Chat）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // ⚠️ GLM 硬要求 thinking.type=enabled，**漏了直接请求失败**。
    // reasoning_effort 不在这里设默认 —— 那由每个模型自己决定
    //（glm-5.3 默认 max，那是最贵的一档）。
    extraBody: { thinking: { type: 'enabled' } },
  })
  upsertEndpoint({
    id: 'zhipu-anthropic',
    providerId: 'zhipu',
    label: '智谱（Anthropic Messages）',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    // ⚠️ **协议不同** —— 这个端点要的不是 vercel-ai adapter。
    // 挂上 claude adapter 之后，同一个智谱 key 就能走两种协议。
    protocol: 'anthropic-messages',
    // GLM 在 Anthropic 协议下不需要 thinking 参数。
    extraBody: undefined,
  })
  upsertEndpoint({
    id: 'deepseek',
    providerId: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
  })

  upsertModel({ id: 'gpt-5', label: 'GPT-5', endpointId: 'openai' })
  upsertModel({
    id: 'glm-5.3',
    label: 'GLM-5.3',
    endpointId: 'zhipu-chat',
    // 显式写 high 而不是落到 max —— max 最贵，而「没配」与「配成 max」
    // 的成本差好几倍。
    reasoningEffort: 'high',
  })
  upsertModel({ id: 'deepseek-chat', label: 'DeepSeek Chat', endpointId: 'deepseek' })
}

/**
 * 默认模型（`/api/models` 的 `default` 字段用）。
 *
 * ⚠️ **优先按 `AGENT_MODEL` 找，找不到才退到第一个可用模型。**
 * 「退到第一个」比「报错」好用的场景是：库里配好了模型、
 * 但环境变量还没设（第一次部署的常见状态）。
 */
/**
 * **把环境变量里指定的模型补进 models 表。** 幂等。
 *
 * ## 为什么需要这一步
 *
 * 配置有两处来源：`.env`（`AGENT_MODEL`）与库（`models` 表）。只有前者时
 * 库里查不到该模型，于是「明明配了模型」却跑不起来。与其让两处配置
 * 必须手工同步（迟早不同步），不如**启动时把环境变量的那一个补进库** ——
 * 方向是单向的：环境变量 → 库，库是唯一真相。
 *
 * ⚠️ 端点只能猜「第一个启用的」。要精确指定就先在库里建好模型，
 * 那时这个函数什么都不做。
 */
/**
 * **真能用的端点** —— 启用、且它的厂商 key 在环境里。
 *
 * ## 为什么这是启动检查的真正不变量
 *
 * 「所有厂商都有 key」是个**过强**的要求：内置厂商是自动 seed 的，
 * 用它做检查等于「不配 DeepSeek 的 key 就起不来」，而你可能根本不用 DeepSeek。
 *
  * 真正要保证的是**至少有一个**端点能连上；其余缺 key 的记一条警告就够。
 */
export function usableEndpoints(): EndpointConfig[] {
  return listEndpoints().filter((endpoint) => process.env[endpoint.keyEnvVar]?.trim())
}

export function ensureConfiguredModel(): void {
  const configured = process.env.AGENT_MODEL?.trim()
  if (!configured) return
  if (findModel(configured)) return

  const endpoint = listEndpoints()[0]
  if (!endpoint) {
    throw new ConfigError(
      `AGENT_MODEL 指定了「${configured}」，但一个启用的端点都没有。` +
        '先建厂商与端点（见 seedBuiltinProviders），或清掉 AGENT_MODEL。'
    )
  }
  upsertModel({ id: configured, endpointId: endpoint.id, label: configured })
  console.warn(
    `[agent] AGENT_MODEL「${configured}」不在 models 表里，已挂到端点「${endpoint.id}」。` +
      '要换端点就在库里改这一行。'
  )
}

/**
 * 默认模型 id，**但拿不到就返回 null 而不是抛**。
 *
 * ⚠️ 存在的理由：删掉当前默认模型时，`defaultModelId()` 会抛
 * 「AGENT_MODEL 指向的模型不在 models 表里」。而那是**删除操作的正确后果**，
 * 不是删除操作的失败 —— 让它冒泡会把 200 变成 500，
 * 用户看到的是「删除报错」，而实际上模型已经删掉了。
 *
 * 该抛的地方仍然抛（`startServer` 启动检查要的就是那个错）。
 */
export function tryDefaultModelId(): string | null {
  try {
    return defaultModelId() || null
  } catch {
    return null
  }
}

export function defaultModelId(): string {
  const configured = process.env.AGENT_MODEL?.trim()
  if (configured) {
    const found = findModel(configured)
    if (found) return found.id
    // ⚠️ **配了但库里没有 → 明确说出来**，不静默退到别的模型。
    // 静默退化会让「我明明设了 glm-5.3 却用的是别的」变成一桩查不到的事。
    throw new ConfigError(
      `AGENT_MODEL 指向的模型「${configured}」不在 models 表里。` +
        '确认 endpoints / models 表，或清掉这个变量让它用默认。'
    )
  }
  return listModels()[0]?.id ?? ''
}

/**
 * 配置是否够用。启动时调。
 *
 * ⚠️ **只关心「至少有一个启用端点」的厂商** —— 建了 provider 但没建启用端点时，
 * 它的 key 不该让启动失败（那是在配置过程中的正常中间态）。
 *
 * ⚠️ **返回所有缺失的，不只报第一个** —— 一次看到三个比修一个再发现下一个快。
 */
export function missingKeys(): { provider: string; envVar: string }[] {
  const endpoints = listEndpoints() // 只含 enabled 的
  const inUse = new Set(endpoints.map((endpoint) => endpoint.keyEnvVar))

  const missing: { provider: string; envVar: string }[] = []
  for (const provider of listProviders()) {
    if (!inUse.has(provider.keyEnvVar)) continue
    if (!process.env[provider.keyEnvVar]?.trim()) {
      missing.push({ provider: provider.id, envVar: provider.keyEnvVar })
    }
  }
  return missing
}