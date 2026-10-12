/**
 * 启动时拉起 Magpie：已经在听就不动，起不来就失败，配置目录传给子进程。
 * 用一个假的可执行文件听端口，不下载真的 magpie。
 */

import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { ensureMagpie, stopMagpie } from '../src/magpie-process.js'

let assertions = 0
let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  assertions += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}`)
  if (detail !== undefined) console.log(`      ${String(detail).slice(0, 300)}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'magpie-proc-'))
  const fake = path.join(dir, 'magpie.mjs')
  const marker = path.join(dir, 'marker')
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
const marker = process.env.MAGPIE_FAKE_MARKER
if (marker) writeFileSync(marker, process.env.XDG_CONFIG_HOME ?? '')
if (process.env.MAGPIE_FAKE_MODE === 'exit') process.exit(2)
const raw = process.env.MAGPIE_ADDR ?? '127.0.0.1:9'
const colon = raw.lastIndexOf(':')
const host = raw.slice(0, colon)
const port = Number(raw.slice(colon + 1))
createServer((socket) => socket.end()).listen(port, host)
`,
  )
  chmodSync(fake, 0o755)

  const saved = {
    autostart: process.env.MAGPIE_AUTOSTART,
    base: process.env.MAGPIE_BASE_URL,
    bin: process.env.MAGPIE_BIN,
    state: process.env.MAGPIE_STATE_DIR,
    addr: process.env.MAGPIE_ADDR,
    mode: process.env.MAGPIE_FAKE_MODE,
    marker: process.env.MAGPIE_FAKE_MARKER,
  }
  const restore = (): void => {
    for (const [key, value] of Object.entries({
      MAGPIE_AUTOSTART: saved.autostart,
      MAGPIE_BASE_URL: saved.base,
      MAGPIE_BIN: saved.bin,
      MAGPIE_STATE_DIR: saved.state,
      MAGPIE_ADDR: saved.addr,
      MAGPIE_FAKE_MODE: saved.mode,
      MAGPIE_FAKE_MARKER: saved.marker,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  try {
    console.log('\n[Magpie · 启动]')

    delete process.env.MAGPIE_ADDR
    delete process.env.MAGPIE_FAKE_MODE
    process.env.MAGPIE_AUTOSTART = '0'
    process.env.MAGPIE_BIN = path.join(dir, 'missing')
    process.env.MAGPIE_BASE_URL = 'http://127.0.0.1:9/v1'
    try {
      await ensureMagpie()
      check('MAGPIE_AUTOSTART=0 时不拉起', true)
    } catch (error) {
      check('MAGPIE_AUTOSTART=0 时不拉起', false, error instanceof Error ? error.message : error)
    }

    delete process.env.MAGPIE_AUTOSTART
    const heldPort = await freePort()
    const held = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => held.listen(heldPort, '127.0.0.1', resolve))
    process.env.MAGPIE_BASE_URL = `http://127.0.0.1:${heldPort}/v1`
    process.env.MAGPIE_BIN = path.join(dir, 'missing')
    try {
      await ensureMagpie()
      check('端口上已经有 Magpie 就不再起进程', true)
    } catch (error) {
      check('端口上已经有 Magpie 就不再起进程', false, error instanceof Error ? error.message : error)
    }
    held.close()

    const port = await freePort()
    process.env.MAGPIE_BASE_URL = `http://127.0.0.1:${port}/v1`
    process.env.MAGPIE_BIN = fake
    process.env.MAGPIE_STATE_DIR = path.join(dir, 'state')
    process.env.MAGPIE_FAKE_MARKER = marker
    delete process.env.MAGPIE_FAKE_MODE
    try {
      await ensureMagpie()
      const wrote = readFileSync(marker, 'utf8')
      check('子进程起来并在端口上听', true)
      check(
        'MAGPIE_STATE_DIR 传成了子进程的配置目录',
        wrote === path.join(dir, 'state', 'config'),
        wrote,
      )
    } catch (error) {
      check('子进程起来并在端口上听', false, error instanceof Error ? error.message : error)
      check('MAGPIE_STATE_DIR 传成了子进程的配置目录', false)
    }
    await stopMagpie()

    process.env.MAGPIE_FAKE_MODE = 'exit'
    const deadPort = await freePort()
    process.env.MAGPIE_BASE_URL = `http://127.0.0.1:${deadPort}/v1`
    let message = ''
    try {
      await ensureMagpie()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    check('magpie 马上退出 → 启动失败', message.includes('退出'), message)
    await stopMagpie()

    process.env.MAGPIE_BIN = path.join(dir, 'no-such-magpie')
    delete process.env.MAGPIE_FAKE_MODE
    const absentPort = await freePort()
    process.env.MAGPIE_BASE_URL = `http://127.0.0.1:${absentPort}/v1`
    let missing = ''
    try {
      await ensureMagpie()
    } catch (error) {
      missing = error instanceof Error ? error.message : String(error)
    }
    check('找不到二进制 → 启动失败', missing.includes('不存在'), missing)
  } finally {
    await stopMagpie()
    restore()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n${assertions - failures}/${assertions} 条断言通过。\n`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
