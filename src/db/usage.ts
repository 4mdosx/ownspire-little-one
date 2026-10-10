import { all, get, run } from './database.js'

/**
 * token 账本与预算（2026-10-09，契约 §六）。
 *
 * **全程不出现钱。** 定价随厂商与时间变，token 数是厂商无关的记账单位 ——
 * 「按厂商/模型分开统计」天然可做，换算成钱这件事永远留在库外面。
 *
 * 预算上限存 `_meta`（instance 级，一个数）。检查点：run 启动前
 * （累计已超 → 409 budget_exhausted）。运行中逐 token 掐断做不到
 * （SDK 的 usage 在 run 结束时才给全量），这段超支风险由工具调用次数上限
 * 兜底，契约里写明了。
 */

export function recordUsage(input: {
  runId: string
  sessionId: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}): void {
  run(
    `INSERT INTO usageLedger (runId, sessionId, provider, model, inputTokens, outputTokens, createdAt)
     VALUES (:runId, :sessionId, :provider, :model, :inputTokens, :outputTokens, :createdAt)`,
    {
      runId: input.runId,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      createdAt: Date.now(),
    },
  )
}

export type UsageTotals = { inputTokens: number; outputTokens: number }

export function usageTotals(): UsageTotals {
  const row = get<UsageTotals>(
    'SELECT COALESCE(SUM(inputTokens), 0) AS inputTokens, COALESCE(SUM(outputTokens), 0) AS outputTokens FROM usageLedger',
  )
  return row ?? { inputTokens: 0, outputTokens: 0 }
}

export type UsageByModel = UsageTotals & { provider: string; model: string }

export function usageByModel(): UsageByModel[] {
  return all<UsageByModel>(
    `SELECT provider, model,
            COALESCE(SUM(inputTokens), 0) AS inputTokens,
            COALESCE(SUM(outputTokens), 0) AS outputTokens
       FROM usageLedger
      GROUP BY provider, model
      ORDER BY inputTokens + outputTokens DESC`,
  )
}

const BUDGET_KEY = 'budgetTokens'

export function budgetLimit(): number | null {
  const row = get<{ value: string }>('SELECT value FROM _meta WHERE key = :key', { key: BUDGET_KEY })
  if (!row) return null
  const parsed = Number(row.value)
  return Number.isFinite(parsed) ? parsed : null
}

/** null = 取消上限（回到不设防）。 */
export function setBudgetLimit(limit: number | null): void {
  if (limit === null) {
    run('DELETE FROM _meta WHERE key = :key', { key: BUDGET_KEY })
    return
  }
  run(
    'INSERT INTO _meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = :value',
    { key: BUDGET_KEY, value: String(limit) },
  )
}
