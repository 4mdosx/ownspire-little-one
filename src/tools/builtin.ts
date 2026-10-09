import { z } from 'zod'
import { tool } from './registry.js'

/**
 * v1 的工具集：**一个 echo + 一个真实工具**。
 *
 * 刻意不放四组 raven 工具。理由是契约 §四 那八个事件与 §五 的授权流程必须
 * 先端到端跑通一次——batch 地铺工具只会让「事件流对不对」和「工具对不对」
 * 两个问题同时出现在调试里。
 */

/**
 * 回声。**存在的唯一理由是让Loop 能被验证**：
 * 它不碰任何外部状态，所以如果它失败了，一定是 Loop 或模型层的问题，
 * 不可能是工具实现的问题。
 */
export const echo= tool({
  name: 'echo',
  title: '回声',
  description: '原样返回传入的文本。用于验证消息链路是否连通，不访问任何外部系统。',
  inputSchema: z.object({
    text: z.string().describe('要回显的文本'),
  }),
  risk: 'read',
  execute: async (input) => ({ text: input.text, length: input.text.length }),
})

/**
 * 加法。比echo 多一点：带两个参数，验证模型能不能正确构造结构化入参。
 */
export const add= tool({
  name: 'add',
  title: '加法',
  description: '计算两个数的和。用于验证模型能否正确构造带多个字段的工具入参。',
  inputSchema: z.object({
    a: z.number().describe('第一个加数'),
    b: z.number().describe('第二个加数'),
  }),
  risk: 'read',
  execute: async (input) => ({ sum: input.a + input.b }),
})

/**
 * 删除文件。**唯一带 `destructive` 的工具，也是唯一默认需要授权的。**
 *
 * 它存在的理由不是「让agent 能删文件」，而是**让授权流程有一个真实的后果可测**：
 * 如果授权链路断了，这个工具要么不该跑、要么该跑但被拦住 —— 两种情况都有迹可循。
 * 真正接上 raven 之后，它会变成 `files.delete`。
 */
export const removeFile= tool({
  name: 'removeFile',
  title: '删除文件',
  description:
    '删除受管工作目录下的一个文件。这是不可逆操作，执行前一定会请求用户确认。',
  inputSchema: z.object({
    path: z.string().describe('工作目录下的相对路径'),
  }),
  risk: 'destructive',
  confirmationPhrase: 'delete',
  execute: async () => {
    // v1 不真的删：还没有接文件系统，留一个显式的失败比一个假成功好。
    // 接 raven 之后这里会走 raven 的 /api/agent/gateway，仍由 raven 判沙箱边界。
    throw new Error('v1 未接文件系统，removeFile 不会真的删除任何东西。')
  },
})