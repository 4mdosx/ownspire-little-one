import { HttpError } from './lib/http.js'
import { classifyModelError } from './protocol/model-error.js'
import type { ProtocolFamily } from './protocol/driver.js'
import {
  findModel,
  listEndpointRows,
  listModels,
  listProviders,
  tryDefaultModelId,
  type EndpointRowView,
} from './db/registry-store.js'

/**
 * 连接检测：用这把 key 发一条最短对话，把厂商的原话带回来。
 *
 * 不走 Agent 的工具循环，也不带 reasoning_effort。那一轮会重试三次、
 * 把厂商原文包成「Failed after 3 attempts」，界面上看不出是 key、地址还是余额。
 * 这里只发一次，状态码和原文原样返回。
 *
 * ⚠️ **响应里不许出现 key。** 调用方传来的 key 只进请求头，不进结果、不进错误文案。
 */

export type ProbeResult = {
  /** 请求送到了厂商（含 4xx/5xx）。连不上是 false。 */
  reached: boolean
  endpointId: string
  modelId: string
  baseUrl: string
  statusCode: number
  reply: string | null
  error: string | null
  code: string | null
  hint: string | null
}

const PROBE_TIMEOUT_MS = 20_000

export async function probeProvider(input: {
  providerId: string
  /** 输入框里还没保存的 key。空 = 用库里那把。 */
  apiKey?: string
  endpointId?: string
}): Promise<ProbeResult> {
  const provider = listProviders().find((item) => item.id === input.providerId)
  if (!provider) {
    throw new HttpError(404, 'provider_not_found', `没有这个厂商：${input.providerId}`)
  }

  const override = input.apiKey?.trim() ?? ''
  const key = override !== '' ? override : (provider.apiKey?.trim() ?? '')
  if (key === '') {
    throw new HttpError(400, 'invalid_config', '这个厂商还没配 key，检测发不出去。')
  }
  assertHeaderSafe(key)

  const target = pickTarget(input.providerId, input.endpointId)
  const baseUrl = resolveBaseUrl(target.endpoint)
  const request = buildRequest(target.endpoint.protocol, baseUrl, target.modelId, key, target.endpoint.extraBody)

  let statusCode = 0
  let raw = ''
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    statusCode = response.status
    raw = await response.text()
  } catch (error) {
    return {
      reached: false,
      endpointId: target.endpoint.id,
      modelId: target.modelId,
      baseUrl,
      statusCode: 0,
      reply: null,
      error: redact(describeFetchError(error), key),
      code: 'model_upstream_error',
      hint: '请求没有送到厂商。看地址是否可连，或稍后再试。',
    }
  }

  const safeRaw = redact(raw, key)
  if (statusCode >= 200 && statusCode < 300) {
    return {
      reached: true,
      endpointId: target.endpoint.id,
      modelId: target.modelId,
      baseUrl,
      statusCode,
      reply: extractReply(target.endpoint.protocol, safeRaw),
      error: null,
      code: null,
      hint: null,
    }
  }

  const facts = vendorFacts(statusCode, safeRaw)
  const classified = classifyModelError(facts)
  return {
    reached: true,
    endpointId: target.endpoint.id,
    modelId: target.modelId,
    baseUrl,
    statusCode,
    reply: null,
    error: classified.error,
    code: classified.code,
    hint: quotaHint(baseUrl, classified.code, classified.hint),
  }
}

function pickTarget(providerId: string, endpointId: string | undefined): { endpoint: EndpointRowView; modelId: string } {
  const rows = listEndpointRows().filter((item) => item.providerId === providerId)
  const endpoint = endpointId
    ? rows.find((item) => item.id === endpointId)
    : preferredEndpoint(providerId, rows) ?? rows.find((item) => item.enabled === 1 && modelOn(item.id))
  if (!endpoint) {
    throw new HttpError(
      endpointId ? 404 : 400,
      endpointId ? 'endpoint_not_found' : 'invalid_config',
      endpointId
        ? `厂商 ${providerId} 下没有端点 ${endpointId}。`
        : '这个厂商没有挂着模型的启用端点，检测不知道该打到哪。'
    )
  }
  if (endpoint.enabled !== 1) {
    throw new HttpError(400, 'invalid_config', `端点 ${endpoint.id} 是停用的。`)
  }
  const model = listModels().find((item) => item.endpointId === endpoint.id)
  if (!model) {
    throw new HttpError(400, 'invalid_config', `端点 ${endpoint.id} 上没有启用的模型。`)
  }
  return { endpoint, modelId: model.id }
}

/** 默认模型挂在这个厂商上就测它，否则测该厂商第一个有模型的启用端点。 */
function preferredEndpoint(providerId: string, rows: EndpointRowView[]): EndpointRowView | undefined {
  const modelId = tryDefaultModelId()
  if (!modelId) return undefined
  const model = findModel(modelId)
  if (!model) return undefined
  return rows.find((item) => item.id === model.endpointId && item.providerId === providerId && item.enabled === 1)
}

