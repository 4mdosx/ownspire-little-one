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
  check(
    '**库里没有 key 列**（凭据只在环境里）',
    !Object.keys(listProviders()[0] ?? {}).includes('apiKey'),
    Object.keys(listProviders()[0] ?? {}),
  )

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
