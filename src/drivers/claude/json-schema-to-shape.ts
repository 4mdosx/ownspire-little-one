import { z } from 'zod/v4'

/**
 * JSON Schema → zod/v4 原始 shape（`Record<string, z4.ZodType>`）。
 *
 * claude-agent-sdk 的 `tool()` 只吃 zod shape，而业务工具的权威 schema 是
 * registry 里的 zod3（`toJsonSchema` 已能产出 JSON Schema）。桥接走
 * JSON Schema 这条中立格式，而不是把两代 zod 实例混用 —— v3 实例喂给
 * v4 的反射函数是运行时炸弹，类型系统查不出来。
 *
 * ⚠️ **只支持业务工具实际用到的子集**（string / number / boolean / enum /
 * array / object / optional）。子集之外的约束（pattern、min/max 等）被丢弃，
 * 兜底是两层下推：
 * 1. SDK 侧只有 shape，模型看到的是丢弃后的描述（可能偶尔给错参数）；
 * 2. **raven 网关仍拿原始 schema 做权威校验**（「raven 不能只信 runtime」），
 *    错参数在网关被打成 invalid_input 回来 —— 治理不受影响，工具调用失败而已。
 *
 * 会改变治理语义的东西（required、enum）都在子集内，不会丢。
 */

type JsonSchemaObject = {
  type?: string
  properties?: Record<string, JsonSchemaObject>
  required?: string[]
  enum?: unknown[]
  items?: JsonSchemaObject
  description?: string
}

export function jsonSchemaToShape(schema: unknown): Record<string, z.ZodType> {
  const root = asObject(schema)
  if (!root || root.type !== 'object') {
    // 顶层不是 object 的业务工具没有参数 —— 给空 shape，而不是猜。
    return {}
  }
  return objectShape(root)
}

function objectShape(schema: JsonSchemaObject): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {}
  const required = new Set(schema.required ?? [])
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const field = leafSchema(prop)
    shape[name] = required.has(name) ? field : field.optional()
  }
  return shape
}

function leafSchema(schema: JsonSchemaObject): z.ZodType {
  if (schema.enum !== undefined) {
    const values = schema.enum.filter((v) => typeof v === 'string') as [string, ...string[]]
    if (values.length > 0) {
      const enumerated = z.enum(values)
      return schema.description ? enumerated.describe(schema.description) : enumerated
    }
  }
  switch (schema.type) {
    case 'string':
      return withDescription(z.string(), schema.description)
    case 'number':
    case 'integer':
      return withDescription(z.number(), schema.description)
    case 'boolean':
      return withDescription(z.boolean(), schema.description)
    case 'array':
      return withDescription(z.array(itemsOf(schema)), schema.description)
    case 'object':
      return withDescription(z.object(objectShape(schema)), schema.description)
    default:
      // 未知类型按任意 JSON 值放行 —— raven 的权威校验在下游。
      return withDescription(z.unknown(), schema.description)
  }
}

function itemsOf(schema: JsonSchemaObject): z.ZodType {
  return schema.items ? leafSchema(schema.items) : z.unknown()
}

function withDescription(schema: z.ZodType, description?: string): z.ZodType {
  return schema.description ? schema.describe(schema.description) : schema
}

function asObject(value: unknown): JsonSchemaObject | null {
  return typeof value === 'object' && value !== null ? (value as JsonSchemaObject) : null
}
