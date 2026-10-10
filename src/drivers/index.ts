import type { AgentDriver, DriverRegistry } from '../protocol/driver.js'
import { vercelAiDriver } from '../drivers/vercel-ai/driver.js'
import { createClaudeDriver, isClaudeCliAvailable } from './claude/driver.js'

/**
 * Driver 注册表。
 *
 * ## 为什么 import 具体 adapter 在这里，而不在协议层
 *
 * 协议层（`protocol/driver.ts`）只有 `AgentDriver` 接口，
 * **不知道 Vercel AI 的存在** —— 所以换 SDK 时协议层与它的测试一行都不用改。
 * 但「哪些 adapter 可用」是**运行期的组装问题**，它必须知道具体实现。
 * 所以这层是协议层与 adapter 之间的唯一接缝。
 *
 * ## 新增一家 SDK 要动的地方
 *
 * 1. `src/drivers/<name>/driver.ts` —— 实现接口
 * 2. **这个文件加一行 import + 一条注册**
 *
 * 协议层、契约、raven，全部不动。
 */

/**
 * claude 引擎按 CLI 存在性注册：沙箱里装了 claude-cli 才有 `handles: 'claude'`，
 * 发消息前的 409 `engine_not_available` 闸（server.ts）靠 `drivers.list()` 判断
 * —— 注册即承诺可用。探测失败只是引擎缺席，runtime 照常启动。
 */
const claudeDriver: AgentDriver | null = isClaudeCliAvailable()
  ? createClaudeDriver()
  : null

/** ⚠️ handles 要覆盖全，否则 `get()` 会抛错而调用点可能没处理。 */
const DRIVERS: AgentDriver[] = claudeDriver ? [vercelAiDriver, claudeDriver] : [vercelAiDriver]

const registry: DriverRegistry = {
  get(endpointProtocol: string): AgentDriver {
    const found = DRIVERS.find((driver) => driver.handles === endpointProtocol)
    if (!found) {
      // ⚠️ **抛错，不返回 null。**
      // 返回 null 会让调用点写 `if (!driver)` 分支，而那种分支的典型处理
      // 是「静默降级」—— 于是配错协议的症状变成「工具全都不工作」，极难查。
      const supported = registry.list()
      throw new Error(
        `没有能处理协议「${endpointProtocol}」的 Driver。已注册：${supported.join(' / ') || '（无）'}。` +
          '新增一家 SDK 只需要实现 AgentDriver 并在 src/drivers/index.ts 注册。'
      )
    }
    return found
  },

  list(): string[] {
    return DRIVERS.map((driver) => driver.handles)
  },
}

export { registry as drivers }
export type { AgentDriver, DriverRegistry }