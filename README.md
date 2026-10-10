# little-one

> *The Little One Inside the Flask.*

ownspire 的 **Agent Runtime**：负责**模型下一步做什么**。
接收一句话，编排外部工具，把执行过程作为事件流吐出来。
**它不实现任何业务** —— 工具由 raven 那样的执行服务提供。

名字取自 Philip K. Dick 的意象：烧瓶里那个活着的小东西。**模型就是它** ——
有心思，没有手脚，碰不到外面。这个项目是它与外界之间唯一的通道：
**Loop 决定什么时候再想一次，Tool Calling 是它伸出去的那只手。**

| | |
|---|---|
| 端口 | 容器 **5900**（atlas 5600 · navi 5500 · raven 5800 之后的下一个） |
| 契约 | **[docs/01-contract.md](docs/01-contract.md)** v1 冻结，改它需要升版本号 |
| 框架层 | `ai@7.0.60` —— Agent Loop，**不随模型换** |
| 模型层 | `@ai-sdk/openai` —— 换厂商只改数据库配置，不改代码 |
| 执行 | raven —— 工具在哪执行、有什么权限、怎么隔离，都由它决定 |

## 与 raven 怎么分

| | little-one（本项） | raven |
|---|---|---|
| 工程领域 | Agent Orchestration | Agent Execution Infrastructure |
| 回答的问题 | **模型下一步做什么？** | **如何安全、可靠地执行？** |
| 拥有 | 面向模型的 Tool Registry | 实际的 Tool Executor Registry |
| 知道 | 上下文、第几轮、为什么调这个工具 | Workspace、权限、沙箱、执行多久 |
| 不知道 | 工具在哪执行、怎么隔离 | 用的是 GLM 还是 MiMo、为什么调它 |

**判据**：完全移除 LLM 后仍有独立意义的能力，大概率属于 raven。
「在沙箱里跑 rg」没有模型照样有意义 → raven。
「什么时候再问一次模型」没有模型就没意义 → 这里。

两边只过一个很窄的协议（逻辑接口，不绑定 HTTP）：

```ts
interface RavenClient {
  listTools(workspaceId: string): Promise<ToolDefinition[]>
  executeTool(request: {
    workspaceId: string
    toolName: string
    arguments: unknown
  }): Promise<ToolResult>
  cancelExecution(executionId: string): Promise<void>
}
```

权限校验由 raven 自己完成 —— **它不能只信 runtime 传来的 workspaceId**。
两个项目各自维护代码与测试，由同一个 Compose 项目统一部署、升级。

---

## 模型怎么配

**全部在数据库里，用 raven 的「模型与厂商」界面填。环境变量不参与**（2026-10-09 裁定）。

三张表：`providers`（厂商 + key + 默认协议）→ `endpoints`（走哪种协议 + baseUrl）
→ `models`（模型 id + 推理档位）。启动时幂等 seed 内置的三家厂商与端点，
但 **key 不 seed** —— 所以刚起来一定是「未配置 key」，那是真的没配。

| 想改什么 | 去哪改 |
|---|---|
| API key | 界面 · 厂商段 · API key 输入框 |
| 端点地址、协议 | 界面 · 端点段 |
| 有哪些模型可选 | 界面 · 模型段 |
| 默认用哪个 | `models` 表的第一项（没有单独开关） |

⚠️ **曾经有过 env 线路**（`OPENAI_API_KEY` / `AGENT_MODEL` / `AGENT_REASONING_EFFORT`），
现在全删了，`providers.keyEnvVar` 那一列也没了。旧数据库启动时会**自动 `DROP COLUMN` 迁移**
（在真有数据的库上验过：不丢数据，端点与会话都在）；只有该列被索引或外键引用而删不掉时
才拒绝启动并报出原因。

删掉的理由不是「更干净」，是**两份真相会让用户改错地方却看到「已保存」**：
界面上填的 key 被容器注入的 env 盖掉，而提示语说的是「配置完成」。
一份真相可以有很多呈现方式，两份真相只会让人猜哪份生效。

模型清单不在代码里硬编码 —— 列一份与实际端点不符的清单比不列更糟：
用户会选了才发现用不了。

---

## 它是什么，不是什么

| 是 | 不是 |
|---|---|
| Agent Loop（会话、模型调用、工具编排） | 一个 Agent 框架（不提供插件市场、不做 Skill 分发） |
| 事件流（`tool.called` / `approval.requested` …） | 业务数据存储（数据在 atlas / navi / raven 那里） |
| 权限的**强制执行点** | 权限的**声明**——`risk` 由工具自己写在 `src/tools/` 里 |
| 一个可复用的执行服务 | 一个聊天前端（UI 在 raven） |

**最值钱的地方不是 Agent 有多智能，而是把不确定的 AI 决策与确定的软件能力隔离开。**
模型说「已获授权」不算，Prompt 里写「你可以随便删」也不算——只有工具声明的 `risk`
与 `src/agent/loop.ts` 里那张映射表说了算。

---

## 跑起来

```bash
npm install
cp .env.example .env            # 填 AGENT_RUNTIME_TOKEN（至少 16 字符）与模型 key
npm run dev                     # http://127.0.0.1:5900
```

```bash
npm run typecheck
curl -s localhost:5900/healthz | jq
```

`/healthz` 免鉴权（infra 的健康检查要在无凭据环境下工作），返回 7 位 commit，
与 atlas / navi / raven 同一套服务契约。

---

## 目录

