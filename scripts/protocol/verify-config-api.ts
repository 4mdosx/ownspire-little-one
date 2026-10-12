/**
 * 配置接口的验证：预算走真 HTTP，模型目录接口已经不存在。
 *
 * 为什么用真 HTTP 而不直接调函数：状态码与出站形状发生在路由层。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let assertions = 0
let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  assertions += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}`)
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`)
}

type Reply = { status: number; body: string; json: Record<string, unknown> }

function request(
  port: number,
  token: string,
  method: string,
  url: string,
  body?: unknown
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        // ⚠️ **必须用 Buffer.byteLength，不是 payload.length。**
        // 手写 Content-Length 时用字符数是个只在非 ASCII 下才犯的错：
        // 少了字节 → 服务端读到的 JSON 被截断 → 解析失败，
        // 而报错是「请求体不合法」，指向完全错误的方向。
        // 这里的 label 全是中文，所以这个坑一定会踩到。
        ...(payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {}),
      },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => (text += chunk))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            /* 非 JSON 就留空 */
          }
          resolve({ status: res.statusCode ?? 0, body: text, json })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main(): Promise<void> {
  // ⚠️ 必须在 import src 之前设好 —— 数据库单例在 import 时就解析路径。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-api-'))
  process.env.AGENT_DB_FILE = path.join(dir, 'agent.db')
  const token = 'verify-token-long-enough-0123456789'
  process.env.AGENT_RUNTIME_TOKEN = token
  // ⚠️ 这里曾有一行 `delete process.env.ZHIPU_API_KEY` —— 用来保证「库里没存」
  // 就是「没配置」。现在厂商状态只由库决定（2026-10-09 删了 env 线路），
  // 进程环境里有没有那把 key 都不影响任何断言，所以那行没用了。

  const { ensureSchema } = await import('../../src/db/database.js')
  const { buildRouter, createRequestListener } = await import('../../src/server.js')
  ensureSchema()

  const server = http.createServer(createRequestListener(buildRouter(token)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  try {
    console.log('\n[鉴权]')
    const noAuth = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config', method: 'GET' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.end()
    })
    check('没 token → 401', noAuth === 401, noAuth)

    console.log('\n[预算]')
    const initial = await request(port, token, 'GET', '/api/config')
    check('GET /api/config → 200', initial.status === 200, initial.status)
    const budget = initial.json['budget'] as { limit?: unknown } | undefined
    check('只返回预算', budget !== undefined && !('providers' in initial.json) && !('models' in initial.json), Object.keys(initial.json))
    check('响应里没有 apiKey', !initial.body.includes('apiKey'), initial.body.slice(0, 200))

    const put = await request(port, token, 'PUT', '/api/config/budget', { limit: 1000 })
    check('PUT 预算 → 200', put.status === 200 && (put.json['budget'] as { limit?: unknown })?.limit === 1000, put.body.slice(0, 200))

    console.log('\n[目录接口已经不存在]')
    const providers = await request(port, token, 'PUT', '/api/config/providers/zhipu', { label: '智谱' })
    check('PUT /api/config/providers → 404', providers.status === 404, providers.status)
    const models = await request(port, token, 'GET', '/api/models')
    check('GET /api/models → 404', models.status === 404, models.status)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('')
  console.log(`${assertions - failures}/${assertions} 条断言`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})