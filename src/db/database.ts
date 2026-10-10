import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDbFile } from '../config/env.js'
import {
  DROPPABLE_COLUMNS,
  LEGACY_INDEXES,
  LEGACY_TABLES,
  MIGRATABLE_COLUMNS,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './schema.js'

/**
 * 连接与初始化。规矩来自 atlas / raven，都是踩过的：
 *
 * - **惰性打开、可重开**：不在 import 时建连接，否则验证脚本没法「先设
 *   AGENT_DB_FILE 再首次打开」。所以是getter，不是模块级常量。
 * - `busy_timeout = 5000`：默认 0ms 意味着撞到锁立刻报错，dev server 与验证脚本
 *   同时开着就会随机失败。
 * - `journal_mode = WAL` + `synchronous = NORMAL`：读不挡写。
 * - ⚠️ **别用「删 `-journal` 文件」修 `disk I/O error`**：那个文件的存在意味着上一个
 *   进程被中断、SQLite 要回滚未完成的事务。删掉它就绕过了回滚，
 *   剩下的半截数据会变成 `disk I/O error`。正确做法是让下一个进程自己回滚。
 */

const dbPath = resolveDbFile()

let connection: DatabaseSync | null = null
let schemaReady = false

export function dbFile(): string {
  return dbPath
}

export function sqlite(): DatabaseSync {
  if (connection) return connection
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const opened = new DatabaseSync(dbPath)
  for (const pragma of [
    'PRAGMA busy_timeout = 5000',
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
  ]) {
    opened.exec(pragma)
  }
  connection = opened
  return connection
}

export function closeDatabase(): void {
  if (!connection) return
  try {
    connection.close()
  } catch {
    // 已经关了就算了。
  }
  connection = null
  schemaReady = false
}

/** 幂等。只创建当前结构；撞到已知旧表直接抛错，不自动搬数据。 */
export function ensureSchema(): void {
  if (schemaReady) return
  const database = sqlite()
  for (const [table, reason] of Object.entries(LEGACY_TABLES)) {
    const found = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name?: string } | undefined
    if (found?.name) {
      throw new Error(`检测到旧版表 ${table}：${reason} 请先执行显式迁移，数据库未被修改。`)
    }
  }
  database.exec(SCHEMA_SQL)
  // ⚠️ **删掉的列要单独查，方向与加列相反。**
  //
  // `CREATE TABLE IF NOT EXISTS` 不动已存在的表，所以新 schema 删了一列之后，
  // 旧库那张表**仍然带着那一列** —— 而所有引用它的代码都已经删了。
  // 不处理的话症状是「旧库能跑、新库也能跑，但两者的行为没人验证过」，
  // 而这类不一致会在下一次改结构时才暴露，指向错误的行。
  //
  // 自动修的依据是实测：在真有数据的库上验过，`DROP COLUMN` 不重建表、不丢数据
  // （见 schema.ts 里 DROPPABLE_COLUMNS 的注释）。
  // **但失败时不重试、不绕过** —— 失败说明有本文件不知道的依赖（索引/外键），
  // 而绕过它正是静默损坏的起点。
  for (const item of DROPPABLE_COLUMNS) {
    const columns = database.prepare(`PRAGMA table_info(${item.table})`).all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === item.column)) continue
    try {
      database.exec(`ALTER TABLE ${item.table} DROP COLUMN ${item.column}`)
    } catch (error) {
      throw new Error(
        `迁移失败：${item.table}.${item.column} 删不掉 —— ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          `数据库未被修改。${item.reason}\n` +
          '若该列被索引或外键引用，先去掉那些引用，或删掉数据库重建。'
      )
    }
    console.log(`[agent] 已迁移：${item.table} 删掉 ${item.column} —— ${item.reason}`)
  }
  // ⚠️ **`CREATE TABLE IF NOT EXISTS` 对已存在的表不做任何事。**
  // 所以 schema.sql 里加了列，库里那张表不会跟着变 —— 而服务照样起来，
  // 于是读那一列的代码全拿到 undefined。这类沉默的不一致最难查。
  //
  // 缺列是**唯一可以自动修**的一类：`ALTER TABLE ADD COLUMN` 是纯加法，
  // 不动已有行、不动索引、不可能失败。撞上旧表结构/旧约束仍然拒绝启动
  // （见上面那段），因为那些要对数据动手术。
  for (const item of MIGRATABLE_COLUMNS) {
    const columns = database.prepare(`PRAGMA table_info(${item.table})`).all() as Array<{ name: string }>
    if (columns.some((column) => column.name === item.column)) continue
    database.exec(item.ddl)
    console.log(`[agent] 已迁移：${item.table} 补上 ${item.column} —— ${item.reason}`)
  }
  // ⚠️ 索引也要查，不只是表：改了 schema 里的约束不等于库里的约束变了，
  // 而后者只在索引层面看得出来。
  for (const [index, reason] of Object.entries(LEGACY_INDEXES)) {
    const found = database
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .get(index) as { name?: string } | undefined
    if (found?.name) {
      throw new Error(`检测到过时索引 ${index}：${reason} 数据库未被修改。`)
    }
  }
  // 持久化演进政策（契约 §一）：把「这行数据是哪个结构写出来的」记进库本身。
  // INSERT OR IGNORE —— 已有值说明库里是旧结构写的数据，保留旧值；
  // 升 SCHEMA_VERSION 时由对应的迁移步骤负责改写它，这里不覆盖。
  database
    .prepare('INSERT OR IGNORE INTO _meta (key, value) VALUES (:key, :value)')
    .run({ key: 'schemaVersion', value: String(SCHEMA_VERSION) })
  schemaReady = true
}

/** /healthz 用：能不能真的查到东西。 */
export function pingDatabase(): void {
  ensureSchema()
  sqlite().prepare('SELECT 1 AS ok').get()
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

export function run(sql: string, params: Record<string, unknown> = {}): void {
  ensureSchema()
  const statement = sqlite().prepare(sql)
  if (Object.keys(params).length === 0) statement.run()
  else statement.run(params as never)
}

export function all<T>(sql: string, params: Record<string, unknown> = {}): T[] {
  ensureSchema()
  const statement = sqlite().prepare(sql)
  return (Object.keys(params).length === 0 ? statement.all() : statement.all(params as never)) as T[]
}

export function get<T>(sql: string, params: Record<string, unknown> = {}): T | undefined {
  ensureSchema()
  const statement = sqlite().prepare(sql)
  return (Object.keys(params).length === 0 ? statement.get() : statement.get(params as never)) as
    | T
    | undefined
}