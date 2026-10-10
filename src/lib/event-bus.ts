/**
 * 进程内事件总线：primary 流是唯一发布者，重连流是订阅者。
 *
 * 契约 §六「断线重连」：客户端断开后，事件照常落库（events 表）；
 * 重连的 GET stream 先回放库里的事件，再挂到这条总线上续流到终止事件。
 *
 * ⚠️ **seq 的唯一分配点在这里**，且只在 primary 发布时分配 ——
 * 重连流回放的是**库里已存的 seq**，绝不能再发布（否则 seq 撞车、
 * 别的订阅者收到重放副本）。模块级 Map 在这里成立的理由与
 * run-registry 相同：一用户一实例。
 */

export type BusEvent = { name: string; data: unknown; seq: number }

type Channel = {
  seq: number
  sinks: Set<(event: BusEvent) => void>
}

const channels = new Map<string, Channel>()

/**
 * 发布并分配 seq（从 1 开始，run 内单调）。返回分配到的 seq，
 * 调用方（primary 流）负责把它写进 SSE 的 id: 行并落库。
 */
export function publish(runId: string, name: string, data: unknown): number {
  let channel = channels.get(runId)
  if (!channel) {
    channel = { seq: 0, sinks: new Set() }
    channels.set(runId, channel)
  }
  channel.seq += 1
  const event: BusEvent = { name, data, seq: channel.seq }
  for (const sink of channel.sinks) sink(event)
  return event.seq
}

/** 重连流挂载。返回解绑函数（流关闭时调用，不许抛）。 */
export function subscribe(runId: string, sink: (event: BusEvent) => void): () => void {
  let channel = channels.get(runId)
  if (!channel) {
    channel = { seq: 0, sinks: new Set() }
    channels.set(runId, channel)
  }
  channel.sinks.add(sink)
  return () => {
    channel.sinks.delete(sink)
  }
}

/** primary 流收尾时调用：seq 计数与订阅者一起销毁，Map 不无限生长。 */
export function closeChannel(runId: string): void {
  channels.delete(runId)
}
