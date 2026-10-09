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
import {
  findEndpoint as lookupEndpoint,
  findModel as lookupModel,
  firstModel,
} from './registry-store.js'
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

  startRun(sessionId) {
    return startRun(sessionId)
  },

  finishRun,

  touchSession,

  resolveEndpoint(endpointId) {
    return lookupEndpoint(endpointId)
  },

  resolveModel(modelId, endpointId) {
    // ⚠️ 没指定模型时取第一个可用的 —— 与 `defaultModelId()` 的区别是
    // 它**不读环境变量**（AGENT_MODEL 配错了该在启动时报，不是每轮报）。
    return modelId ? lookupModel(modelId, endpointId) : firstModel(endpointId)
  },
}