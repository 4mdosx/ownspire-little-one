import {
  appendMessage,
  findSession,
  finishRun,
  hasRunningRun,
  recentMessages,
  recentToolCalls,
  recordToolCall,
  startRun,
  touchSession,
} from './sessions.js'
import { recordUsage, usageTotals, budgetLimit } from './usage.js'
import { setEngineSessionId } from './sessions.js'
import type { TurnStore } from '../protocol/turn.js'

/**
 * 把真实的 SQLite 实现适配成协议层要的 `TurnStore`。
 *
 * ## 为什么要有这一层
 *
 * 协议层要能被单元测试，就不能直接依赖数据库 —— 测试时没有库，
 * 也不该为了测「授权有没有被拦」而去建一张真表。
 * 所以 `TurnStore` 定义成**窄接口**，这里提供真实现，测试提供假实现。
 *
 * ⚠️ **这是「窄接口」的价值**：如果 `TurnStore` 是整个 db 类的形状，
 * 假实现就得跟着实现 30 个方法，而测试里那些方法大半用不上。
 */
export const store: TurnStore = {
  findSession(sessionId) {
    return findSession(sessionId)
  },

  recordUsage(input) {
    recordUsage({
      runId: input.runId,
      sessionId: input.sessionId,
      provider: 'magpie',
      model: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    })
  },

  usageTotals,

  budgetLimit,

  setEngineSession: setEngineSessionId,

  hasRunningRun(sessionId) {
    return hasRunningRun(sessionId)
  },

  appendMessage,

  recentMessages(sessionId) {
    return recentMessages(sessionId)
  },

  recentToolCalls(sessionId, runLimit = 6) {
    return recentToolCalls(sessionId, runLimit)
  },

  recordToolCall,

  startRun(sessionId, options) {
    return startRun(sessionId, options)
  },

  finishRun,

  touchSession,
}