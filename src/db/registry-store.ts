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
  SELECT e.*, p.label AS providerLabel,
         p.apiKey AS providerApiKey,
         p.defaultProtocol AS providerDefaultProtocol
    FROM endpoints e JOIN providers p ON p.id = e.providerId`

/**
 * key 的取值 —— **全项目只有这一处**。
 *
 * ⚠️ **只有一个来源：`providers.apiKey`。** 环境变量不再是配置来源
 * （2026-10-09 删）。此前这里是「库里优先、env 兜底」的两级判定，
 * 而两级判定的成本不在代码量上：用户在界面上看到「已保存」，
 * 真正生效的却可能是容器里注入的那把 —— 去改错地方的人不在少数。
 *
 * ⚠️ 两者都没有时返回 undefined，**不返回空字符串**：
 * SDK 用 `undefined` 报「缺少凭据」，而空字符串会被它当成「有一把空 key」
 * 于是请求照发、拿回一个语焉不详的 401。
 */
export function resolveProviderKey(row: { apiKey?: string | null }): string | undefined {
  const fromDb = row.apiKey?.trim()
  return fromDb ? fromDb : undefined
}

function toEndpoint(row: EndpointRow): EndpointConfig {
  // ⚠️ 这里曾有一个「厂商不存在」的检查，靠 `keyEnvVar` 为空来判 ——
  // 而ENDPOINT_SELECT 是 INNER JOIN，厂商不存在就**根本没有这一行**，
  // 那个检查永远不成立。它给人「这里校验过厂商存在性」的错觉，实际没有。
  const apiKey = resolveProviderKey({ apiKey: row.providerApiKey })
  return {
    id: row.id,
    label: row.label,
    //端点自己的协议优先，留空则继承厂商默认。
    protocol: toProtocol(row.protocol ?? row.providerDefaultProtocol ?? 'openai-chat-completions'),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
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
  if (endpointId) return list.find((model) => model.endpointId === endpointId)
  // 不指定端点 = 「给我一个能用的」—— **可用优先**：有 key 的厂商端点排前。
  // 此前是纯字母序,排第一的可能挂在一个没配 key 的端点上
  // （症状:每次对话都报「OpenAI API key is missing」,而配了 key 的模型明明在表里）。
  return usableModelList()[0] ?? list[0]
}

/** 挂在「配了 key 的启用端点」上的模型,**保持 listModels 的排序**。 */
export function usableModelList(): ModelConfig[] {
  return listModels().filter((model) => findEndpoint(model.endpointId)?.apiKey !== undefined)
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

/** 用量账本的厂商归属（契约 §六）。端点不存在时返回端点 id 兜底 —— 账不能丢。 */
export function findProviderId(endpointId: string): string {
  const row = get<{ providerId: string }>('SELECT providerId FROM endpoints WHERE id = :id', {
    id: endpointId,
  })
  return row?.providerId ?? endpointId
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
  /** key 是否已配置（库里有没有值）。 */
  apiKeySet: boolean
  /** key 来源。**只有 `db` 与 `none`** —— 环境变量已不再是来源（2026-10-09 删）。 */
  apiKeySource: 'db' | 'none'
  apiKeyHint: string | null
  defaultProtocol: ProtocolFamily
  updatedAt: number
}

export function providerView(row: ProviderRow): ProviderView {
  const effective = row.apiKey?.trim() ?? ''
  return {
    id: row.id,
    label: row.label,
    apiKeySet: effective !== '',
    apiKeySource: effective === '' ? 'none' : 'db',
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
    `INSERT INTO providers (id, label, apiKey, defaultProtocol, createdAt, updatedAt)
     VALUES (:id, :label, :apiKey, :defaultProtocol, :ts, :ts)
     ON CONFLICT(id) DO UPDATE SET
       label           = excluded.label,
       apiKey          = excluded.apiKey,
       defaultProtocol = excluded.defaultProtocol,
       updatedAt       = :ts`,
    // ⚠️ **不能 `{ ...input }`** —— 那样会把 clearApiKey 一起当具名参数传进去，
    // 而 SQL 里没有它，node:sqlite 会直接抛 `Unknown named parameter`。
    // 这类「控制字段混进 SQL 参数」的错误只在真的执行到才暴露，所以要显式列。
    {
      id: input.id,
      label: input.label,
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
 * ⚠️ **不写 key。** key 只能由管理界面填入（`providers.apiKey`），
 * 环境变量不再参与 —— 所以刚 seed 完的库一定是「没配 key」的状态，
 * 界面上的表现是每个厂商都显示「未配置 key」，那是对的：
 * 它说的是「确实还没配」，而不是「配在别处你看不见」。
 *
 * ⚠️ **智谱有三个端点、两种协议**，这是「Adapter 按协议切」的现实依据：
 * 同一个 key，`/api/paas/v4` 走 OpenAI Chat，`/api/anthropic` 走 Anthropic Messages。
 */
export function seedBuiltinProviders(): void {
  upsertProvider({
    id: 'openai',
    label: 'OpenAI',
    defaultProtocol: 'openai-chat-completions',
  })
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM',
    defaultProtocol: 'openai-chat-completions',
  })
  upsertProvider({
    id: 'deepseek',
    label: 'DeepSeek',
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
 * **真能用的端点** —— 启用、且它的厂商在库里填了 key。
 *
 * ## 为什么这是启动检查的真正不变量
 *
 * 「所有厂商都有 key」是个**过强**的要求：内置厂商是自动 seed 的，
 * 用它做检查等于「不填 DeepSeek 的 key 就起不来」，而你可能根本不用 DeepSeek。
 *
 * 真正要保证的是**至少有一个**端点能连上；其余缺 key 的记一条警告就够。
 */
export function usableEndpoints(): EndpointConfig[] {
  return listEndpoints().filter((endpoint) => resolveProviderKey({ apiKey: endpoint.apiKey }) !== undefined)
}

/**
 * 默认模型 id —— **库里第一个启用的模型**。
 *
 * ⚠️ 只有一个来源。此前还有 `AGENT_MODEL` 优先，找不到才退到第一个；
 * 现在这条 env 线路删了（2026-10-09），因为它让「默认用哪个模型」
 * 取决于进程环境而不是库 —— 而库里那份是用户看得见、改得动的。
 *
 * 拿不到返回空字符串（而不是抛）：调用点分两种，
 * 一种要报错（启动检查），一种要null（`tryDefaultModelId`）。
 */
export function defaultModelId(): string {
  // 可用优先:启动检查要的是「默认模型真的能用」,而不是「字母序第一」。
  // 都不可用时退回全表第一个 —— 那个错误会由调用侧明确说出（缺 key / 缺端点）。
  return usableModelList()[0]?.id ?? listModels()[0]?.id ?? ''
}

/**
 * 默认模型 id，**但拿不到就返回 null 而不是抛**。
 *
 * ⚠️ 存在的理由：删掉当前默认模型时，`defaultModelId()` 会返回空串，
 * 而那是**删除操作的正确后果**，不是删除操作的失败 ——
 * 让它冒泡会把 200 变成 500，用户看到的是「删除报错」，
 * 而实际上模型已经删掉了。
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

/**
 * **库里没填key 的厂商** —— 启动时警告用。
 *
 * ⚠️ **只关心「至少有一个启用端点」的厂商** —— 建了 provider 但没建启用端点时，
 * 它的 key 不该让启动失败（那是在配置过程中的正常中间态）。
 *
 * ⚠️ **返回所有缺失的，不只报第一个** —— 一次看到三个比修一个再发现下一个快。
 */
export function missingKeys(): { provider: string; label: string }[] {
  // ⚠️ **一条 SQL 判完，不走 listEndpoints()。**
  // 那条路给的是协议层的 `EndpointConfig`，而它**故意没有 providerId**
  // （Adapter 不需要知道端点属于哪家厂商）—— 所以在协议层的形状上
  // 判「哪个厂商缺 key」是走不通的，硬走就得把 providerId 加回去，
  // 而那正是当初刻意不给它的原因。这条 SQL 是绕开它的正解。
  return all<{ id: string; label: string }>(
    `SELECT DISTINCT p.id AS id, p.label AS label
       FROM providers p
       JOIN endpoints e ON e.providerId = p.id AND e.enabled = 1
      WHERE p.apiKey IS NULL OR trim(p.apiKey) = ''
      ORDER BY p.label`
  ).map((row) => ({ provider: row.id, label: row.label }))
}