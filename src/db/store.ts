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
  defaultModelId,
  findEndpoint as lookupEndpoint,
  findModel as lookupModel,
  firstModel,
} from './registry-store.js'
import { recordUsage, usageTotals, budgetLimit } from './usage.js'
import { setEngineSessionId } from './sessions.js'
import { findProviderId } from './registry-store.js'
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
    // 厂商归属在这里解析（协议层只给 endpointId —— 那是配置层的事，
    // EndpointConfig 刻意不带 providerId，见 protocol/driver.ts 的注释）。
    recordUsage({
      runId: input.runId,
      sessionId: input.sessionId,
      provider: findProviderId(input.endpointId),
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

  resolveEndpoint(endpointId) {
    return lookupEndpoint(endpointId)
  },

  resolveModel(modelId, endpointId) {
    // ⚠️ 没指定模型时用 `defaultModelId()`，**不是** `firstModel()`。
    //
    // 这不是风格问题，是联调时真踩到的：契约的「发消息」请求体里**没有 modelId**
    // （v1 就是这样），所以每轮必然落到「没指定」这条分支。而 `firstModel()`
    // 是按 `(endpointId, label)` 排序取第一个 —— 那个顺序里排第一的是
    // `deepseek-chat`。而用户以为默认是 `glm-5.3`，因为启动日志打印的就是它。
    //
    // 更糟的是它**看起来是生效的**：`/api/models` 报的 default 来自
    // `defaultModelId()`，启动日志也打印同一个值 ——
    // 只有真正跑起来的时候用一个别的模型。**两份真相，且不一致的那份只在运行时露出来。**
    //
    // ⚠️ 这里曾有一段论证说「每轮读 `AGENT_MODEL` 会掩盖配置错误」不成立。
    // 那条 env 线路已经删了（2026-10-09），论证随之失效 ——
    // 现在两条分支读的是同一个来源，不存在「掩盖」的可能。
    if (modelId) return lookupModel(modelId, endpointId)
    if (endpointId) return firstModel(endpointId)
    return lookupModel(defaultModelId()) ?? firstModel()
  },
}