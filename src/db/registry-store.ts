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
  defaultProtocol: string
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
    throw new Error(
      `protocol 写错了：${raw}。合法的值是 ${known.join(' / ')}。` +
        '⚠️ 它是**协议名**不是厂商名 —— GLM 与 OpenAI 官方都是 openai-chat-completions。'
    )
  }
  return raw as ProtocolFamily
}

/** 一次 JOIN 把端点与厂商都取出来 —— key 在厂商上，不在端点上。 */
const ENDPOINT_SELECT = `
  SELECT e.*, p.label AS providerLabel, p.keyEnvVar AS providerKeyEnvVar,
         p.defaultProtocol AS providerDefaultProtocol
    FROM endpoints e JOIN providers p ON p.id = e.providerId`

function toEndpoint(row: EndpointRow): EndpointConfig {
  if (!row.providerKeyEnvVar) {
    throw new Error(`端点 ${row.id} 关联的厂商 ${row.providerId} 不存在。数据不完整。`)
  }
  return {
    id: row.id,
    label: row.label,
    //端点自己的协议优先，留空则继承厂商默认。
    protocol: toProtocol(row.protocol ?? row.providerDefaultProtocol ?? 'openai-chat-completions'),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    // key 的环境变量名**从厂商取** —— 端点不持有凭据。
    keyEnvVar: row.providerKeyEnvVar,
    ...(row.extraBody ? { extraBody: JSON.parse(row.extraBody) as Record<string, unknown> } : {}),
  }
}

function toModel(row: ModelRow): ModelConfig {
  const effort = row.reasoningEffort
  if (effort !== null && effort !== 'low' && effort !== 'high' && effort !== 'max') {
    throw new Error(`模型 ${row.id} 的 reasoningEffort 写错了：${effort}。只能是 low / high / max。`)
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
// 写
// ---------------------------------------------------------------------------

export function upsertProvider(input: {
  id: string
  label: string
  keyEnvVar: string
  defaultProtocol: ProtocolFamily
}): void {
  toProtocol(input.defaultProtocol)
  run(
    `INSERT INTO providers (id, label, keyEnvVar, defaultProtocol, createdAt, updatedAt)
     VALUES (:id, :label, :keyEnvVar, :defaultProtocol, :ts, :ts)
     ON CONFLICT(id) DO UPDATE SET
       label           = excluded.label,
       keyEnvVar       = excluded.keyEnvVar,
       defaultProtocol = excluded.defaultProtocol,
       updatedAt       = :ts`,
    { ...input, ts: now() },
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
    throw new Error(`端点 ${input.id} 引用了不存在的厂商 ${input.providerId}。`)
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
    throw new Error(`reasoningEffort 只能是 low / high / max，收到「${input.reasoningEffort}」。`)
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
    throw new Error(
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

export function defaultModelId(): string {
  const configured = process.env.AGENT_MODEL?.trim()
  if (configured) {
    const found = findModel(configured)
    if (found) return found.id
    // ⚠️ **配了但库里没有 → 明确说出来**，不静默退到别的模型。
    // 静默退化会让「我明明设了 glm-5.3 却用的是别的」变成一桩查不到的事。
    throw new Error(
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