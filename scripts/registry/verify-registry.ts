/**
 * 目录已经不在 little-one 里。这组只确认空库建出来之后：
 * 厂商 / 端点 / 模型三张表不存在，会话上没有 endpointId / modelId。
 */

import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'agent-registry-'))
process.env.AGENT_DB_FILE = join(dir, 'agent.db')

const { ensureSchema, sqlite, closeDatabase } = await import('../../src/db/database.js')

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

function tableExists(name: string): boolean {
  const row = sqlite()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined
  return row?.name === name
}

function columnsOf(table: string): string[] {
  return (sqlite().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

function main(): void {
  console.log('\n════ 库里没有模型目录 ════\n')
  ensureSchema()

  check('providers 表不存在', !tableExists('providers'))
  check('endpoints 表不存在', !tableExists('endpoints'))
  check('models 表不存在', !tableExists('models'))
  const columns = columnsOf('sessions')
  check('sessions 没有 endpointId', !columns.includes('endpointId'), columns)
  check('sessions 没有 modelId', !columns.includes('modelId'), columns)
  check('usageLedger 还在（用量记账不是模型选择）', tableExists('usageLedger'))

  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${assertions - failures}/${assertions} 条断言通过。\n`)
  if (failures > 0) process.exitCode = 1
}

main()
