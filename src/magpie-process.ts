import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { magpieChatBaseUrl, magpieListen } from './upstream.js'

/**
 * 拉起 `magpie serve`。网关已经在听就不再起第二个。
 *
 * `MAGPIE_AUTOSTART=0` 时跳过（Magpie 由别的方式管）。
 * 本机没有 `magpie` 可执行文件时只记一条日志，little-one 照常起来 ——
 * 模型调用会在连不上网关时报错，而不是在启动时把整个 runtime 掐死。
 */

let child: ChildProcess | null = null

export async function ensureMagpie(): Promise<void> {
  if (process.env.MAGPIE_AUTOSTART === '0') return

  const { host, port } = magpieListen()
  if (await canConnect(host, port)) {
    console.log(`[agent] Magpie 已在 ${magpieChatBaseUrl()}，不另起进程。`)
    return
  }

  const addr = `${host}:${port}`
  console.log(`[agent] 启动 magpie serve（${addr}）。`)
  const proc = spawn('magpie', ['serve'], {
    stdio: 'inherit',
    env: { ...process.env, MAGPIE_ADDR: process.env.MAGPIE_ADDR?.trim() || addr },
  })
  child = proc
  proc.on('error', (error) => {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    console.error(
      missing
        ? '[agent] 找不到 magpie 可执行文件。安装后再启动，或设 MAGPIE_AUTOSTART=0 并自己跑 `magpie serve`。' +
            '安装：curl -fsSL https://usemagpie.ai/install.sh | sh'
        : `[agent] magpie serve 启动失败：${error.message}`,
    )
  })
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null
    if (code !== 0 && code !== null) {
      console.error(`[agent] magpie serve 退出了（code ${code}${signal ? `，signal ${signal}` : ''}）。`)
    }
  })

  const up = await waitForPort(host, port, 5_000)
  if (!up) {
    console.error(
      `[agent] 5 秒内没有连上 ${addr}。little-one 继续启动；模型请求会在 Magpie 就绪之后才能发出。`,
    )
  }
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const finish = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(300)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPort(host: string, port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return canConnect(host, port)
}
