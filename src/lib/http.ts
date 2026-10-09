import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * HTTP 骨架。一个手写的路由器，不是 express —— 依赖少一个，
 * 而这个项目真正需要的只是「按method +路径前缀分发」。
 *
 * 与 raven / navi 一致的服务契约：
 * - `/healthz` 不鉴权（infra 的 deploy 要在无凭据环境下工作），且不返回任何路径与密钥。
 * - 其余接口全部要求 Bearer token，契约 §二。
 */

export type Json = Record<string, unknown>

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { code: error.code, error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { code: 'internal_error', error: message })
}

export async function readJson<T>(req: IncomingMessage, limitBytes = 1_000_000): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limitBytes) throw new HttpError(413, 'payload_too_large', '请求体过大。')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {} as T
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON。')
  }
}

/**
 * 校验 Bearer token。
 *
 * **用定长比较**，且**没有配置 token 时直接拒绝**——
 * 「没配token」如果当成「不校验」，就是一个静默的完全认证绕过。
 * （raven 的 verify 脚本抓出过同一个 bug，这里是照着那条教训写的。）
 */
export function requireAuth(req: IncomingMessage, expected: string): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    throw new HttpError(401, 'unauthorized', '缺少 Bearer token。')
  }
  const provided = header.slice('Bearer '.length).trim()
  if (!timingSafe(provided, expected)) {
    throw new HttpError(401, 'unauthorized', 'token 不匹配。')
  }
}

function timingSafe(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 路由表。path 里的 `:param` 是位置参数。 */
type Handler = (context: {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
}) => Promise<void> | void

type Route = { method: string; segments: string[]; handler: Handler }

export class Router {
  private routes: Route[] = []

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: path.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  get(path: string, handler: Handler): this {
    return this.add('GET', path, handler)
  }
  post(path: string, handler: Handler): this {
    return this.add('POST', path, handler)
  }
  delete(path: string, handler: Handler): this {
    return this.add('DELETE', path, handler)
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index]!
        const part = parts[index]!
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part)
        else if (segment !== part) {
          ok = false
          break
        }
      }
      if (ok) return { handler: route.handler, params }
    }
    return null
  }
}