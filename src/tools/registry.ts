import { z } from 'zod'

/**
 * 工具定义。**这是 Runtime 与业务之间唯一的耦合面。**
 *
 * 三条不能破的：
 *
 * 1. **一个工具只做一件事。** `todo.create` 里如果顺手做了「顺便更新父任务状态」，
 *    那就变成两个能力，而失败时你分不清是哪一半出的问题。
 * 2. **入参有明确 Schema，且 Schema 与实现分开声明。** `inputSchema` 同时喂给模型
 *    和校验器——模型看到什么、校验器判什么，必须是同一份，否则「校验通过但模型
 *    理解错了」会变成一类查不出来的 bug。
 * 3. **`risk` 由工具自己声明，不是由调用方推断。** 删文件的工具自己知道它会删文件。
 *    猜出来的风险等级是假的授权。
 */

export type Risk = 'read' | 'write' | 'destructive'

export type ToolDefinition<Input extends z.ZodTypeAny = z.ZodTypeAny> = {
  /** 稳定标识。**改名等于改契约**（docs/01-contract.md §一）。 */
  name: string
  /** 给 UI 看的短标题。 */
  title: string
  /** 给模型看的描述——决定模型会不会用它，所以比 UI 文案重要得多。 */
  description: string
  inputSchema: Input
  execute: (input: z.infer<Input>) => Promise<unknown>
  risk: Risk
  /**
   * 非 null 时 UI 应要求用户原样输入它才能批准。
   * **UI 收不收这个词只是体验**，agent 服务端不依赖它。
   */
  confirmationPhrase?: string
}

const registry = new Map<string, ToolDefinition<never>>()

export function defineTool<Input extends z.ZodTypeAny>(definition: ToolDefinition<Input>): void {
  const existing = registry.get(definition.name)
  if (existing) {
    throw new Error(
      `工具 ${definition.name} 重复注册。工具名是契约的一部分，不允许后注册顶掉先注册。`,
    )
  }
  registry.set(definition.name, definition as unknown as ToolDefinition<never>)
}

export function tool<Input extends z.ZodTypeAny>(definition: ToolDefinition<Input>): ToolDefinition<Input> {
  defineTool(definition)
  return definition
}

export function allTools(): ToolDefinition<never>[] {
  return [...registry.values()]
}

export function toolNames(): string[] {
  return [...registry.keys()]
}

export function findTool(name: string): ToolDefinition<never> | undefined {
  return registry.get(name)
}

/**契约 §三：未知工具名返回 400，不静默丢弃。 */
export class UnknownToolError extends Error {
  readonly code = 'unknown_tool'
  constructor(readonly missing: string[]) {
    super(`未知工具：${missing.join(', ')}`)
    this.name = 'UnknownToolError'
  }
}

export function resolveTools(names: string[]): ToolDefinition<never>[] {
  const missing = names.filter((name) => !registry.has(name))
  if (missing.length > 0) throw new UnknownToolError(missing)
  return names.map((name) => registry.get(name)!)
}

/** 契约 §三 `GET /api/tools` 的形状。字段够 raven 画审批卡片。 */
export function toolCatalog(): {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  risk: Risk
  confirmationPhrase: string | null
}[] {
  return allTools().map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: toJsonSchema(definition.inputSchema),
    risk: definition.risk,
    confirmationPhrase: definition.confirmationPhrase ?? null,
  }))
}

// ---------------------------------------------------------------------------
// zod → JSON Schema
//
// 只喂给 UI 渲染卡片，**不喂给模型**（模型那边 SDK 用 zod 原生 schema）。
// 手写而不是引 zod-to-json-schema：一个只服务三个工具的项目不值得多一个依赖，
// 而且这条路径的输出**不参与安全判定**——只是给 UI 显示字段用的。
// ---------------------------------------------------------------------------

type ZodDef = Record<string, unknown>

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def?: ZodDef })._def ?? {}
}

export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = defOf(schema)
  const typeName = def.typeName as string | undefined

  let base: Record<string, unknown> = {}

  switch (typeName) {
    case 'ZodString': {
      base.type = 'string'
      const checks = Array.isArray(def.checks) ? (def.checks as { kind: string; value: number }[]) : []
      const min = checks.find((c) => c.kind === 'min')
      const max = checks.find((c) => c.kind === 'max')
      if (min) base.minLength = min.value
      if (max) base.maxLength = max.value
      break
    }
    case 'ZodNumber':
      base.type = 'number'
      break
    case 'ZodBoolean':
      base.type = 'boolean'
      break
    case 'ZodArray':
      base.type = 'array'
      if (def.type) base.items = toJsonSchema(def.type as z.ZodTypeAny)
      break
    case 'ZodObject': {
      base.type = 'object'
      const shape = typeof def.shape === 'function' ? (def.shape() as Record<string, z.ZodTypeAny>) : {}
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value)
        if (!value.isOptional()) required.push(key)
      }
      base.properties = properties
      if (required.length > 0) base.required = required
      break
    }
    case 'ZodEnum':
      base.type = 'string'
      base.enum = def.values
      break
    case 'ZodOptional':
    case 'ZodNullable':
      base = toJsonSchema(def.innerType as z.ZodTypeAny)
      break
    case 'ZodDefault':
      base = toJsonSchema(def.innerType as z.ZodTypeAny)
      break
    default:
      // 认不出来的类型一律当 string。只服务 UI 显示，保守比「什么都不显示」好。
      base.type = 'string'
      break
  }

  const description = (schema as unknown as { description?: string }).description
  if (description) base.description = description
  return base
}