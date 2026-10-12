import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { magpieChatBaseUrl, magpieListen } from './upstream.js'

/**
 * 拉起 `magpie serve`。网关已经在听就不再起第二个。
 *
 * `MAGPIE_AUTOSTART=0` 时跳过（Magpie 由别的进程管）。
 * 除此之外，起不来就抛错 —— 部署和本机启动都靠这一步把网关带起来，
 * 静默继续会让 little-one 健康检查全绿、第一轮对话才发现上游不在。
 *
 * 二进制：`MAGPIE_BIN`，否则 PATH，否则 `~/.local/bin/magpie`（官方安装器的位置）。
 * 部署镜像把 CLI 放在 `/usr/local/bin/magpie`，配置目录是 `MAGPIE_STATE_DIR`
 * （镜像里为 `/data/magpie`）。本机不设这个变量时，沿用 Magpie 自己的配置目录。
 */

const READY_MS = 15_000

let child: ChildProcess | null = null
let childReady = false
let onUnexpectedExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null

/** Magpie 在就绪之后自己退出时调用。main 用来让本进程一起退出，好让部署重启。 */
export function setMagpieExitHandler(
  handler: (code: number | null, signal: NodeJS.Signals | null) => void,
): void {
  onUnexpectedExit = handler
}

export async function ensureMagpie(): Promise<void> {
  if (process.env.MAGPIE_AUTOSTART === '0') return

  const { host, port } = magpieListen()
  if (await canConnect(host, port)) {
    console.log(`[agent] Magpie 已在 ${magpieChatBaseUrl()}，不另起进程。`)
    return
  }

  const bin = resolveMagpieBin()
  const addr = `${host}:${port}`
  console.log(`[agent] 启动 magpie serve（${bin}，${addr}）。`)

  const proc = spawn(bin, ['serve'], {
    detached: true,
    stdio: 'inherit',
    env: magpieChildEnv(addr),
  })
  child = proc
  childReady = false

  const started: { error: Error | null } = { error: null }
  proc.once('error', (error) => {
    started.error = error
  })
  let exitCode: number | null = null
  proc.on('exit', (code, signal) => {
    exitCode = code ?? 1
    if (child !== proc) return
    child = null
    if (!childReady) return
    console.error(
      `[agent] magpie serve 退出了（code ${code}${signal ? `，signal ${signal}` : ''}）。`,
    )
    onUnexpectedExit?.(code, signal)
  })

  const deadline = Date.now() + READY_MS
  while (Date.now() < deadline) {
    if (started.error) break
    if (exitCode !== null) break
    if (await canConnect(host, port)) {
      childReady = true
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  await stopMagpie()
  const failed = started.error
  if (failed) {
    const missing = (failed as NodeJS.ErrnoException).code === 'ENOENT'
    throw new Error(
      missing
        ? `找不到 magpie 可执行文件（${bin}）。${installHint()}`
        : `magpie 起不来：${failed.message}`,
    )
  }
  if (exitCode !== null) {
    throw new Error(`magpie serve 退出了（code ${exitCode}），${addr} 没有在听。`)
  }
  throw new Error(`magpie 在 ${READY_MS / 1000} 秒内没有在 ${addr} 上就绪。`)
}

/** 停掉本次拉起的 magpie（连同它的进程组）。已经在听、不是我们起的，不动。 */
export async function stopMagpie(): Promise<void> {
  const proc = child
  child = null
  childReady = false
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        // 进程组已经没了。
      }
      resolve()
    }, 1_000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    signalGroup(proc, 'SIGTERM')
  })
}

function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // 已经退出。
    }
  }
}

function resolveMagpieBin(): string {
  const fromEnv = process.env.MAGPIE_BIN?.trim()
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`MAGPIE_BIN 指向的文件不存在：${fromEnv}。${installHint()}`)
    }
    return fromEnv
  }
  const onPath = findOnPath('magpie')
  if (onPath) return onPath
  const local = path.join(homedir(), '.local', 'bin', 'magpie')
  if (existsSync(local)) return local
  throw new Error(`找不到 magpie 可执行文件。${installHint()}`)
}

function installHint(): string {
  return (
    '本机安装：curl -fsSL https://usemagpie.ai/install.sh | sh（命令在 ~/.local/bin）。' +
    '部署镜像里带 CLI。若 Magpie 由别的进程管，设 MAGPIE_AUTOSTART=0。'
  )
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function magpieChildEnv(addr: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAGPIE_ADDR: process.env.MAGPIE_ADDR?.trim() || addr,
  }
  const root = process.env.MAGPIE_STATE_DIR?.trim()
  if (!root) return env
  const home = path.join(root, 'home')
  const config = path.join(root, 'config')
  const cache = path.join(root, 'cache')
  const data = path.join(root, 'data')
  const state = path.join(root, 'state')
  for (const dir of [home, config, cache, data, state]) {
    mkdirSync(dir, { recursive: true })
  }
  env.HOME = home
  env.XDG_CONFIG_HOME = config
  env.XDG_CACHE_HOME = cache
  env.XDG_DATA_HOME = data
  env.XDG_STATE_HOME = state
  return env
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
