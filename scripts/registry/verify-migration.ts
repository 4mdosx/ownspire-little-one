/**
 * 旧库迁移的验证：**造一个带`keyEnvVar` 列的旧库，然后启动。**
 *
 * ## 为什么单独一个脚本，而不是塞进 verify-registry
 *
 * 因为要验的东西需要**一个已经存在的旧结构**，而 verify-registry 是
 * `ensureSchema()` 在空库上跑出来的 —— 那种库里永远没有 `keyEnvVar`，
 * 于是 `DROPPABLE_COLUMNS` 那段代码一次都不会执行。
 *
 * 「自动迁移」这种功能最典型的失败方式恰恰是**从没被执行过**：
 * 代码看起来对、类型过得去、单测全绿，而线上第一次跑旧库时才炸。
 * 要把它验住，只能真的先造一个旧库。
 *
 * ⚠️ 用真 SQLite，不用 mock —— 这组验的恰恰是 `ALTER TABLE` 的行为。
 */

import { rmSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  if (detail !== undefined) console.log(`      ${String(detail).slice(0, 300)}`)
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

async function main(): Promise<void> {
  console.log('\n════旧库迁移 · 删掉 keyEnvVar ════\n')

  const dir = mkdtempSync(join(tmpdir(), 'agent-migrate-'))
  const file = join(dir, 'agent.db')

  // ---- 造一个「2026-10-09 之前」的库 ------------------------------------
  //
  // ⚠️ 手写 DDL 而不是「跑一遍新schema 再改回去」：后者造出来的是
  // 新代码生成的形状，那种库本来就该被自动迁移，验不到任何东西。
  // 这里要的是**旧代码真的建出来的那个形状**。
  const legacy = new DatabaseSync(file)
  legacy.exec(`
    CREATE TABLE providers (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      keyEnvVar       TEXT NOT NULL,
      defaultProtocol TEXT NOT NULL,
      createdAt       INTEGER NOT NULL,
      updatedAt       INTEGER NOT NULL
    );
    CREATE TABLE endpoints (
      id         TEXT PRIMARY KEY,
      providerId TEXT NOT NULL REFERENCES providers(id),
      label      TEXT NOT NULL,
      protocol   TEXT,
      baseUrl    TEXT,
      extraBody  TEXT,
      enabled    INTEGER NOT NULL DEFAULT 1,
      createdAt  INTEGER NOT NULL,
      updatedAt  INTEGER NOT NULL
    );
    CREATE TABLE models (
      id              TEXT NOT NULL,
      endpointId      TEXT NOT NULL REFERENCES endpoints(id),
      label           TEXT NOT NULL,
      reasoningEffort TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      createdAt       INTEGER NOT NULL,
      updatedAt       INTEGER NOT NULL,
      PRIMARY KEY (endpointId, id)
    );
    CREATE TABLE sessions (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      instructions TEXT,
      tools        TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );
  `)
  // ⚠️ **库里要有真实数据。** 空库上「迁移没丢数据」是句空话 ——
  // 而「迁移把会话删了」正是这类操作最典型的失败方式。
  legacy
    .prepare('INSERT INTO providers VALUES (?,?,?,?,?,?)')
    .run('zhipu', '智谱 GLM', 'ZHIPU_API_KEY', 'openai-chat-completions', 1, 1)
  legacy
    .prepare('INSERT INTO endpoints VALUES (?,?,?,?,?,?,?,?,?)')
    .run('zhipu-chat', 'zhipu', '智谱 Chat', null, 'https://open.bigmodel.cn/api/paas/v4', null, 1, 1, 1)
  legacy
    .prepare('INSERT INTO models VALUES (?,?,?,?,?,?,?)')
    .run('glm-5.3', 'zhipu-chat', 'GLM-5.3', 'high', 1, 1, 1)
  legacy
    .prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)')
    .run('s_keep_me', '迁移前就存在的会话', null, '[]', 1, 1)
  legacy.close()

  check('旧库造好了（带 keyEnvVar 列）', existsSync(file))
  {
    const probe = new DatabaseSync(file, { readOnly: true })
    check('造出来的确实是旧结构', columnsOf(probe, 'providers').includes('keyEnvVar'), columnsOf(probe, 'providers'))
    probe.close()
  }

  // ---- 启动：ensureSchema 应该自动迁移 ---------------------------------
  process.env.AGENT_DB_FILE = file
  const { ensureSchema, sqlite, closeDatabase } = await import('../../src/db/database.js')
  const { listProviderViews, listEndpoints, listModels } = await import('../../src/db/registry-store.js')
  const { findSession } = await import('../../src/db/sessions.js')

  console.log('\n[自动迁移]')
  ensureSchema()

  check(
    '**keyEnvVar 列被删掉了**',
    !columnsOf(sqlite(), 'providers').includes('keyEnvVar'),
    columnsOf(sqlite(), 'providers')
  )
  check('其余列都在', ['id', 'label', 'apiKey', 'defaultProtocol', 'createdAt', 'updatedAt'].every((c) => columnsOf(sqlite(), 'providers').includes(c)), columnsOf(sqlite(), 'providers'))

  console.log('\n[⚠️ 迁移不能丢数据]')
  check('端点还在', listEndpoints(true).some((e) => e.id === 'zhipu-chat'), listEndpoints(true).map((e) => e.id))
  check('模型还在（且档位没丢）', listModels().some((m) => m.id === 'glm-5.3' && m.reasoningEffort === 'high'), listModels())
  check('厂商还在', listProviderViews().some((p) => p.id === 'zhipu'), listProviderViews())
  check('**迁移前的会话还在**', findSession('s_keep_me') !== undefined)
  check('厂商视图不再有 keyEnvVar', !('keyEnvVar' in (listProviderViews()[0] ?? {})), Object.keys(listProviderViews()[0] ?? {}))
  check(
    '旧库没填过 apiKey → 标成 none（**不因为删了列就假装有 key**）',
    listProviderViews().find((p) => p.id === 'zhipu')?.apiKeySource === 'none',
    listProviderViews().find((p) => p.id === 'zhipu')
  )

  console.log('\n[迁移后再 seed 不炸]')
  // seed 会往 providers 里 INSERT —— 如果列清单与代码里的 SQL 不一致，
  // 这一句就是第一个报「no such column」的地方。
  try {
    const { seedBuiltinProviders } = await import('../../src/db/registry-store.js')
    seedBuiltinProviders()
    check('内置厂商能写进迁移后的库', true)
  } catch (error) {
    check('内置厂商能写进迁移后的库', false, error instanceof Error ? error.message : String(error))
  }

  console.log('\n[幂等]')
  try {
    ensureSchema()
    closeDatabase()
    check('**第二次 ensureSchema 不炸**（迁移必须幂等）', true)
  } catch (error) {
    check('**第二次 ensureSchema 不炸**（迁移必须幂等）', false, error instanceof Error ? error.message : String(error))
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${assertions - failures}/${assertions} 条断言通过。\n`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})