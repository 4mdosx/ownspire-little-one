# 02 · 分层：协议层 / Adapter / Magpie

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
                 │  只说 openai-chat-completions
                 ▼
              Magpie（本机进程）
        厂商 key · 协议互译 · 推理档位
```

**协议层不在 raven 里。** raven 是 Agent 的宿主与工具提供方，它一旦承担
「SDK 抽象」，依赖方向就倒回去（`raven → agent SDK`）。

## 二、出站只说一套协议

little-one 引擎的 Driver 只发 OpenAI Chat Completions，地址是 `MAGPIE_BASE_URL`。
Chat / Responses / Messages 的互译、厂商 key、`thinking` / `reasoning_effort`
都由 Magpie 写进上游请求。会话不存端点，也不存模型名。

模型名是部署参数 `MAGPIE_MODEL`（Magpie 上的 `provider/model` 或路由组）。
claude 引擎是另一条 loop：它把 Anthropic 环境变量指到 Magpie 的 origin，模型名仍是同一个。

旧库里的 `providers` / `endpoints` / `models` 在 `SCHEMA_VERSION` 2 启动时整表删掉。
会话行留下。`sessions.endpointId` / `sessions.modelId` 走 `DROP COLUMN`。

**换上游模型**：改 `MAGPIE_MODEL`，或在 Magpie 里改路由组指向的模型。
**接一种新的厂商协议**：改 Magpie 的配置，不在 little-one 里再写 Adapter。

## 四、三组测试，各验各的

| 组 | 命令 | 验什么 | 不碰什么 |
|---|---|---|---|
| A 协议层 | `verify:protocol` | 编排语义：授权拦阻、步数上限、事件顺序、错误归类、上下文重建 | 任何 SDK |
| B Adapter | `verify:driver` | 翻译正确性：消息形状、并行 seq、审批配置；请求不带厂商扩展参数 | 数据库 |
| 库形状 | `verify:registry` | 空库没有厂商 / 端点 / 模型表，会话上没有 endpointId / modelId | 模型调用 |
| 迁移 | `verify:migration` | 旧目录表被删掉，会话还在，schemaVersion 写成 2 | —— |
| 纯度 | `verify:purity` | `src/protocol|tools|lib` 不许 import SDK | —— |

**A 用假 Driver，B 用 SDK 官方 mock**（不是自写的假 provider —— 2026-10-08
排查 `ai@7.0.70` 回归时两者行为不一致，白绕了很久）。

⚠️ **迁移那组必须单独一个进程**：它要验的是「一个已经存在的旧结构」，
而库形状那组是在空库上跑 `ensureSchema()` 的 —— 那种库里永远没有要删的表，
于是迁移代码**一次都不会被执行**。自动迁移最典型的失败方式恰恰是
「从没被执行过」：代码看起来对、类型过得去、单测全绿，线上第一次跑旧库才炸。

换 SDK 时：**A 一行不用改，只有 B 重写。**

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

## 六、启动条件

`MAGPIE_MODEL` 没设就拒绝启动。厂商 key 和协议不在这个进程里检查。
