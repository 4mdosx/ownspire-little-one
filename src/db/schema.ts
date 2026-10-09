/**
 * SQLite 结构定义。
 *
 * 与 atlas / navi / raven 同一套约定：
 * -只创建**当前**结构，不做自动迁移。
 * - 旧表撞上就抛错（见 LEGACY_TABLES），让操作者显式决定。
 *
 * 理由在 raven 的 AGENTS.md 里已经写过一次，这里不重复：
 * **自动迁移的静默错误比停下来问更贵。**
 */

/**
 * ⚠️ **已知旧结构**：
 *
 * agent 建于 2026-10-08，同日 `toolCalls` 表的 UNIQUE 约束从 `(callId)`
 * 改成 `(sessionId, callId)` —— 见下面那张表的注释，那是修一个真实 bug。
 * 撞上这个形状说明库里是旧结构，而 `CREATE TABLE IF NOT EXISTS` **不会**改它，
 * 于是服务会起来、但继续犯那个 bug（症状：新会话工具历史凭空消失）。
 * 所以这里显式检测并拒绝启动。
 *
 * 迁移方式：删掉 data/agent.db 重来（库里只有会话与运行记录，丢了可接受），
 * 或 `ALTER TABLE toolCalls DROP INDEX idx_toolCalls_callId` 后重跑。
 */
export const LEGACY_TABLES: Record<string, string> = {}

/**
 * 表建好之后要额外检查的东西。
 *
 * `CREATE TABLE IF NOT EXISTS` 对**已存在的表不做任何事** —— 所以
 * 「schema.sql 改了」不等于「库里的表变了」。这些检查把那种沉默的
 * 不一致变成启动时的明确报错。
 */
export const LEGACY_INDEXES: Record<string, string> = {
  // 旧形状：只按 callId 去重。撞上它意味着新会话的调用会被记到旧会话名下。
  idx_toolCalls_callId:
    'toolCalls 的唯一约束是过时的（只按 callId）。删掉 data/agent.db 重跑，或先 DROP INDEX idx_toolCalls_callId。',
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  instructions TEXT,
  tools        TEXT NOT NULL,
  createdAt    INTEGER NOT NULL,
  updatedAt    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  sessionId  TEXT NOT NULL,
  status     TEXT NOT NULL,
  startedAt  INTEGER NOT NULL,
  endedAt    INTEGER,
  steps      INTEGER,
  usage      TEXT,
  code       TEXT,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(sessionId, startedAt DESC);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  runId     TEXT,
  role      TEXT NOT NULL,
  content   TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, id);

-- ⚠️ **工具调用必须落库，否则下一轮模型不记得自己调过什么。**
--
-- messages 只存 role + content，而工具调用与它的返回是**另一组消息**
-- （assistant 的 tool-call part + tool 的 result part）。
-- 不存它们的话，重建上下文时这些信息全丢——
-- 长任务必然跑不通：模型不知道上一步查到了什么，就会重复查或直接编。
--
-- 一行 = 一次工具调用。**一次 assistant 消息里可以有多个**（并行），
-- 所以这里没有 messageId 外键，靠 (sessionId, runId, seq) 保序。
--
-- ⚠️ **UNIQUE 必须在 (sessionId, callId) 上，不能只按 callId。**
-- callId 是 SDK 生成的短随机串，不同会话撞上同一个 id 是可能的
-- （用固定 id 的测试脚本必然撞）。只按 callId 去重时，冲突走 UPDATE 分支
-- 却不更新 sessionId —— 新会话的调用就被记到了旧会话名下，
-- 症状是「新的会话工具历史凭空消失」，无任何报错。
CREATE TABLE IF NOT EXISTS toolCalls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT NOT NULL,
  runId       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  callId      TEXT NOT NULL,
  tool        TEXT NOT NULL,
  input       TEXT NOT NULL,
  output      TEXT,
  ok          INTEGER,
  durationMs  INTEGER,
  -- 'pending' 执行前 · 'ok' / 'failed' / 'denied'
  status      TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  UNIQUE (sessionId, callId)
);

CREATE INDEX IF NOT EXISTS idx_toolCalls_session ON toolCalls(sessionId, id);

-- ---------------------------------------------------------------------------
-- 模型端点与模型清单
-- ---------------------------------------------------------------------------
--
-- ⚠️ **这里存的是「怎么连」，不是「连什么」。**
-- 具体某个会话用了哪个模型，记在 sessions 上。
-- 这几张表是**全局目录**：有哪些厂商、有哪些端点、有哪些模型可选。

-- 一个厂商。**key 属于厂商，不属于端点，也不属于协议。**
--
-- ⚠️ **没有 key 列。** 只存 keyEnvVar（环境变量名），key 本身永远不进库。
-- 理由：key 入库意味着它会出现在备份里，而备份是要被复制/上传的。
-- 环境变量名是「去哪里取」而不是「是什么」，泄露了不直接等于泄露凭据。
--
-- ⚠️ **注释里绝对不能出现反引号** —— 这整个文件是一个模板字符串，
-- 一个反引号就会提前结束它，而症状是「TS 报某个远行的语法错」，
-- 指向的位置和真正的原因差了十几行。
CREATE TABLE IF NOT EXISTS providers (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  -- key 所在的环境变量名，**不是 key 本身**。
  keyEnvVar        TEXT NOT NULL,
  -- 这个厂商端点的**默认**协议。单端点可在 endpoints.protocol 里覆盖。
  defaultProtocol TEXT NOT NULL,
  createdAt       INTEGER NOT NULL,
  updatedAt       INTEGER NOT NULL
);

-- 一个端点。属于某个厂商，走某种协议。
--
-- ⚠️ protocol 在这里而不只在 provider 上，因为**同一厂商的不同端点
-- 协议可能不同**：智谱的 /api/paas/v4 是 OpenAI Chat Completions，
-- 而 /api/anthropic 是 Anthropic Messages。留空则继承厂商默认。
--
-- ⚠️ **SQL 注释里不许出现反引号** —— SCHEMA_SQL 是模板字符串，
-- 一个反引号就把它切断，后面的内容被当成 JS 解析（/api/... 变成除法），
-- 报错位置离真正的原因很远。
CREATE TABLE IF NOT EXISTS endpoints (
  id         TEXT PRIMARY KEY,
  providerId TEXT NOT NULL REFERENCES providers(id),
  label      TEXT NOT NULL,
  protocol   TEXT,
  baseUrl    TEXT,
  -- 厂商扩展参数的 JSON（GLM 的 thinking / reasoning_effort 等）。
  extraBody  TEXT,
  -- false 时不列在 /api/models 里，但配置还在（临时停用某个端点）。
  enabled    INTEGER NOT NULL DEFAULT 1,
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);

-- 一个模型。
--
-- ⚠️ (endpointId, modelId) 唯一而不是 modelId 唯一 ——
-- 同一家厂商常有同名模型在不同端点上的情况，
-- 只按 modelId 去重会让「换个端点用同一个模型」存不进去。
CREATE TABLE IF NOT EXISTS models (
  id              TEXT NOT NULL,
  endpointId      TEXT NOT NULL REFERENCES endpoints(id),
  label           TEXT NOT NULL,
  -- low / high / max。GLM 默认是 max（最贵的一档），所以要显式记。
  reasoningEffort TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  createdAt       INTEGER NOT NULL,
  updatedAt       INTEGER NOT NULL,
  PRIMARY KEY (endpointId, id)
);

CREATE INDEX IF NOT EXISTS idx_models_endpoint ON models(endpointId, enabled);
`