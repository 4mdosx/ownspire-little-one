/**
 * 在途 run 的取消注册表。
 *
 * 取消接口（POST /api/sessions/:sessionId/runs/:runId/cancel）唯一的职责是
 * 把 abort 信号递到**正在跑的那一轮**手里。DB 里的 `status = 'running'` 只说明
 * 「有一轮没写完」，不持有任何可中断的东西 —— 能中断的只有内存里的
 * AbortController。
 *
 * ⚠️ **取消必须停止底层的工作**（这是取消存在的前提）：signal 会一路穿透到
 * Driver 的 SDK `abortSignal`，在飞的模型请求与工具调用都被中断。
 * 只改状态不递信号，那是假取消 —— run 照样烧完剩下的步数。
 *
 * ⚠️ 模块级 Map 在这里是对的，不是偷懒：本项目**一用户一实例**（契约 §二），
 * 不存在第二个进程来共享或争抢这张表。真要水平扩容，取消本来就得重新设计
 * （信号走不到另一个进程），那张表救不了任何人。
 *
 * ⚠️ 注册与释放必须成对：messages 路由在开流前注册，流收尾（含异常路径）
 * 释放。漏释放的症状是「这一轮永远取消不掉」—— 挂着没人听的 controller。
 */

const inflight = new Map<string, AbortController>()

/** 开流前注册。**同一 runId 重复注册按编程错误处理** —— 409 已经保证一轮在跑。 */
export function registerInflightRun(runId: string, controller: AbortController): void {
  if (inflight.has(runId)) {
    throw new Error(`run ${runId} 已注册 —— 409 守卫漏了，这不是取消该处理的情形。`)
  }
  inflight.set(runId, controller)
}

/** 这个 runId 是否还在本进程内跑。 */
export function isInflightRun(runId: string): boolean {
  return inflight.has(runId)
}

/** 递出取消信号。返回是否真的有这一轮在跑 —— 没有的话调用方负责转成 409。 */
export function cancelInflightRun(runId: string): boolean {
  const controller = inflight.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}

/** 流收尾时释放。重复释放与释放不存在的 id 都静默 —— 收尾路径不许抛。 */
export function releaseInflightRun(runId: string): void {
  inflight.delete(runId)
}
