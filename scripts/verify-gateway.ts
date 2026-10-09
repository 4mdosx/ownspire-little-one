/**
 * raven gateway 的**真链路**冒烟。不需要模型，不需要 agent，但需要 raven 在跑。
 *
 * 与 `scripts/protocol/verify-tool-protocol.ts` 的分工：
 * 那边起假 raven 验「runtime 这半边有没有按协议说话」，这边打真 raven 验
 * **「协议的两端接得上」** —— 鉴权、真实文件系统、真实沙箱拒绝。
 *
 * 跑法：
 *   RAVEN_GATEWAY_TOKEN=... node --import tsx scripts/verify-gateway.ts
 */

const BASE = process.env.RAVEN_VERIFY_BASE ?? 'http://127.0.0.1:5800'
const TOKEN = process.env.RAVEN_GATEWAY_TOKEN ?? ''

let failures = 0
let assertions = 0

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

type Envelope = {
  status: number
  ok?: boolean
  v?: number
  data?: unknown
  error?: { code?: string; message?: string; retryable?: boolean }
}

async function call(payload: Record<string, unknown>, token: string | null): Promise<Envelope> {
  const response = await fetch(`${BASE}/api/agent/gateway`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ v: 1, ...payload }),
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { parseError: text.slice(0, 200) }
  }
  return {
    status: response.status,
    ok: body.ok as boolean | undefined,
    v: body.v as number | undefined,
    data: body.data,
    error: body.error as Envelope['error'],
  }
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error('需要 RAVEN_GATEWAY_TOKEN。')

  console.log('\n[鉴权]')
  const noToken = await call({ op: 'listTools' }, null)
  check('无 token → 401', noToken.status === 401, noToken)

  const wrongToken = await call({ op: 'listTools' }, 'definitely-wrong-token')
  check('错 token → 401', wrongToken.status === 401, wrongToken)

  const good = await call({ op: 'listTools' }, TOKEN)
  check('对 token → 200 且 ok:true', good.status === 200 && good.ok === true, good)
  check('响应带协议版本', good.v === 1, good)

  console.log('\n[发现]')
  const tools = (good.data as { tools?: { name: string; risk: string }[] })?.tools ?? []
  check('清单非空', tools.length >= 5, tools.length)
  check('全部是只读风险', tools.every((t) => t.risk === 'read'), tools.map((t) => `${t.name}:${t.risk}`))

  console.log('\n[调用 · 只读工具]')
  const stats = await call({ op: 'executeTool', toolName: 'raven.storage.stats', arguments: {} }, TOKEN)
  const statsResult = stats.data as { status?: string; output?: { bytes?: number } } | undefined
  check('storage.stats 终态 ok', statsResult?.status === 'ok', stats)
  check('storage.stats 带 bytes', typeof statsResult?.output?.bytes === 'number', statsResult?.output)

  const list = await call({ op: 'executeTool', toolName: 'raven.files.list', arguments: { path: '' } }, TOKEN)
  const listResult = list.data as { status?: string; output?: { entries?: unknown } } | undefined
  check('files.list 终态 ok', listResult?.status === 'ok', list)
  check('files.list 返回 entries 数组', Array.isArray(listResult?.output?.entries), listResult?.output)

  const escaped = await call(
    { op: 'executeTool', toolName: 'raven.files.list', arguments: { path: '../../etc' } },
    TOKEN
  )
  // ⚠️ 关键是它必须是**错误**，不能是一个成功的空列表 —— 后者意味着沙箱没判。
  check('路径越界被拒（不是空列表）', escaped.ok !== true, escaped)
  check(
    '越界给出 outside_root / invalid_path',
    ['outside_root', 'invalid_path'].includes(escaped.error?.code ?? ''),
    escaped.error
  )

  console.log('\n[错误语义]')
  const unknown = await call({ op: 'executeTool', toolName: 'raven.nope', arguments: {} }, TOKEN)
  check('未知工具 → 404 + unknown_tool', unknown.status === 404 && unknown.error?.code === 'unknown_tool', unknown)

  const badOp = await call({ op: 'nonsense' }, TOKEN)
  check('未知 op → 400 + invalid_request', badOp.status === 400 && badOp.error?.code === 'invalid_request', badOp)

  const badVersion = await call({ v: 99, op: 'listTools' }, TOKEN)
  check(
    '协议版本不匹配 → 400 + protocol_mismatch',
    badVersion.status === 400 && badVersion.error?.code === 'protocol_mismatch',
    badVersion
  )

  const badWorkspace = await call({ op: 'listTools', workspaceId: 'nowhere' }, TOKEN)
  check(
    '未知 workspace → 404 + workspace_unknown（不静默回退）',
    badWorkspace.status === 404 && badWorkspace.error?.code === 'workspace_unknown',
    badWorkspace
  )

  console.log('\n[取消]')
  const cancelMissing = await call({ op: 'cancelExecution', executionId: 'exe_never_started' }, TOKEN)
  check(
    '取消不认识的执行 → 404 + execution_not_found',
    cancelMissing.status === 404 && cancelMissing.error?.code === 'execution_not_found',
    cancelMissing
  )

  // 真跑一次然后取消它：来晚了也必须回答，而不是报「找不到」。
  const once = await call(
    { op: 'executeTool', toolName: 'raven.storage.stats', arguments: {}, executionId: 'exe_smoke_once' },
    TOKEN
  )
  const onceResult = once.data as { status?: string; executionId?: string } | undefined
  check('调用方给的 executionId 被沿用', onceResult?.executionId === 'exe_smoke_once', onceResult)

  const late = await call({ op: 'cancelExecution', executionId: 'exe_smoke_once' }, TOKEN)
  const lateData = late.data as { cancelled?: boolean; status?: string } | undefined
  check(
    '来晚的取消不是错误：cancelled=false 且回显终态',
    late.status === 200 && lateData?.cancelled === false && lateData?.status === 'ok',
    late
  )

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
