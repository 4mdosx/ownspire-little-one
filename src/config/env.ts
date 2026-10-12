import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

/**
 * 环境变量。**dotenv 加载必须在任何读取之前完成。**
 *
 * 与 raven / atlas 同一条纪律：验证脚本要先设 `AGENT_DB_FILE` 再首次打开数据库，
 * 所以这个文件只负责「加载」与「计算路径」，不去碰数据库，也不建连接。
 */

const here = path.dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = path.resolve(here, '..', '..')

loadEnv({ path: path.join(PROJECT_ROOT, '.env') })

/** 契约版本，与 docs/01-contract.md 对应。纯信息用途。 */
export const CONTRACT_VERSION = 2

let dbFileOverride: string | null = null

/**
 * 验证脚本用：先设再首次打开。
 * 所以这里是 setter 而不是读一次就固定的常量——
 * 固定了就等于要求验证脚本必须在 import 之前设好变量，而 ESM 的 import 顺序不由调用方控制。
 */
export function setDbFile(file: string): void {
  dbFileOverride = file
}

export function resolveDbFile(): string {
  if (dbFileOverride) return dbFileOverride
  const fromEnv = process.env.AGENT_DB_FILE?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(PROJECT_ROOT, 'data', 'agent.db')
}

export function requireToken(): string {
  const token = process.env.AGENT_RUNTIME_TOKEN?.trim()
  if (!token) throw new Error('AGENT_RUNTIME_TOKEN 未设置，拒绝启动。')
  if (token.length < 16) throw new Error('AGENT_RUNTIME_TOKEN 至少 16 个字符。')
  return token
}

/**
 * 厂商 key、协议互译、推理档位都在 Magpie 进程里。
 * little-one 这边唯一和模型有关的部署参数是 `MAGPIE_MODEL`（见 `src/upstream.ts`）：
 * Magpie 上的模型名或路由组。会话不存它，界面也不选它。
 */

export function port(): number {
  const raw = process.env.AGENT_PORT?.trim()
  if (!raw) return 5900
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`AGENT_PORT 不是合法端口：${raw}`)
  }
  return parsed
}

/**
 * 7 位 commit，infra 用它判断「跑的是哪一版」。与 navi / atlas / raven 同一套约定。
 */
export function version(): string {
  const raw = process.env.AGENT_VERSION?.trim()
  if (raw && /^[0-9a-f]{7}$/i.test(raw)) return raw.toLowerCase()
  return 'dev0000'
}