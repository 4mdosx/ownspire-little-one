import http from 'node:http'

/**
 * # Raven Tool Protocol v1 · client 侧往返
 *
 * 起一个假 raven（真 HTTP）跑完整往返。**不起真 raven** 是因为这段要验的是
 * 「runtime 这半边有没有按协议说话」，掺进 raven 的真实行为会让失败定位变慢。
 * 真链路的冒烟另有 `scripts/verify-gateway.ts`。
 *
 * 配套的服务端语义验证在 raven 侧：`scripts/verify-tool-protocol.ts`。
 * **两边测的是同一份协议的不同半边。**
 *
 * 与协议层其它测试一样：**不 import 任何 SDK。**
 */

const FAKE_TOOLS = [
  {
    name: 'fake.echo',
    title: '回声',
    description: '原样返回文本',
    inputSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string' as const, description: '要回显的文本' } },
      required: ['text'],
    },
    risk: 'read' as const,
  },
  {
    name: 'fake.add',
    title: '加法',
    description: '两数相加',
    inputSchema: {
      type: 'object' as const,
      properties: {
        a: { type: 'number' as const },
        b: { type: 'number' as const },
      },
      required: ['a', 'b'],
    },
    risk: 'read' as const,
  },
  {
    name: 'fake.pick',
    title: '选择',
    description: '从枚举里选一个',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: { type: 'string' as const, enum: ['alpha', 'beta'], description: '种类' },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
        limit: { type: 'integer' as const, minimum: 1, maximum: 10 },
      },
      required: ['kind'],
    },
    risk: 'read' as const,
  },
  {
    name: 'fake.fail',
    title: '必定失败',
    description: '返回 invalid_input，用来验错误传播',
    inputSchema: { type: 'object' as const, properties: {} },
    risk: 'read' as const,
  },
  {
    name: 'fake.disabled',
    title: '未开放',
    description: '出现在 disabled 里',
    inputSchema: { type: 'object' as const, properties: {} },
    risk: 'write' as const,
  },
]

type SeenRequest = Record<string, unknown> & { op?: string }

function startFakeRaven(): Promise<{
  url: string
  seen: SeenRequest[]
  cancelled: string[]
  close: () => Promise<void>
}> {
  const seen: SeenRequest[] = []
  const cancelled: string[] = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw || '{}') as SeenRequest & {
        v?: number
        op?: string
        toolName?: string
        arguments?: Record<string, unknown>
        executionId?: string
        workspaceId?: string
      }
      seen.push(body)

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (req.headers.authorization !== 'Bearer test-token') {
        send(401, { ok: false, v: 1, error: { code: 'unauthorized', message: 'token 不对', retryable: false } })
        return
      }
      if (body.v !== undefined && body.v !== 1) {
        send(400, { ok: false, v: 1, error: { code: 'protocol_mismatch', message: '版本不对', retryable: false } })
        return
      }
      if (body.workspaceId !== undefined && body.workspaceId !== 'workspace') {
        send(404, { ok: false, v: 1, error: { code: 'workspace_unknown', message: '没这个 workspace', retryable: false } })
        return
      }

      if (body.op === 'listTools') {
        send(200, {
          ok: true,
          v: 1,
          data: {
            protocolVersion: 1,
            workspaceId: 'workspace',
            tools: FAKE_TOOLS.filter((tool) => tool.name !== 'fake.disabled'),
            disabled: ['fake.disabled'],
          },
        })
        return
      }

      if (body.op === 'executeTool') {
        if (body.toolName === 'fake.fail') {
          send(400, {
            ok: false,
            v: 1,
            error: { code: 'invalid_input', message: '参数 path 必须是非空字符串。', retryable: false },
          })
          return
        }
        if (body.toolName === 'fake.nope') {
          send(404, { ok: false, v: 1, error: { code: 'unknown_tool', message: '没这个工具', retryable: false } })
          return
        }
        send(200, {
          ok: true,
          v: 1,
          data: {
            executionId: body.executionId ?? 'exe_generated',
            toolName: body.toolName,
            workspaceId: 'workspace',
            status: 'ok',
            output: { echoed: body.arguments ?? {} },
            error: null,
            startedAt: Date.now() - 5,
            endedAt: Date.now(),
            durationMs: 5,
          },
        })
        return
      }

      if (body.op === 'cancelExecution') {
        cancelled.push(String(body.executionId))
        send(200, {
          ok: true,
          v: 1,
          data: { executionId: body.executionId, status: 'cancelled', cancelled: true },
        })
        return
      }

      send(400, { ok: false, v: 1, error: { code: 'invalid_request', message: '未知 op', retryable: false } })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        cancelled,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

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

