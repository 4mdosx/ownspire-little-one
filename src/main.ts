import { startServer } from './server.js'

/**
 * 进程入口。
 *
 * **顶层的 unhandledRejection 必须存在**：一轮对话可能跑十几秒，
 * 而 HTTP 层的 catch 只覆盖到「响应还没发出」那段。流开始之后的错误
 * 由 createAgentStream 兜住，但它自己也是通过抛错来上报的 ——
 * 没有这层兜底，一个模型调用失败会变成一个静默退出的进程。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[agent] 未处理的Promise 拒绝：', reason)
})

process.on('uncaughtException', (error) => {
  console.error('[agent] 未捕获异常：', error)
  process.exit(1)
})

startServer()