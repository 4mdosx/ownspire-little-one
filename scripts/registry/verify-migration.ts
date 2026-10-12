/**
 * 旧库迁移：带厂商 key、端点、模型和会话上的 endpointId/modelId，
 * 启动后目录表消失，会话还在，schemaVersion 写成 2。
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

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined
  return row?.name === name
}

async function main(): Promise<void> {
  console.log('\n════ 旧库迁移 · 删掉模型目录 ════\n')

  const dir = mkdtempSync(join(tmpdir(), 'agent-migrate-'))
  const file = join(dir, 'agent.db')

  const legacy = new DatabaseSync(file)
  legacy.exec(`
    CREATE TABLE providers (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      keyEnvVar       TEXT NOT NULL,
      apiKey          TEXT,
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
      endpointId   TEXT,
      modelId      TEXT,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );
  `)
  legacy
    .prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)')
    .run('zhipu', '智谱 GLM', 'ZHIPU_API_KEY', 'sk-old', 'openai-chat-completions', 1, 1)
  legacy
    .prepare('INSERT INTO endpoints VALUES (?,?,?,?,?,?,?,?,?)')
    .run('zhipu-chat', 'zhipu', '智谱 Chat', null, 'https://open.bigmodel.cn/api/paas/v4', null, 1, 1, 1)
  legacy
    .prepare('INSERT INTO models VALUES (?,?,?,?,?,?,?)')
    .run('glm-5.3', 'zhipu-chat', 'GLM-5.3', 'high', 1, 1, 1)
  legacy
    .prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)')
    .run('s_keep_me', '迁移前就存在的会话', null, '[]', 'zhipu-chat', 'glm-5.3', 1, 1)
  legacy.close()

  check('旧库造好了', existsSync(file))
  {
    const probe = new DatabaseSync(file, { readOnly: true })
    check('造出来的确实带 keyEnvVar', columnsOf(probe, 'providers').includes('keyEnvVar'), columnsOf(probe, 'providers'))
    check('会话上有 endpointId', columnsOf(probe, 'sessions').includes('endpointId'))
    probe.close()
  }

  process.env.AGENT_DB_FILE = file
  const { ensureSchema, sqlite, closeDatabase } = await import('../../src/db/database.js')
  const { findSession } = await import('../../src/db/sessions.js')

  console.log('\n[自动迁移]')
  ensureSchema()

  const db = sqlite()
  check('providers 表没了', !tableExists(db, 'providers'))
  check('endpoints 表没了', !tableExists(db, 'endpoints'))
  check('models 表没了', !tableExists(db, 'models'))
  const sessionColumns = columnsOf(db, 'sessions')
  check('sessions.endpointId 被删掉了', !sessionColumns.includes('endpointId'), sessionColumns)
  check('sessions.modelId 被删掉了', !sessionColumns.includes('modelId'), sessionColumns)
  check('迁移前的会话还在', findSession('s_keep_me')?.title === '迁移前就存在的会话')
  const version = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as { value?: string } | undefined
  check('schemaVersion 写成 2', version?.value === '2', version)

  console.log('\n[幂等]')
  try {
    closeDatabase()
    ensureSchema()
    closeDatabase()
    check('第二次 ensureSchema 不炸', true)
  } catch (error) {
    check('第二次 ensureSchema 不炸', false, error instanceof Error ? error.message : String(error))
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${assertions - failures}/${assertions} 条断言通过。\n`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
