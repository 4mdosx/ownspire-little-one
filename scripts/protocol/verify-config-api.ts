/**
 * 配置目录接口的验证：增删改查走真 HTTP。
 *
 * 为什么用真 HTTP 而不直接调函数：这组接口的价值**全在出站形状与状态码上**
 * ——「key 不回显」「级联拒绝是 409」「删不掉是 404」这几条，直接调函数是验不到的，
 * 因为它们发生在序列化与路由层。
 *
 * ⚠️ 断言的主体是**搜字符串**而不是「字段在不在」：key 可能藏在别的字段里、
 * 被某个中间层拼进 message、或者字段名换了个马甲。搜是唯一全覆盖的办法。
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
  const { seedBuiltinProviders } = await import('../../src/db/registry-store.js')
  // ⚠️ 必须用**导出的那份接线**，不能自己拼一个 listener。
  // 自己拼那次拼错了（把 Router 实例当 request listener），症状是
  // 「请求发出去没响应、脚本挂到超时」—— 看起来像环境问题，其实是接线写错。
  const { buildRouter, createRequestListener } = await import('../../src/server.js')
  ensureSchema()
  seedBuiltinProviders()

  const server = http.createServer(createRequestListener(buildRouter(token)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const SECRET = 'sk-verify-DO-NOT-LEAK-424242'

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

    console.log('\n[读 · 出站形状]')
    const initial = await request(port, token, 'GET', '/api/config')
    check('GET /api/config → 200', initial.status === 200, initial.status)
    check('一次返回三段 + 默认模型', Array.isArray(initial.json['providers']) && Array.isArray(initial.json['endpoints']) && Array.isArray(initial.json['models']) && typeof initial.json['defaultModel'] === 'string', Object.keys(initial.json))
    check(
      '⚠️ 响应里搜不到 "apiKey" 字段',
      !initial.body.includes('"apiKey"'),
      initial.body.slice(0, 200)
    )
// ⚠️ 这里曾有一条注释说「不能断言 apiKeySet === false，因为 config/env.ts
  // 会在 import 时 loadEnv 把 .env 读进来」。**那条 caveat 已随env 线路一起作废**
  // （2026-10-09）—— 现在厂商状态只由库决定，与进程环境无关。
  // 但断言仍然落在**形状**上：具体状态会随 seed 与前面用例变化，
  // 而形状是契约。分清「值会变」与「形状会变」是两种不同的谨慎。
  const anyProvider = (initial.json['providers'] as Array<Record<string, unknown>>)[0]
  check(
    '厂商只给 key 状态（布尔 + 掩码），不给 key 本身',
    typeof anyProvider?.['apiKeySet'] === 'boolean' &&
      (anyProvider?.['apiKeyHint'] === null || typeof anyProvider?.['apiKeyHint'] === 'string') &&
      ['db', 'none'].includes(String(anyProvider?.['apiKeySource'])),
    anyProvider
  )
  check(
    '厂商视图不含 keyEnvVar（环境变量已不是来源）',
    !initial.body.includes('keyEnvVar'),
    initial.body.slice(0, 200)
  )
    check('端点行带 providerId 与模型数（界面分组要用）', typeof (initial.json['endpoints'] as Array<Record<string, unknown>>)[0]?.['providerId'] === 'string')

    console.log('\n[写 · 填 key]')
    const put = await request(port, token, 'PUT', '/api/config/providers/zhipu', {
      label: '智谱 GLM',
      apiKey: SECRET,
    })
    check('PUT 厂商 → 200', put.status === 200, put.body.slice(0, 200))
    check('⚠️⚠️ 写接口的响应里搜不到 key 明文', !put.body.includes(SECRET), put.body.slice(0, 200))
    check('回执里有掩码与来源', put.json['provider'] !== undefined && JSON.stringify(put.json).includes('db') && JSON.stringify(put.json).includes('4242'), put.json)

    const afterPut = await request(port, token, 'GET', '/api/config')
    check('⚠️⚠️ 之后的 GET 响应里也搜不到 key 明文', !afterPut.body.includes(SECRET))
    check(
      '来源标成 db（不再是 env）',
      (afterPut.json['providers'] as Array<Record<string, unknown>>).find((p) => p['id'] === 'zhipu')?.['apiKeySource'] === 'db'
    )

    console.log('\n[写 · 部分更新不能丢 key]')
    const labelOnly = await request(port, token, 'PUT', '/api/config/providers/zhipu', { label: '智谱（改名）' })
    check('只改标签 → 200', labelOnly.status === 200, labelOnly.body.slice(0, 200))
    check(
      'key 仍在（缺省不等于清空）',
      labelOnly.json['provider'] !== undefined &&
        JSON.stringify(labelOnly.json['provider']).includes('"apiKeySet":true'),
      labelOnly.json
    )

    const badKey = await request(port, token, 'PUT', '/api/config/providers/zhipu', { apiKey: 'x', clearApiKey: true })
    check('同时给 apiKey 与 clearApiKey → 4xx', badKey.status >= 400 && badKey.status < 500, badKey.status)

    console.log('\n[写 · 端点与模型]')
    const ep = await request(port, token, 'PUT', '/api/config/endpoints/kimi', {
      providerId: 'zhipu',
      label: 'Kimi（OpenAI 兼容）',
      baseUrl: 'https://api.moonshot.cn/v1',
    })
    check('新建端点 → 200', ep.status === 200, ep.body.slice(0, 200))
    const model = await request(port, token, 'PUT', '/api/config/models', {
      id: 'kimi-k2',
      endpointId: 'kimi',
      label: 'Kimi K2',
      reasoningEffort: 'high',
    })
    check('新建模型 → 200', model.status === 200, model.body.slice(0, 200))
    const badModel = await request(port, token, 'PUT', '/api/config/models', {
      id: 'x',
      endpointId: 'kimi',
      reasoningEffort: 'ludicrous',
    })
    check('非法 reasoningEffort → 4xx（不是 500）', badModel.status >= 400 && badModel.status < 500, badModel.status)

    console.log('\n[删 · 级联门禁]')
    const noCascade = await request(port, token, 'DELETE', '/api/config/providers/zhipu')
    check('厂商下有端点 → 409 cascade_required', noCascade.status === 409 && noCascade.json['code'] === 'cascade_required', { status: noCascade.status, body: noCascade.body.slice(0, 160) })
    const noCascadeEp = await request(port, token, 'DELETE', '/api/config/endpoints/kimi')
    check('端点上有模型 → 409', noCascadeEp.status === 409, noCascadeEp.status)
    const missing = await request(port, token, 'DELETE', '/api/config/providers/nope?cascade=1')
    check('删不存在的厂商 → 404', missing.status === 404, missing.status)

    const cascade = await request(port, token, 'DELETE', '/api/config/providers/zhipu?cascade=1')
    check('cascade=1 → 200', cascade.status === 200, cascade.body.slice(0, 200))
    check(
      '回执报清连带删了几个端点与模型',
      typeof cascade.json['removedEndpoints'] === 'number' &&
        typeof cascade.json['removedModels'] === 'number' &&
        (cascade.json['removedEndpoints'] as number) >= 2,
      cascade.json
    )
    const afterCascade = await request(port, token, 'GET', '/api/config')
    const leftEndpoints = (afterCascade.json['endpoints'] as Array<Record<string, unknown>>).map((e) => e['id'])
    const leftModels = (afterCascade.json['models'] as Array<Record<string, unknown>>).map((m) => m['id'])
    check('⚠️ 没留下孤立的端点', !leftEndpoints.includes('kimi') && !leftEndpoints.includes('zhipu-chat'), leftEndpoints)
    check('⚠️ 没留下指向不存在端点的模型', !leftModels.includes('kimi-k2') && !leftModels.includes('glm-5.3'), leftModels)
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