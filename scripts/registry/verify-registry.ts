/**
 * # 测试组 C · 目录层（厂商 → 端点 → 模型）
 *
 * 验的是**「多家 SDK / 多厂商能用数据库管起来」**这件事本身：
 *
 * 1. 厂商是一级概念，key 挂在厂商上
 * 2. **协议挂在端点上**，同一厂商的不同端点可以是不同协议
 *    （这是「Adapter 按协议切而不是按厂商切」的现实依据）
 * 3. 模型挂在端点上，同一模型名可以在多个端点各存一份
 * 4. 写错的东西**当场报错**，而不是等跑起来才发现
 *
 * ⚠️ 用真 SQLite（`/tmp` 下的临时库），不用 mock ——
 * 这一组验的恰恰是 SQL 约束与外键，mock 掉就等于没验。
 */

import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ **必须在 import 任何 src 模块之前设好** —— 数据库单例在 import 时就解析路径。
const dir = mkdtempSync(join(tmpdir(), 'agent-registry-'))
process.env.AGENT_DB_FILE = join(dir, 'agent.db')

const { ensureSchema } = await import('../../src/db/database.js')
const {
  findEndpoint,
  firstModel,
  listEndpoints,
  listModels,
  listProviders,
  listProviderViews,
  missingKeys,
  seedBuiltinProviders,
  upsertEndpoint,
  upsertModel,
  upsertProvider,
} = await import('../../src/db/registry-store.js')

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

