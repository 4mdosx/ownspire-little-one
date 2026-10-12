/**
 * little-one 的唯一模型上游：本机 Magpie 网关。
 *
 * Chat / Responses / Messages / Gemini 的互译在 Magpie 进程里。
 * 这里只给出「去哪、用哪把网关 key」。厂商的 baseUrl、协议和 API key
 * 不从这层读 —— 那些配在 Magpie 里。
 *
 * 地址和网关 key 是部署参数，和 `RAVEN_URL` 同一类，不是模型目录。
 */

const DEFAULT_CHAT_BASE = 'http://127.0.0.1:3425/v1'

/** Magpie 的 OpenAI Chat 根，SDK 会在后面接 `/chat/completions`。 */
export function magpieChatBaseUrl(): string {
  const raw = process.env.MAGPIE_BASE_URL?.trim() || DEFAULT_CHAT_BASE
  return raw.replace(/\/+$/, '')
}

/**
 * Magpie 的源站。claude-cli 的 `ANTHROPIC_BASE_URL` 要这个，不要带 `/v1`：
 * 网关自己在 `/v1/messages` 和 `/messages` 上接 Anthropic。
 */
export function magpieOrigin(): string {
  const base = magpieChatBaseUrl()
  return base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base
}

/**
 * 本机 Magpie 默认认的调用方 token 就是 `magpie`。
 * 设了 `MAGPIE_API_KEY` 就用那一把（局域网共享时的 gateway key）。
 */
export function magpieApiKey(): string {
  const raw = process.env.MAGPIE_API_KEY?.trim()
  return raw ? raw : 'magpie'
}

/**
 * Magpie 认识的模型名，例如 `zhipu/glm-5.3` 或一个路由组。
 * 部署参数，和地址同一类：little-one 不保存厂商、key、协议，也不提供选择。
 */
export function requireMagpieModel(): string {
  const raw = process.env.MAGPIE_MODEL?.trim()
  if (!raw) {
    throw new Error(
      'MAGPIE_MODEL 未设置。little-one 只向 Magpie 发 Chat Completions，' +
        '这个值是 Magpie 上的模型名或路由组。厂商 key 与协议配在 Magpie 里。',
    )
  }
  return raw
}

export function magpieListen(): { host: string; port: number } {
  const origin = magpieOrigin()
  const url = new URL(origin.includes('://') ? origin : `http://${origin}`)
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { host: url.hostname, port }
}
