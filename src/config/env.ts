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

/** 契约版本，与 docs/01-contract.md §八 对应。纯信息用途。 */
export const CONTRACT_VERSION = 1

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
 * ⚠️ **这里曾经有一个 `requireModelKey()`，现在删了。**
 *
 * 它硬认 `OPENAI_API_KEY`，而 key 现在**按厂商**存在 `providers.keyEnvVar` 里 ——
 * 留着它会让「配了智谱的 key」也被判成没配，且报错指向一个你没打算用的变量。
 * 启动检查改由 `server.ts` 用 `missingKeys()` 按注册表做。
 *
 * 保留这段注释是因为：下一个想加「检查 key」的人会先找这个函数，
 * 而它**必须**是查注册表的，不能是查某个固定变量名。
 */

/**
 * 推理档位（GLM-5.3 等家叫 `reasoning_effort`）。
 *
 * ⚠️ **只对 GLM 系列有意义**，判定在 `turn.ts` 的 `providerOptionsFor` 里
 * 按模型 id 前缀做，不在这里 —— 因为按 baseURL 判定会把参数发给
 * 不支持它的模型，而那是 400。
 */
export function reasoningEffort(): 'low' | 'high' | 'max' | null {
  const raw = process.env.AGENT_REASONING_EFFORT?.trim().toLowerCase()
  if (!raw) return null
  if (raw === 'low' || raw === 'high' || raw === 'max') return raw
  throw new Error(`AGENT_REASONING_EFFORT只能是 low / high / max，收到「${raw}」。`)
}

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