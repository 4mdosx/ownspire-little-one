/**
 * **协议层纯净性检查。** 这个脚本存在的原因：
 *
 * 「协议层不许 import `ai`」写在注释里没人看，
 * 写进 CI（或者每次 `npm test`）才会一直成立。
 *
 * 抽象一旦被破坏是**静默**的 —— 某人赶时间加了个 import，
 * 协议层测试照样全绿（因为 SDK 类型与我们的类型形状相近），
 * 而「换一家 SDK 时协议层不用改」这个承诺已经废了。
 *
 * 跑法：node --import tsx scripts/verify-protocol-purity.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** 协议层不许碰的东西。 */
const FORBIDDEN = [
  { pattern: /from\s+['"]ai['"]/, why: 'ai（Vercel AI SDK）' },
  { pattern: /from\s+['"]@ai-sdk\//, why: '@ai-sdk/*（Vercel AI SDK 的 provider）' },
  { pattern: /from\s+['"]@anthropic-ai\//, why: '@anthropic-ai/*（Claude SDK）' },
  { pattern: /from\s+['"]openai['"]/, why: 'openai 官方 SDK' },
  { pattern: /from\s+['"]@google\/generative-ai['"]/, why: 'Google SDK' },
  { pattern: /\brequire\(['"]ai['"]\)/, why: 'ai（CommonJS 写法）' },
]

/**
 * 协议层的目录。**列出来而不是靠路径前缀判断** ——
 * 前缀判断会在目录改名时静默失效，而这里是显式的清单。
 */
const PROTOCOL_DIRS = ['src/protocol', 'src/tools', 'src/lib']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      // node_modules 不在src 下，但跳过 test/ 与 .d.ts 保持清单可读
      if (name === 'node_modules' || name === 'test') continue
      walk(full, out)
    } else if (name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

let failures = 0
let checked = 0
const offenders: { file: string; line: number; text: string; why: string }[] = []

for (const dir of PROTOCOL_DIRS) {
  const abs = join(ROOT, dir)
  for (const file of walk(abs)) {
    checked += 1
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, index) => {
      // 注释里出现不算 —— 文档要能提这些名字。
      const trimmed = text.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(text)) {
          offenders.push({
            file: relative(ROOT, file),
            line: index + 1,
            text: text.trim(),
            why: rule.why,
          })
        }
      }
    })
  }
}

console.log(`\n协议层纯净性：检查了 ${checked} 个文件（${PROTOCOL_DIRS.join(' / ')}）\n`)

if (offenders.length === 0) {
  console.log('  ✓ 协议层没有 import 任何 SDK')
  console.log('\n  这意味着换一家 SDK 时，协议层与协议层的测试都不用改。\n')
  process.exit(0)
}

console.log(`  ✗ 发现 ${offenders.length} 处 SDK 依赖：\n`)
for (const item of offenders) {
  console.log(`    ${item.file}:${item.line}`)
  console.log(`      ${item.text}`)
  console.log(`      ↳ ${item.why}\n`)
}
console.log(`  怎么修：把 SDK 调用挪进 src/drivers/<protocol>/，协议层只调 AgentDriver。`)
console.log(`  如果确实需要该类型，先问「协议层为什么要知道这件事」。\n`)

failures = offenders.length
process.exitCode = 1