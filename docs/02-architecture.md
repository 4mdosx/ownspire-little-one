# 02 · 分层：协议层 / Adapter / 目录层

**契约（01）说「线上是什么形状」，这份说「代码为什么这么切」。**

## 一、三层

```
        raven（宿主 UI / 工具提供方）
                 │  HTTP + SSE（契约 §四）
                 ▼
   ┌──────────────────────────────────────┐
   │  协议层  src/protocol/                │  ← 零 SDK 依赖（机器检查）
   │  编排 · 授权判定 · 上下文重建 · 落库   │
   └──────────────────────────────────────┘
                 │  AgentDriver 接口
                 ▼
   ┌──────────────────────────────────────┐
   │  Adapter  src/drivers/<name>/        │  ← 唯一 import `ai` 的地方
   │  消息翻译 · 审批翻译 · 流 → 事件      │
   └──────────────────────────────────────┘
                 │
                 ▼   目录层 src/db/registry-store.ts
        厂商 → 端点(协议) → 模型      ← 配置全在库里
```

**协议层不在 raven 里。** raven 是 Agent 的宿主与工具提供方，它一旦承担
「SDK 抽象」，依赖方向就倒回去（`raven → agent SDK`）。

## 二、Adapter 按协议切，不按厂商切

被智谱的端点布局逼出来的：

| 端点 | 协议 |
|---|---|
| `open.bigmodel.cn/api/paas/v4` | `openai-chat-completions` |
| `open.bigmodel.cn/api/v1` | `openai-responses` |
| `open.bigmodel.cn/api/anthropic` | `anthropic-messages` |

一家厂商三种协议。按厂商切的话 GLM 要挂三个 adapter，而 OpenAI 官方
得挂在「GLM 那个」旁边 —— **名字一样但协议不同，那不是分组，是巧合。**

反过来，**协议相同就能共用一个 Adapter**：GLM / DeepSeek / Kimi / OpenAI 官方
全是 `openai-chat-completions`，一个 adapter + 几行库配置。

`ProtocolFamily` 是**生产概念**，加一个值意味着要写一个 Adapter。
测试里的假协议用断言绕开，**不往生产类型里加 'fake'**。

## 三、厂商 → 端点 → 模型

| 表 | 承担 | 不承担 |
|---|---|---|
| `providers` | 厂商 + **key 的环境变量名** + 默认协议 | key 本身（**永远不进库**） |
| `endpoints` | 属于哪个厂商、**走哪种协议**、baseUrl、厂商扩展参数 | 凭据 |
| `models` | 挂在哪个端点、默认 reasoning_effort | —— |

- **key 只在环境变量里。** 库里存的是变量名（`keyEnvVar`）。
  理由：key 入库就会出现在备份里，而备份是要被复制/上传的。
- **端点可覆盖厂商的默认协议。** 同一厂商多端点多协议是常态。
- **模型按 `(endpointId, id)` 唯一**，不是按 `id` —— 同名模型在不同端点各存一份。

**接一家新厂商（协议已支持）**：只改数据库，不动代码。
**接一种新协议**：写一个 Adapter + 在 `src/drivers/index.ts` 注册一行。

## 四、三组测试，各验各的

| 组 | 命令 | 验什么 | 不碰什么 |
|---|---|---|---|
| A 协议层 | `verify:protocol` | 编排语义：授权拦阻、步数上限、事件顺序、错误归类、上下文重建 | 任何 SDK |
| B Adapter | `verify:driver` | 翻译正确性：消息形状、并行 seq、审批配置、厂商扩展参数 | 数据库 |
| C 目录层 | `verify:registry` | 外键与唯一约束、协议继承与覆盖 | 模型调用 |
| 纯度 | `verify:purity` | `src/protocol|tools|lib` 不许 import SDK | —— |

**A 用假 Driver，B 用 SDK 官方 mock**（不是自写的假 provider —— 2026-10-08
排查 `ai@7.0.70` 回归时两者行为不一致，白绕了很久）。

换 SDK 时：**A 一行不用改，只有 B 重写。** C 完全不动。

## 五、Vercel AI Adapter 兜住的四条 SDK 坑

都是「代码看起来对但不生效 / 报错位置离原因很远」的类型，
所以集中在 `src/drivers/vercel-ai/driver.ts` —— **换 SDK 时要改的恰好是这一个文件。**

1. **`toolApproval` 必须按名字给对象**，泛函形式类型合法但运行时无效
   （SDK 内部走 `getOwn(toolApproval, toolName)`）。症状：`tool.called` 正常发出，
   **但工具永不执行**。
2. **tool-call 的 `input` 必须是 JSON 字符串**（声明写 `unknown`，运行时调 `.trim()`）。
3. **tool 级 `needsApproval` 已废弃**，写了被静默忽略 —— 审批配在 Agent 级。
4. **`system` 消息必须转成 `instructions`** —— 留在 messages 里会让
   `ToolLoopAgent` 抛 `AI_InvalidPromptError`，而它在 `ModelMessage` 里是合法角色。

## 六、两个容易踩的部署坑

- **启动顺序**：`bootstrap()`（建库 + seed 目录）必须在配置检查之前。
  顺序反了会「库是空的 → 判成没配模型 → 拒绝启动」。
- **启动条件是「至少有一个可用端点」**，不是「所有厂商都有 key」。
  内置厂商是自动 seed 的，用后者当条件等于「不配 DeepSeek 就起不来」。
  缺 key 的厂商记警告即可。