/** 期望抛错。**不抛就是没拦住**，那种「静默接受」比报错难查得多。 */
function checkThrows(label: string, fn: () => void, expectInMessage?: string): void {
  assertions += 1
  try {
    fn()
    failures += 1
    console.log(`  ✗ ${label}（没抛错）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (expectInMessage && !message.includes(expectInMessage)) {
      failures += 1
      console.log(`  ✗ ${label}（错误信息没说清：${message.slice(0, 120)}）`)
      return
    }
    console.log(`  ✓ ${label}`)
  }
}

function main(): void {
  console.log('\n════ 测试组 C · 目录层（厂商 → 端点 → 模型）════\n')
  ensureSchema()

  console.log('[厂商是一级概念]')
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM',
    keyEnvVar: 'ZHIPU_API_KEY',
    defaultProtocol: 'openai-chat-completions',
  })
  check('厂商建出来后能列出', listProviders().some((p) => p.id === 'zhipu'))

  // ⚠️ 这里守的是**出站脱敏**，不是「库里没有 key」（2026-10-09 裁定 key 入库）。
  // 纪律换了位置：以前是「key 不许存在」，现在是「key 存在但不许出站」。
  // 断言的对象必须是**类型**而不是人的记性 —— 让想泄漏都泄漏不出去。
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM',
    keyEnvVar: 'ZHIPU_API_KEY',
    defaultProtocol: 'openai-chat-completions',
    apiKey: 'sk-test-abcdefgh1234',
  })
  const view = listProviderViews().find((p) => p.id === 'zhipu')
  check('库里确实存了 key（裁定如此）', listProviders().find((p) => p.id === 'zhipu')?.apiKey !== null)
  check('出站视图不含apiKey 字段', view !== undefined && !('apiKey' in view), Object.keys(view ?? {}))
  check(
    '出站视图只给末四位掩码',
    view?.apiKeyHint === '****1234',
    view?.apiKeyHint
  )
  check('出站视图标明 key 已配置', view?.apiKeySet === true)
  check('出站视图标明来源是库', view?.apiKeySource === 'db', view?.apiKeySource)
  // ⚠️ 真正的泄漏防线：**把整个响应序列化一遍搜字符串**。
  // 只检查字段在不在是不够的 —— key 可能藏在别的字段里、被日志带出去、
  // 或者某个字段名换了个马甲。搜字符串是唯一能覆盖全部情况的办法。
  check(
    '⚠️ 整个出站对象的 JSON 里搜不到 key 明文',
    !JSON.stringify(listProviderViews()).includes('sk-test-abcdefgh1234')
  )

  // ⚠️ 改个标签不该把 key 弄丢 —— 「保存没碰 key 的表单」是界面上的常态。
  // 缺省等于清空的话，用户改个标签就会突然报 key 无效，而完全想不到是自己干的。
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM（改名）',
    keyEnvVar: 'ZHIPU_API_KEY',
    defaultProtocol: 'openai-chat-completions',
  })
  check(
    '只改标签时 key 保持不变',
    listProviders().find((p) => p.id === 'zhipu')?.apiKey === 'sk-test-abcdefgh1234'
  )
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM（改名）',
    keyEnvVar: 'ZHIPU_API_KEY',
    defaultProtocol: 'openai-chat-completions',
    clearApiKey: true,
  })
  check(
    'clearApiKey 才真的清掉',
    listProviders().find((p) => p.id === 'zhipu')?.apiKey === null
  )
  try {
    upsertProvider({
      id: 'zhipu',
      label: 'x',
      keyEnvVar: 'X',
      defaultProtocol: 'openai-chat-completions',
      apiKey: 'a',
      clearApiKey: true,
    })
    check('同时给 apiKey 与 clearApiKey 应报错（相反的意图）', false)
  } catch {
    check('同时给 apiKey 与 clearApiKey 应报错（相反的意图）', true)
  }
  // 恢复成无 key 状态，免得影响后面的用例
  upsertProvider({
    id: 'zhipu',
    label: '智谱 GLM',
    keyEnvVar: 'ZHIPU_API_KEY',
    defaultProtocol: 'openai-chat-completions',
    clearApiKey: true,
  })

  console.log('\n[协议挂在端点上]')
  // 智谱的现实情况：同一家厂商、同一个 key，三个端点两种协议。
  upsertEndpoint({
    id: 'zhipu-chat',
    providerId: 'zhipu',
    label: '智谱 Chat Completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    extraBody: { thinking: { type: 'enabled' } },
  })
  upsertEndpoint({
    id: 'zhipu-anthropic',
    providerId: 'zhipu',
    label: '智谱 Anthropic 兼容',
    protocol: 'anthropic-messages',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  })

  const chat = findEndpoint('zhipu-chat')
  const anthropic = findEndpoint('zhipu-anthropic')
  check('没指定协议的端点**继承厂商默认**', chat?.protocol === 'openai-chat-completions', chat)
  check('指定了协议的端点**覆盖厂商默认**', anthropic?.protocol === 'anthropic-messages', anthropic)
  check(
    '**同一厂商可以有不同协议的多个端点**（所以 Adapter 按协议切）',
    chat?.protocol !== anthropic?.protocol,
    [chat?.protocol, anthropic?.protocol],
  )
  check('keyEnvVar 从厂商继承，端点自己不持有', anthropic?.keyEnvVar === 'ZHIPU_API_KEY', anthropic)
  check(
    'extraBody 存读往返（GLM 的 thinking）',
    JSON.stringify(chat?.extraBody) === JSON.stringify({ thinking: { type: 'enabled' } }),
    chat?.extraBody,
  )

  console.log('\n[写错的当场报错]')
  checkThrows(
    '协议写成厂商名 → 报错，且说清「是协议不是厂商」',
    () => upsertEndpoint({ id: 'bad', providerId: 'zhipu', label: 'x', protocol: 'zhipu' as never }),
    '协议名',
  )
  checkThrows(
    '端点引用不存在的厂商 → 报错（不静默挂空引用）',
    () => upsertEndpoint({ id: 'orphan', providerId: 'nope', label: 'x' }),
    '不存在的厂商',
  )
  checkThrows(
    'reasoningEffort 写成非法值 → 报错',
    () => upsertModel({ id: 'm', endpointId: 'zhipu-chat', label: 'M', reasoningEffort: 'ultra' as never }),
    'low / high / max',
  )

  console.log('\n[模型挂在端点上]')
  upsertModel({ id: 'glm-5.3', endpointId: 'zhipu-chat', label: 'GLM-5.3', reasoningEffort: 'high' })
  upsertModel({ id: 'glm-5.3', endpointId: 'zhipu-anthropic', label: 'GLM-5.3（Anthropic 端点）' })
  const models = listModels()
  check(
    '**同一个模型名可以在两个端点各存一份**（(endpointId,id) 唯一，不是 id 唯一）',
    models.filter((m) => m.id === 'glm-5.3').length === 2,
    models,
  )
  check(
    '按端点能查到自己的那份',
    models.find((m) => m.endpointId === 'zhipu-anthropic')?.label === 'GLM-5.3（Anthropic 端点）',
    models,
  )
  check('第一个可用模型有值（没指定模型时用它）', firstModel() !== undefined, firstModel())
  check('可以限定在某个端点内取第一个', firstModel('zhipu-anthropic')?.endpointId === 'zhipu-anthropic')

  console.log('\n[停用端点]')
  upsertEndpoint({ id: 'zhipu-anthropic', providerId: 'zhipu', label: '智谱 Anthropic 兼容', enabled: false })
  check('停用的端点不出现在默认列表里', !listEndpoints().some((e) => e.id === 'zhipu-anthropic'))
  check(
    '但配置还在（includeDisabled 能取回）',
    listEndpoints(true).some((e) => e.id === 'zhipu-anthropic'),
  )

  console.log('\n[缺 key 的报告]')
  delete process.env.ZHIPU_API_KEY
  const missing = missingKeys()
  check(
    '**只报有启用端点的厂商** —— 建了厂商但没建端点的不该让启动失败',
    missing.some((m) => m.provider === 'zhipu' && m.envVar === 'ZHIPU_API_KEY'),
    missing,
  )
  check('报告里给的是环境变量名，不是 key', missing.every((m) => !m.envVar.includes('sk-')), missing)

  console.log('\n[内置厂商：智谱一家三个端点]')
  seedBuiltinProviders()
  const zhipuEndpoints = listEndpoints(true).filter((e) => e.id.startsWith('zhipu'))
  const protocols = new Set(zhipuEndpoints.map((e) => e.protocol))
  check(
    '**智谱有多个端点，且不止一种协议**',
    zhipuEndpoints.length >= 2 && protocols.size >= 2,
    [...protocols],
  )

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${assertions - failures}/${assertions} 条断言通过。`)
  console.log('\n这一组用真 SQLite —— 验的就是外键与唯一约束，mock 掉等于没验。\n')
  if (failures > 0) process.exitCode = 1
}

main()
