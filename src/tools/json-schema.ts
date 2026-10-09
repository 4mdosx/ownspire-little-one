import { z } from 'zod'
import type { JsonSchemaNode, JsonSchemaObject } from '../protocol/raven-tool-protocol.js'

/**
 * JSON Schema → zod。
 *
 * ## 为什么需要这个
 *
 * 协议只能传 JSON（跨进程），而模型要的是 zod —— 所以每条工具定义过线之后
 * 都得转一次。**这个转换是「raven 加工具、runtime 不用改代码」这句话的全部成本。**
 *
 * ⚠️ 如果 runtime 里还手抄一份工具表，那协议就是装饰：
 * 两边各自维护一份定义，漂移只是时间问题，而漂移的那一次表现为
 * 「模型按 A 的 schema 构造参数，raven 按 B 校验，于是永远 invalid_input」。
 *
 * ## 认不出来的类型怎么办
 *
 * 一律降级成 `z.any()`。**不抛错** —— 一个只用来给模型描述入参的 schema，
 * 认不全比认不了强：降级之后模型还能正确调用，只是少了一层校验；
 * 抛错则整条工具链起不来。
 *
 * 校验的责任仍在 raven（它按同一份 JSON Schema 真校验），
 * 这里只是让模型**看得见**字段长什么样。
 */

export function toZod(schema: JsonSchemaNode | undefined): z.ZodTypeAny {
  if (schema === undefined) return z.any()
  if (typeof schema === 'boolean') return schema ? z.any() : z.never()

  switch (schema.type) {
    case 'object':
      return toZodObject(schema)
    case 'string':
      return toZodString(schema)
    case 'number':
    case 'integer':
      return toZodNumber(schema)
    case 'boolean':
      return applyDescription(z.boolean(), schema.description)
    case 'array':
      return applyDescription(z.array(toZod(schema.items)), schema.description)
    case 'null':
      return z.null()
    default:
      // 没有 type 但有 enum：JSON Schema 允许，模型也认得。
      if (Array.isArray(schema.enum) && schema.enum.length > 0) return toZodEnum(schema)
      return applyDescription(z.any(), schema.description)
  }
}

function toZodObject(schema: JsonSchemaObject): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])

  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const field = toZod(value)
    shape[key] = required.has(key) ? field : field.optional()
  }

  // ⚠️ 没有 properties 也要给 object 而不是 any：模型看到 `{}` 与看到
  // 「随便什么都行」构造出来的参数完全不同。
  return applyDescription(z.object(shape), schema.description)
}

function toZodString(schema: JsonSchemaObject): z.ZodTypeAny {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return toZodEnum(schema)
  let base = z.string()
  if (typeof schema.minLength === 'number') base = base.min(schema.minLength)
  if (typeof schema.maxLength === 'number') base = base.max(schema.maxLength)
  return applyDescription(base, schema.description)
}

function toZodNumber(schema: JsonSchemaObject): z.ZodTypeAny {
  let base = schema.type === 'integer' ? z.number().int() : z.number()
  if (typeof schema.minimum === 'number') base = base.min(schema.minimum)
  if (typeof schema.maximum === 'number') base = base.max(schema.maximum)
  return applyDescription(base, schema.description)
}

function toZodEnum(schema: JsonSchemaObject): z.ZodTypeAny {
  const values = (schema.enum ?? []).filter(
    (value): value is string => typeof value === 'string'
  )
  if (values.length === 0) return applyDescription(z.any(), schema.description)
  // zod 4 的 z.enum 需要一个非空元组；长度在运行时才知道，所以走数组重载。
  return applyDescription(z.enum(values as [string, ...string[]]), schema.description)
}

/**
 * 把 `description` 挂上去。
 *
 * ⚠️ 这不是装饰：**`description` 是模型理解这个字段的唯一来源**。
 * 一个没有描述的 `z.string()` 会让模型猜，而猜错的入参会一路走到 raven
 * 才被 `invalid_input` 挡回来 —— 白白多一轮。
 */
function applyDescription<T extends z.ZodTypeAny>(schema: T, description?: string): T {
  if (!description) return schema
  return schema.describe(description) as T
}