```
src/
├── main.ts          进程入口（含 unhandledRejection 兜底）
├── server.ts        路由 —— 每个 handler 对应契约的一节
├── config/env.ts    部署参数（库路径/ token / 端口）。**模型配置不在这里**
├── agent/loop.ts    Agent Loop：SDK 的流 → 契约的八个事件
├── tools/
│   ├── registry.ts  工具定义、风险、JSON Schema 导出
│   └── builtin.ts   v1 三个工具：echo / add / removeFile
├── db/
│   ├── schema.ts    建表SQL。撞旧表抛错，不自动迁移
│   └── sessions.ts  会话、run、消息的读写
└── lib/
    ├── http.ts      手写路由 + 鉴权 + JSON
    ├── sse.ts       SSE 封装。事件形状就是契约
    └── turn.ts      一轮对话的编排
docs/
├── 01-contract.md   v1 冻结契约
└── 03-known-gaps.md v1 明确不做的事，以及后果
```

---

## 工具怎么加

**一个工具只做一件事。** 在 `src/tools/` 里：

```ts
import { z } from 'zod'
import { tool } from './registry.js'

export const clipboardList = tool({
  name: 'clipboard.list',          // 稳定标识，改名 = 破坏契约
  title: '读取剪切板',              // 给 UI 看
  description: '读取 raven 的网络剪切板…',  // 给模型看，比 UI 文案重要
  inputSchema: z.object({ limit: z.number().optional() }),
  risk: 'read',                    // read / write / destructive
  async execute(input) {
    const res = await fetch(`${RAVEN_URL}/api/agent/gateway`, { ... })
    return res.json()
  },
})
```

`risk: 'write'` 与 `'destructive'` **自动触发用户审批**，不需要在别处登记。
审批链路与 HMAC 签名都在 `src/agent/loop.ts` 里，工具自己不用管。

---

## ⚠️ 已知 SDK 问题（2026-10-08 实测）

### `ai@7.0.70` 起工具不再被执行 —— 已锁 `7.0.60`

**症状**：`tool.called` 正常发出，工具**永远不执行**，`steps` 停在 1，
模型看起来像「不愿意调这个工具」。没有报错。

**边界**（用 `MockLanguageModelV4` 跨版本实测）：

| 版本 | 工具执行 |
|---|---|
| 7.0.0 / 7.0.60 | ✅ `tool-call → tool-result` |
| 7.0.70 / 7.0.80 / 7.0.90 / 7.0.95 / 7.0.100 / 7.0.133 | ❌ 只到 `tool-call` |

所以 `package.json` 精确锁 `"ai": "7.0.60"`，**不要改成 `^7.0.60` 或 `~7.0.60`** ——
后两者会解析到 7.0.133 那个坏版本（`~7.0.60` 允许 `>=7.0.60 <7.1.0`，7.0.133 在里面）。

**怎么确认自己踩上了**：`npm run verify:driver`
应该看到 `tool.called → tool.completed → message.delta`。
只看到 `tool.called` 就是这个 bug。

### `toolApproval` 必须用对象形式，不能用泛函

SDK 的类型声明把 `ToolApprovalConfiguration` 定义成「泛函 | 按名字的对象」，
泛函形式**类型合法但运行时无效**：内部走 `getOwn(toolApproval, toolName)`，
泛函传进去这个查找返回 `undefined`，所有工具被归成 `not-applicable`，
而那条分支**既不发审批请求，也不把工具放进待执行队列**。

`src/drivers/vercel-ai/driver.ts` 的 `buildApprovalConfig()` 构造的是对象。
**换 SDK 大版本时这里必须重测。**

> ⚠️ 上面两条（以及 `system` 消息要转 `instructions`、tool-call 的 input 必须是
> JSON 字符串）现在统一记录在 `src/drivers/vercel-ai/driver.ts` 的文件头 ——
> **换 SDK 时要改的地方恰好是那一个文件**，别再散到别处。

### 两个「声明与实现不一致」的地方

1. **`tool-call` 的 `input` 必须是 JSON 字符串**，类型声明写的是 `unknown`，
   但运行时会调 `.trim()` —— 发对象会炸成 `toolCall.input.trim is not a function`。
2. **`needsApproval` 在 tool 级已 `@deprecated`**，写了会被忽略 →
   「我明明写了要审批」的代码会**静默地不审批**。审批配在 `ToolLoopAgent`/`streamText` 级。

---

## 验证

**按层分组**，各验各的。都不需要模型 key（用假 Driver / SDK 官方 mock
驱动真实代码路径），除了 `verify:stream`（要真服务）。

```bash
npm run typecheck
npm run verify              # 下面前四组

npm run verify:purity       # 协议层不许 import SDK（机器检查，9 个文件）
npm run verify:protocol     # 组 A 协议层：编排 / 审批 / 上下文重建        28 条
npm run verify:driver       # 组 B Vercel AI Adapter：翻译正确性          31 条
npm run verify:registry     # 组 C 目录层：厂商 → 端点(协议) → 模型        19 条

npm run verify:gateway      # raven 的反向 gateway：鉴权 / 沙箱 / 写操作被拒 15 条
npm run verify:stream       # SSE 事件形状与终止保证（需要先起服务）        14 条
```

**换一家 SDK 时：组 A 一行不用改，只有组 B 重写。** 组 C 完全不动。
分层理由与三条纪律见 `docs/02-architecture.md`。

---

## 本机环境

- **Node.js 24.15+**，ESM only（`ai@7` 的硬要求）。
- **`node:sqlite`**：连接惰性打开、`busy_timeout = 5000`、WAL。
  ⚠️ **别用「删 `-journal` 文件」修 `disk I/O error`**——那会绕过 SQLite 的回滚。
- **数据库默认在 `data/agent.db`**。工作区里写不了 SQLite 时设 `AGENT_DB_FILE` 指到别处。
- npm 源：`registry.npmmirror.com`（全局 registry 是需 token 的内网镜像）。