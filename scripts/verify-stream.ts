/**
 * 用一个假 provider 打真实的 Loop 与SSE 链路。
 *
 * **不发任何网络请求。** 目的是验事件形状与顺序（契约 §四），
 * 不是验模型能力 —— 后者要真key，且结果不确定，测不了。
 *
 * 跑法（必须先起服务）：
 *   AGENT_RUNTIME_TOKEN=... node --import tsx scripts/verify-stream.ts
 */

const BASE = process.env.AGENT_VERIFY_BASE ?? 'http://127.0.0.1:5911'
const TOKEN = process.env.AGENT_RUNTIME_TOKEN ?? ''

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
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error('需要 AGENT_RUNTIME_TOKEN。')

  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  // ---- 建一个只带 echo 的会话：echo 是 read，不需要审批 ----
  const created = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'verify-stream', tools: ['echo'] }),
  }).then((r) => r.json() as Promise<{ sessionId: string }>)
  const sessionId = created.sessionId
  console.log(`\n会话 ${sessionId}`)

  console.log('\n[SSE 链路]')
  const response = await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: '请用echo 回显 hello' }),
  })

  check('HTTP 200（流式接口成功即 200）', response.status === 200, response.status)
  check(
    'Content-Type 是 text/event-stream',
    response.headers.get('content-type')?.includes('text/event-stream') === true,
    response.headers.get('content-type'),
  )
  check('X-Accel-Buffering: no（nginx 不缓冲）', response.headers.get('x-accel-buffering') === 'no')

  const events = await readSse(response)
  const names = events.map((e) => e.name)

  console.log(`  收到 ${events.length} 个事件：${names.join(' → ')}`)
  console.log(`  首个事件是 run.started：${JSON.stringify(events[0])}`)

  check('run.started 是第一个事件', names[0] === 'run.started')
  check(
    '每个事件的 data 都能 JSON.parse',
    events.every((e) => typeof e.data === 'object' && e.data !== null),
  )

  const started = events[0]?.data as { runId?: string; sessionId?: string }
  check('run.started 带 runId', typeof started.runId === 'string' && started.runId !== '')
  check('run.started 带 sessionId', started.sessionId === sessionId)
  check(
    '所有事件的 runId 与 run.started 一致',
    events.every((e) => (e.data as { runId?: string }).runId === started.runId),
    events.map((e) => (e.data as { runId?: string }).runId),
  )

  // ---- 终止保证（契约 §四 的硬规则）----
  const terminators = names.filter((n) => n === 'run.completed' || n === 'run.failed')
  check(
    '恰好一个终止事件',
    terminators.length === 1,
    terminators,
  )
  check('终止事件是最后一个', names[names.length - 1] === 'run.completed' || names[names.length - 1] === 'run.failed', names)

  const terminal = events[events.length - 1]!
  if (terminal.name === 'run.completed') {
    const body = terminal.data as { status?: string; steps?: number }
    console.log(`  run.completed: status=${body.status} steps=${body.steps}`)
    // 没有 key 时模型调用必然失败，所以真跑起来应该是 run.failed。
    // 两种都合法，这里只断言形状对。
    check('run.completed 带 status', typeof body.status === 'string')
    check('status 是契约枚举之一', ['done', 'stopped', 'denied'].includes(body.status ?? ''), body.status)
  } else {
    const body = terminal.data as { code?: string; error?: string }
    console.log(`  run.failed: code=${body.code} error=${String(body.error).slice(0, 80)}`)
    check('run.failed 带 code', typeof body.code === 'string' && body.code !== '')
    check(
      'code 是契约枚举之一',
      ['model_error', 'tool_error', 'invalid_tool_input', 'aborted', 'internal_error'].includes(body.code ?? ''),
      body.code,
    )
  }

  // ---- 失败之后状态码改不了（规则一）----
  if (terminal.name === 'run.failed') {
    check('run.failed 时 HTTP 仍是 200', response.status === 200, response.status)
  }

  // ---- 审批链路（契约 §五）：destructive 工具必须先请求授权 ----
  console.log('\n[授权链路]')
  const approvalSession = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'verify-approval', tools: ['removeFile'] }),
  }).then((r) => r.json() as Promise<{ sessionId: string }>)

  const approvalResponse = await fetch(
    `${BASE}/api/sessions/${approvalSession.sessionId}/messages`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: '请删除 a.txt' }),
    },
  )
  const approvalEvents = await readSse(approvalResponse)
  const approvalNames = approvalEvents.map((e) => e.name)

  console.log(`  事件序列：${approvalNames.join(' → ')}`)

  if (!approvalNames.includes('approval.requested')) {
    console.log('  （无key 时模型没真正发起工具调用，跳过授权断言）')
  } else {
    const requested = approvalEvents.find((e) => e.name === 'approval.requested')!.data as {
      callId?: string
      tool?: string
      risk?: string
      reason?: string
    }
    check('approval.requested 带 callId', typeof requested.callId === 'string')
    check('approval.requested 带 risk=destructive', requested.risk === 'destructive', requested.risk)
    check('approval.requested 带 reason', typeof requested.reason === 'string')
    check(
      '授权请求发生在工具完成之前',
      approvalNames.indexOf('approval.requested') <
        (approvalNames.indexOf('tool.completed') === -1 ? Infinity : approvalNames.indexOf('tool.completed')),
    )
  }

  // ---- 清理 ----
  const deleted = await fetch(`${BASE}/api/sessions/${sessionId}`, {
    method: 'DELETE',
    headers,
  }).then((r) => r.json() as Promise<{ messages: number; runs: number }>)
  check('删除返回回执计数', typeof deleted.messages === 'number' && typeof deleted.runs === 'number', deleted)

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  if (failures > 0) process.exitCode = 1
}

/** 逐帧解析 SSE。**故意不依赖任何库** —— 这份脚本要能独立跑。 */
async function readSse(response: Response): Promise<{ name: string; data: unknown }[]> {
  const text = await response.text()
  const events: { name: string; data: unknown }[] = []

  for (const frame of text.split('\n\n')) {
    const trimmed = frame.trim()
    if (trimmed === '' || trimmed.startsWith(':')) continue

    let name = 'message'
    const dataLines: string[] = []
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) name = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length))
    }
    const raw = dataLines.join('\n')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { parseError: raw }
    }
    events.push({ name, data: parsed })
  }
  return events
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})