async function main(): Promise<void> {
  const fake = await startFakeRaven()

  // ⚠️ 环境变量必须在 import bridge 之前设好：RAVEN_URL/RAVEN_TOKEN 是
  // 模块里的常量函数，虽然每次调用都读 env，但**测试意图要明确** ——
  // 万一哪天改成模块加载期读一次，这里就是唯一不会骗人的写法。
  process.env.RAVEN_URL = fake.url
  process.env.RAVEN_GATEWAY_TOKEN = 'test-token'

  const { createRavenClient, loadRavenTools, RavenToolError, cancelRavenExecutions, resetRavenToolMemory } =
    await import('../../src/tools/raven.js')
  const { toZod } = await import('../../src/tools/json-schema.js')
  const { toolCatalog, findTool } = await import('../../src/tools/registry.js')
  const { RAVEN_TOOL_PROTOCOL_VERSION } = await import('../../src/protocol/raven-tool-protocol.js')

  const client = createRavenClient()

  // ── 发现 ──────────────────────────────────────────────────
  const listed = await client.listTools()
  check('listTools 返回协议版本与 workspaceId', listed.protocolVersion === 1 && listed.workspaceId === 'workspace', listed)
  check('listTools 返回工具清单', listed.tools.length === FAKE_TOOLS.length - 1, listed.tools.map((t) => t.name))
  check('未开放的工具单独列在 disabled 里', listed.disabled.includes('fake.disabled'), listed.disabled)

  check(
    '请求带上了协议版本',
    fake.seen[0]?.v === RAVEN_TOOL_PROTOCOL_VERSION,
    fake.seen[0]
  )

  // ── JSON Schema → zod ─────────────────────────────────────
  const echoSchema = toZod(listed.tools.find((t) => t.name === 'fake.echo')!.inputSchema)
  check('必填字段缺失时校验失败', echoSchema.safeParse({}).success === false)
  check('字段类型不对时校验失败', echoSchema.safeParse({ text: 42 }).success === false)
  check('合法入参通过校验', echoSchema.safeParse({ text: 'hi' }).success === true)

  const addSchema = toZod(listed.tools.find((t) => t.name === 'fake.add')!.inputSchema)
  check('两个必填字段都齐才通过', addSchema.safeParse({ a: 1 }).success === false && addSchema.safeParse({ a: 1, b: 2 }).success === true)

  const pickSchema = toZod(listed.tools.find((t) => t.name === 'fake.pick')!.inputSchema)
  check('enum 之外的取值被拒', pickSchema.safeParse({ kind: 'gamma' }).success === false, pickSchema.safeParse({ kind: 'gamma' }).error)
  check('enum 之内的取值通过', pickSchema.safeParse({ kind: 'beta' }).success === true)
  check('可选字段可以省略', pickSchema.safeParse({ kind: 'alpha' }).success === true)
  check('数组字段按 items 校验', pickSchema.safeParse({ kind: 'alpha', tags: [1] }).success === false)
  check('integer 的 minimum/maximum 生效', pickSchema.safeParse({ kind: 'alpha', limit: 99 }).success === false)

  check(
    '认不出来的类型降级成 any 而不是抛错',
    toZod({ type: 'something-unknown' as never }).safeParse({ anything: true }).success === true
  )
  check('缺省 schema 也降级成 any', toZod(undefined).safeParse('随便').success === true)

  // ── 注册 ──────────────────────────────────────────────────
  resetRavenToolMemory()
  const loaded = await loadRavenTools(client)
  check('工具被发现并注册', loaded.registered === listed.tools.length, loaded)
  check('加载成功时没有 error', loaded.error === null, loaded)
  check('disabled 原样带回', loaded.disabled.includes('fake.disabled'), loaded.disabled)

  const catalog = toolCatalog()
  const registered = catalog.find((entry) => entry.name === 'fake.echo')
  check('注册后的工具出现在 catalog 里', registered !== undefined, catalog.map((c) => c.name))
  check('注册后的 risk 来自 raven 的声明', registered?.risk === 'read', registered)
  check(
    'catalog 的 inputSchema 能被 UI 消费（有 properties）',
    typeof (registered?.inputSchema as { properties?: unknown })?.properties === 'object',
    registered?.inputSchema
  )

  const repeated = await loadRavenTools(client)
  check('重复加载不会炸（跳过已注册）', repeated.registered === 0 && repeated.skipped === listed.tools.length, repeated)

  // ── 调用 ──────────────────────────────────────────────────
  const executed = await client.executeTool({
    toolName: 'fake.echo',
    arguments: { text: 'hi' },
    executionId: 'exe_test_1',
  })
  check('executeTool 成功：status ok 且 output 到位', executed.status === 'ok' && (executed.output as { echoed: { text: string } }).echoed.text === 'hi', executed)
  check('executeTool 沿用调用方给的 executionId', executed.executionId === 'exe_test_1', executed.executionId)
  check('成功时 error 是 null', executed.error === null)

  const generated = await client.executeTool({ toolName: 'fake.echo', arguments: { text: 'x' } })
  check('没给 executionId 时 raven 生成一个', generated.executionId.startsWith('exe_'), generated.executionId)

  const lastExecute = [...fake.seen].reverse().find((entry) => entry.op === 'executeTool')
  check('执行请求带上了 arguments', JSON.stringify(lastExecute?.arguments) === JSON.stringify({ text: 'x' }), lastExecute)

  // ── 错误 ──────────────────────────────────────────────────
  let caught: unknown = null
  try {
    await client.executeTool({ toolName: 'fake.fail', arguments: {} })
  } catch (error) {
    caught = error
  }
  check('raven 的错误被转成 RavenToolError', caught instanceof RavenToolError, caught)
  check('错误码原样保留（invalid_input）', (caught as { code?: string })?.code === 'invalid_input', caught)
  check(
    '错误 message 保留 raven 的原话（模型要靠它改参数）',
    String((caught as Error)?.message ?? '').includes('path'),
    (caught as Error)?.message
  )

  let unknownCaught: unknown = null
  try {
    await client.executeTool({ toolName: 'fake.nope', arguments: {} })
  } catch (error) {
    unknownCaught = error
  }
  check('未知工具 → unknown_tool', (unknownCaught as { code?: string })?.code === 'unknown_tool', unknownCaught)

  let workspaceError: unknown = null
  try {
    await client.listTools('somewhere-else')
  } catch (error) {
    workspaceError = error
  }
  check('未知 workspace → workspace_unknown', (workspaceError as { code?: string })?.code === 'workspace_unknown', workspaceError)

  // ── 取消 ──────────────────────────────────────────────────
  const cancelled = await client.cancelExecution('exe_test_1')
  check('cancelExecution 往返成功', cancelled.cancelled === true && cancelled.executionId === 'exe_test_1', cancelled)
  check('取消请求真的发到了 raven', fake.cancelled.includes('exe_test_1'), fake.cancelled)

  const batch = await cancelRavenExecutions(['exe_a', 'exe_b'])
  check('批量取消返回条数', batch.cancelled === 2 && batch.failed === 0, batch)

  // ── 未配置时降级 ──────────────────────────────────────────
  const savedToken = process.env.RAVEN_GATEWAY_TOKEN
  delete process.env.RAVEN_GATEWAY_TOKEN
  const withoutToken = await loadRavenTools()
  check('没配 token 时加载返回 error 而不是抛（raven 是工具来源不是运行前提）', withoutToken.error !== null && withoutToken.registered === 0, withoutToken)
  process.env.RAVEN_GATEWAY_TOKEN = savedToken

  // ── 工具执行路径（走 registry 的 execute）────────────────
  // ⚠️ registry 是异构的：装着入参各不相同的工具，所以它的公开类型把入参擦成
  // `never`——**逼调用方自己声明它知道这个工具吃什么**，而不是让 TS 放行盲调。
  // 测试里我们确实知道 fake.echo 吃 { text }，所以在这里显式还原。
  type ErasedTool = { execute: (input: unknown) => Promise<unknown> }
  const asExecutable = (name: string): ErasedTool | undefined =>
    findTool(name) as unknown as ErasedTool | undefined

  const toolOutput = await asExecutable('fake.echo')?.execute({ text: 'through-registry' })
  check(
    '通过注册表执行 → 真打到 raven',
    (toolOutput as { echoed?: { text?: string } })?.echoed?.text === 'through-registry',
    toolOutput
  )

  let toolError: unknown = null
  try {
    await asExecutable('fake.fail')?.execute({})
  } catch (error) {
    toolError = error
  }
  check('注册表的执行把 raven 的错误抛出来', toolError instanceof RavenToolError, toolError)

  await fake.close()

  console.log('')
  console.log(`${assertions - failures}/${assertions} 条断言`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