function modelOn(endpointId: string): boolean {
  return listModels().some((item) => item.endpointId === endpointId)
}

function resolveBaseUrl(endpoint: EndpointRowView): string {
  if (endpoint.baseUrl && endpoint.baseUrl.trim() !== '') return endpoint.baseUrl.replace(/\/+$/, '')
  if (endpoint.protocol === 'openai-chat-completions') return 'https://api.openai.com/v1'
  if (endpoint.protocol === 'anthropic-messages') return 'https://api.anthropic.com'
  throw new HttpError(400, 'invalid_config', `端点 ${endpoint.id} 没有地址，而且协议 ${endpoint.protocol} 没有默认地址。`)
}

function buildRequest(
  protocol: ProtocolFamily,
  baseUrl: string,
  modelId: string,
  key: string,
  extraBody: Record<string, unknown> | null
): { url: string; headers: Record<string, string>; body: string } {
  if (protocol === 'openai-chat-completions') {
    return {
      url: `${baseUrl}/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
        ...(extraBody ?? {}),
      }),
    }
  }
  if (protocol === 'anthropic-messages') {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }
  }
  throw new HttpError(400, 'invalid_config', `协议 ${protocol} 还不能做连接检测。`)
}

/**
 * HTTP 头是 ByteString：码点 > 255 会在发出去之前抛
 * `Cannot convert argument to a ByteString`，界面只能显示成 Runtime 内部错误。
 * 在这里拦住，并说明该粘贴什么。
 */
function assertHeaderSafe(key: string): void {
  for (let index = 0; index < key.length; index += 1) {
    if (key.charCodeAt(index) > 255) {
      throw new HttpError(
        400,
        'invalid_config',
        'key 里有中文或其它非 ASCII 字符，HTTP 头装不下。请粘贴厂商控制台给出的 key，不要把页面上的报错文案粘进来。'
      )
    }
  }
}

function redact(text: string, key: string): string {
  return key === '' ? text : text.split(key).join('***')
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '连接超时（20 秒内没有返回）。'
    return error.message
  }
  return String(error)
}

function vendorFacts(statusCode: number, raw: string): { statusCode: number; vendorCode: string; message: string } {
  let vendorCode = ''
  let message = raw.slice(0, 300)
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown }
    const error = parsed.error
    if (typeof error === 'string' && error !== '') message = error
    else if (error !== null && typeof error === 'object') {
      const record = error as { message?: unknown; code?: unknown; type?: unknown }
      if (typeof record.message === 'string' && record.message !== '') message = record.message
      if (typeof record.code === 'string' || typeof record.code === 'number') vendorCode = String(record.code)
      else if (typeof record.type === 'string') vendorCode = record.type
    } else if (typeof parsed.message === 'string' && parsed.message !== '') {
      message = parsed.message
    }
  } catch {
    /* 非 JSON 就用原文 */
  }
  return { statusCode, vendorCode, message }
}

function extractReply(protocol: ProtocolFamily, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>
      content?: Array<{ type?: unknown; text?: unknown }>
    }
    if (protocol === 'openai-chat-completions') {
      const message = parsed.choices?.[0]?.message
      const content = typeof message?.content === 'string' ? message.content.trim() : ''
      if (content !== '') return content.slice(0, 200)
      const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content.trim() : ''
      if (reasoning !== '') return `已接通（模型把额度用在了推理上）：${reasoning.slice(0, 80)}`
    }
    if (protocol === 'anthropic-messages' && Array.isArray(parsed.content)) {
      const text = parsed.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text))
        .join('')
        .trim()
      if (text !== '') return text.slice(0, 200)
    }
  } catch {
    /* 2xx 但不是 JSON：下面用原文兜底 */
  }
  const trimmed = raw.trim()
  return trimmed === '' ? '已接通，厂商返回了空回复。' : trimmed.slice(0, 200)
}

/**
 * 智谱把「打错计费通道」也说成余额不足。
 * `/api/paas/v4` 扣按量资源包；编码套餐的同一把 key 在那里就是 1113，
 * 而 `/api/coding/paas/v4` 才扣套餐额度。hint 不说清这一点，用户会去充值。
 */
function quotaHint(baseUrl: string, code: string, hint: string): string {
  if (code === 'model_quota_exhausted' && baseUrl.includes('/api/paas/v4') && !baseUrl.includes('/api/coding/')) {
    return '这把 key 通过了鉴权，但这个地址扣的是按量资源包。编码套餐要把端点改成 https://open.bigmodel.cn/api/coding/paas/v4 。'
  }
  return hint
}
