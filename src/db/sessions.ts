import { all, get, run } from '../db/database.js'
import { id, now } from '../lib/ids.js'

/**
 * 会话与消息的存储。
 *
 * **v1 的边界**：会话与 run 落库，进行中的 run **不跨进程重启恢复**。
 * 启动时把 `running` 的 run 标记成 `interrupted` —— 契约 §六 的理由：
 * 半轮对话恢复不了，硬接会产出更糟的东西。
 *
 * `interrupted` **不是** `run.failed`：它没有 code，是一段历史，不是一个错误。
 */

export type SessionRow = {
  id: string
  title: string
  instructions: string | null
  tools: string
  createdAt: number
  updatedAt: number
}

export type RunRow = {
  id: string
  sessionId: string
  status: 'running' | 'done' | 'stopped' | 'denied' | 'failed' | 'interrupted'
  startedAt: number
  endedAt: number | null
  steps: number | null
  usage: string | null
  code: string | null
  error: string | null
}

export type MessageRow = {
  id: number
  sessionId: string
  runId: string | null
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export function createSession(input: {
  title: string
  instructions?: string
  tools: string[]
}): SessionRow {
  const timestamp = now()
  const sessionId = id('ses')
  run(
    'INSERT INTO sessions (id, title, instructions, tools, createdAt, updatedAt) VALUES (:id, :title, :instructions, :tools, :createdAt, :updatedAt)',
    {
      id: sessionId,
      title: input.title,
      instructions: input.instructions ?? null,
      tools: JSON.stringify(input.tools),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  )
  return findSession(sessionId)!
}

export function findSession(sessionId: string): SessionRow | undefined {
  return get<SessionRow>('SELECT * FROM sessions WHERE id = :id', { id: sessionId })
}

export function listSessions(): (SessionRow & { runCount: number; messageCount: number })[] {
  return all<SessionRow & { runCount: number; messageCount: number }>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM runs r WHERE r.sessionId = s.id) AS runCount,
            (SELECT COUNT(*) FROM messages m WHERE m.sessionId = s.id) AS messageCount
       FROM sessions s
      ORDER BY s.updatedAt DESC`,
  )
}

/** 删除返回计数：**raven 的删除纪律要求回执**，别让一次误点变成没有回执的抹除。 */
export function deleteSession(sessionId: string): { messages: number; runs: number } | undefined {
  const session = findSession(sessionId)
  if (!session) return undefined
  const messages = get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE sessionId = :id', {
    id: sessionId,
  })
  const runs = get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE sessionId = :id', {
    id: sessionId,
  })
  run('DELETE FROM messages WHERE sessionId = :id', { id: sessionId })
  run('DELETE FROM runs WHERE sessionId = :id', { id: sessionId })
  run('DELETE FROM sessions WHERE id = :id', { id: sessionId })
  return { messages: messages?.n ?? 0, runs: runs?.n ?? 0 }
}

export function touchSession(sessionId: string): void {
  run('UPDATE sessions SET updatedAt = :now WHERE id = :id', { now: now(), id: sessionId })
}

export function appendMessage(input: {
  sessionId: string
  runId: string | null
  role: 'user' | 'assistant'
  content: string
}): void {
  run(
    'INSERT INTO messages (sessionId, runId, role, content, createdAt) VALUES (:sessionId, :runId, :role, :content, :createdAt)',
    { ...input, createdAt: now() },
  )
}

export function listMessages(sessionId: string): MessageRow[] {
  return all<MessageRow>('SELECT * FROM messages WHERE sessionId = :id ORDER BY id', {
    id: sessionId,
  })
}

/** 恢复上下文用。`limit` 是为了不让长会话把 token 撑爆。 */
export function recentMessages(sessionId: string, limit = 40): MessageRow[] {
  return all<MessageRow>(
    'SELECT * FROM messages WHERE sessionId = :id ORDER BY id DESC LIMIT :limit',
    { id: sessionId, limit },
  ).reverse()
}

export function startRun(sessionId: string): RunRow {
  const runId = id('run')
  run('INSERT INTO runs (id, sessionId, status, startedAt) VALUES (:id, :sessionId, :status, :startedAt)', {
    id: runId,
    sessionId,
    status: 'running',
    startedAt: now(),
  })
  return findRun(runId)!
}

export function findRun(runId: string): RunRow | undefined {
  return get<RunRow>('SELECT * FROM runs WHERE id = :id', { id: runId })
}

export function finishRun(runId: string, result: {
  status: 'done' | 'stopped' | 'denied' | 'failed'
  steps?: number
  usage?: unknown
  code?: string
  error?: string
}): void {
  run(
    `UPDATE runs SET status = :status, endedAt = :endedAt, steps = :steps,
                     usage = :usage, code = :code, error = :error
      WHERE id = :id`,
    {
      id: runId,
      status: result.status,
      endedAt: now(),
      steps: result.steps ?? null,
      usage: result.usage === undefined ? null : JSON.stringify(result.usage),
      code: result.code ?? null,
      error: result.error ?? null,
    },
  )
}

/** 会话是否还有在跑的轮次。契约 §三：这是 409 的判定依据。 */
export function hasRunningRun(sessionId: string): boolean {
  const found = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM runs WHERE sessionId = :id AND status = 'running'",
    { id: sessionId },
  )
  return (found?.n ?? 0) > 0
}

/**
 * 启动时调用：把上一进程留下的 `running` 标记成 `interrupted`。
 *
 * 契约 §六：**进行中的 run 不跨重启恢复**。半轮对话的 tool 结果已经丢了一半，
 * 硬接会产出比「明确中断」糟得多的东西。
 */
export function reconcileInterruptedRuns(): number {
  const stale = all<RunRow>("SELECT * FROM runs WHERE status = 'running'")
  if (stale.length === 0) return 0
  run(
    "UPDATE runs SET status = 'interrupted', endedAt = :endedAt WHERE status = 'running'",
    { endedAt: now() },
  )
  return stale.length
}

export function countSessions(): number {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n ?? 0
}

export function countRuns(status?: RunRow['status']): number {
  if (!status) return get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n ?? 0
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE status = :status', { status })?.n ?? 0
}

// ---------------------------------------------------------------------------
// 工具调用
// ---------------------------------------------------------------------------

export type ToolCallRow = {
  id: number
  sessionId: string
  runId: string
  seq: number
  callId: string
  tool: string
  input: string
  output: string | null
  ok: number | null
  durationMs: number | null
  status: 'pending' | 'ok' | 'failed' | 'denied'
  createdAt: number
}

/**
 * 记一次工具调用。
 *
 * ⚠️ **幂等，但按 `(sessionId, callId)` 而不是只按 `callId`。**
 *
 * 只按 `callId` 做 UNIQUE 会出事：`callId` 是 SDK 生成的**短随机串**，
 * 两个不同的会话可能撞上同一个 id（用固定 id 的测试脚本必然撞）。
 * 撞上之后的 `ON CONFLICT` 走 UPDATE 分支，而 UPDATE 不改 sessionId/runId ——
 * 于是新会话的这次调用被记到了**旧会话**名下，症状是
 * 「新的会话里工具历史凭空消失」，而且没有任何报错。
 * 这个 bug 真的发生过一次：验证脚本用固定的 `call_slow`/`call_fast`，
 * 第二次跑时新会话查不到任何工具调用，而查库能看到行存在、只是属于别的会话。
 *
 * 所以：UNIQUE 约束在 (sessionId, callId) 上，冲突时也更新 sessionId/runId ——
 * 让「重试同一次调用」与「不同会话用了同一个 id」都落在正确的一行。
 */
export function recordToolCall(input: {
  sessionId: string
  runId: string
  seq: number
  callId: string
  tool: string
  /**
   * 更新路径上可省 —— `ON CONFLICT` 的 SET 列表里没有 `input`，
   * 给了也会被忽略。省掉它能让「这行是更新」在类型上就看得出来。
   */
  input?: unknown
  output?: unknown
  ok?: boolean
  durationMs?: number
  status: ToolCallRow['status']
}): void {
  run(
    `INSERT INTO toolCalls (sessionId, runId, seq, callId, tool, input, output, ok, durationMs, status, createdAt)
     VALUES (:sessionId, :runId, :seq, :callId, :tool, :input, :output, :ok, :durationMs, :status, :createdAt)
     ON CONFLICT(sessionId, callId) DO UPDATE SET
       runId      = excluded.runId,
       tool       = excluded.tool,
       output     = COALESCE(excluded.output, toolCalls.output),
       ok         = COALESCE(excluded.ok, toolCalls.ok),
       durationMs = COALESCE(excluded.durationMs, toolCalls.durationMs),
       status     = excluded.status`,
    {
      sessionId: input.sessionId,
      runId: input.runId,
      seq: input.seq,
      callId: input.callId,
      tool: input.tool,
      // ⚠️ 冲突时这列不参与更新，所以更新路径上给什么都会被忽略。
      input: JSON.stringify(input.input ?? null),
      output: input.output === undefined ? null : JSON.stringify(input.output),
      ok: input.ok === undefined ? null : input.ok ? 1 : 0,
      durationMs: input.durationMs ?? null,
      status: input.status,
      createdAt: now(),
    },
  )
}

/**
 * 取一轮 run 里的工具调用，按 seq 升序。
 *
 * ⚠️ **只返回有结果的**（`status !== 'pending'`）。悬空的 tool-call 不能重建 ——
 * 一条没有对应 result 的 tool-call 会让模型的上下文非法（多数 provider 直接 400）。
 * 那种情况（进程在工具执行中途被杀）正是「重启把 run 标成 interrupted」覆盖的场景。
 */
export function toolCallsForRun(runId: string): ToolCallRow[] {
  return all<ToolCallRow>(
    "SELECT * FROM toolCalls WHERE runId = :runId AND status != 'pending' ORDER BY seq, id",
    { runId },
  )
}

/**
 * 取一个会话最近若干轮的工具调用，用于重建跨轮上下文。
 *
 * ⚠️ **`limit` 按 run 算，不按行数** —— 一次并行会产出多行，
 * 按行截断会把一轮切一半，那比不截更糟（上下文里出现半个 tool-call）。
 */
export function recentToolCalls(sessionId: string, runLimit = 6): ToolCallRow[] {
  const runs = all<{ id: string }>(
    `SELECT id FROM runs
      WHERE sessionId = :sessionId AND status IN ('done','stopped','denied')
      ORDER BY startedAt DESC LIMIT :limit`,
    { sessionId, limit: runLimit },
  )
  const ids = runs.map((row) => row.id)
  if (ids.length === 0) return []
  const placeholders = ids.map((_, index) => `:r${index}`).join(',')
  const params: Record<string, unknown> = { sessionId }
  ids.forEach((id, index) => {
    params[`r${index}`] = id
  })
  return all<ToolCallRow>(
    `SELECT * FROM toolCalls
      WHERE sessionId = :sessionId AND status != 'pending' AND runId IN (${placeholders})
      ORDER BY id`,
    params,
  )
}