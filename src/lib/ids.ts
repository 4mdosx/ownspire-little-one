import crypto from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * 有前缀的排序友好 id。**不是** UUID v4：
 * 随机 id在分页时靠 `ORDER BY createdAt` 兜，而同一毫秒内的插入顺序会不稳。
 */
export function id(prefix: string): string {
  const bytes = crypto.randomBytes(12)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return `${prefix}_${out}`
}

export function now(): number {
  return Date.now()
}

/** 定长比较，避免 `timingSafeEqual` 因长度不同直接抛错。 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}