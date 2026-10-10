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
 * ⚠️ **模型配置一律不走环境变量**（2026-10-09 裁定）。
 *
 * 这个文件曾经有过三个 env 入口，现在全删了：
 *
 * | 删掉的 | 现在的唯一来源 |
 * |---|---|
 * | `OPENAI_API_KEY` 等 key 变量 + `keyEnvVar` 列 | `providers.apiKey`（界面填） |
 * | `AGENT_MODEL`（默认模型 id） | `models` 表第一项 |
 * | `AGENT_REASONING_EFFORT`（推理档位） | `models.reasoningEffort` 列 |
 *
 * 留着它们的成本不是「多几条代码路径」，而是**用户改错地方却看到「已保存」** ——
 * 界面上填的 key 被容器注入的 env 盖掉，而提示语说的是「配置完成」。
 * 一份真相可以有很多呈现方式，两份真相只会让人猜哪份生效。
 *
 * ⚠️ **保留这份注释的理由**：下一个想在这里加「读模型配置」的人会先找这个文件。
 * 模型配置在 `src/db/registry-store.ts` 与 `src/db/schema.ts` 里，
 * 不在这里 —— 而这个文件剩下的东西（库文件路径、鉴权 token、端口）
 * 全是**部署参数**，不是模型参数。
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