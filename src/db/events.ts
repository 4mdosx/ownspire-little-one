import { all, get, run } from './database.js'

/**
 * 事件日志。契约 §六「断线重连」：事件流不再是一次性通道，
 * 每个事件落一行，重连按 after=seq 回放。这也是审计的落点 ——
 * 自动通过的审批事件对（§五）在这里留下完整痕迹。
 */

export type EventRow = {
  id: number
  runId: string
  sessionId: string
  seq: number
  name: string
  data: string
  createdAt: number
}

export function saveEvent(input: {
  runId: string
  sessionId: string
  seq: number
  name: string
  data: unknown
}): void {
  run(
    'INSERT INTO events (runId, sessionId, seq, name, data, createdAt) VALUES (:runId, :sessionId, :seq, :name, :data, :createdAt)',
    {
      runId: input.runId,
      sessionId: input.sessionId,
      seq: input.seq,
      name: input.name,
      data: JSON.stringify(input.data ?? null),
      createdAt: Date.now(),
    },
  )
}

export function listEvents(runId: string, afterSeq: number): EventRow[] {
  return all<EventRow>(
    'SELECT * FROM events WHERE runId = :runId AND seq > :after ORDER BY seq',
    { runId, after: afterSeq },
  )
}

export function maxSeq(runId: string): number {
  const row = get<{ n: number }>(
    'SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE runId = :runId',
    { runId },
  )
  return row?.n ?? 0
}
