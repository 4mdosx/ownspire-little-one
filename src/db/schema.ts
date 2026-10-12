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

/**
 * **已删除、但旧库里还在的列。** 启动时自动 `DROP COLUMN`，失败则拒绝启动。
 *
 * ⚠️ **与 `MIGRATABLE_COLUMNS` 的方向相反**：那边是加列（`ADD COLUMN` 纯加法），
 * 这边是删列。直觉上删列更危险，所以第一版这里写的是「拒绝启动，请删库重建」。
 *
 * 实测推翻了那个判断（2026-10-09，在真有数据的库上验过）：
 * SQLite 3.35+ 的 `ALTER TABLE ... DROP COLUMN` 在这张表上**不重建表、不丢数据** ——
 * 3 个端点、3 个会话、`foreign_key_check` 空、`integrity_check` 全过。
 * 所以「删列一定要搬数据、搬错了是静默损坏」这个顾虑在**本例**里不成立，
 * 让用户删库重建 3 个会话才是真实的代价。
 *
 * ⚠️ 但**不**无条件自动：`DROP COLUMN` 在该列被索引或外键引用时会失败。
 * 那种情况不重试、不绕过 —— 直接抛出去让人看一眼，因为那说明有本文件
 * 不知道的依赖，而「绕过它」正是静默损坏的起点。
 */
export const DROPPABLE_COLUMNS: Array<{ table: string; column: string; reason: string }> = [
  {
    table: 'sessions',
    column: 'endpointId',
    reason: '会话不再固定端点。出站地址是 Magpie，不在会话上。',
  },
  {
    table: 'sessions',
    column: 'modelId',
    reason: '会话不再选择模型。模型名是部署参数 MAGPIE_MODEL。',
  },
]

/**
 * **可以自动迁移**的列缺失。
 *
 * ⚠️ 为什么这跟 `LEGACY_TABLES` 分成两档：
 *
 * - 撞上**旧表结构**（少了一列、约束过时）→ 拒绝启动，让人显式迁移。
 *   因为那意味着要对数据动手术，而「自动搬」很容易搬错。
 * - 撞上**缺一列**（`ALTER TABLE ADD COLUMN` 能安全补上）→ 直接补。
 *   ADD COLUMN 是纯加法：不改已有行、不动索引、不会失败。
 *
 * 分档的依据只有一条：**这个变更能不能在不解释数据的前提下做完。**
 * 能 → 自动；不能 → 停下来问。
 *
 * ⚠️ 为什么必须显式列在这里：`CREATE TABLE IF NOT EXISTS` 对**已存在的表**
 * 不做任何事，所以改了 SCHEMA_SQL 之后旧库不会跟着变 —— 而服务照样起来，
 * 于是所有读 apiKey 的代码都拿到 undefined。这类沉默的不一致最难查。
 */
export const MIGRATABLE_COLUMNS: Array<{ table: string; column: string; ddl: string; reason: string }> = [
  {
    table: 'runs',
    column: 'parentRunId',
    ddl: 'ALTER TABLE runs ADD COLUMN parentRunId TEXT',
    reason: '预留列（2026-10-09）：run 的血缘。当前无写入方，先让旧库补上这一列。',
  },
  {
    table: 'sessions',
    column: 'engine',
    ddl: "ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'little-one'",
    reason: '多引擎（2026-10-09）：little-one / claude。缺省即 little-one，旧行语义不变。',
  },
  {
    table: 'sessions',
    column: 'engineSessionId',
    ddl: 'ALTER TABLE sessions ADD COLUMN engineSessionId TEXT',
    reason: 'claude 引擎的会话锚（2026-10-09）。当前无写入方，先补列。',
  },
  {
    table: 'sessions',
    column: 'sandboxApproval',
    ddl: 'ALTER TABLE sessions ADD COLUMN sandboxApproval INTEGER NOT NULL DEFAULT 0',
    reason: '双审批开关（2026-10-09，契约 §五）：沙箱内工具，默认自动通过。',
  },
  {
    table: 'sessions',
    column: 'businessApproval',
    ddl: 'ALTER TABLE sessions ADD COLUMN businessApproval INTEGER NOT NULL DEFAULT 1',
    reason: '双审批开关（2026-10-09，契约 §五）：业务工具，默认需要审批。',
  },
]

/**
 * 持久化结构的版本号。**这不是对外契约**（对外契约只有 docs/01-contract.md），
 * 但受内部演进政策约束（契约 §一「持久化演进政策」一节）：
 *
 * - 老库必须永远能被新代码打开 —— 线上会有跨版本 resume。
 * - 只增不删：加表、加列直接做（配合 MIGRATABLE_COLUMNS）；改列名/改类型/删列
 *   必须在这里升版本号，并写迁移步骤。
 * - `_meta.schemaVersion` 记的是「这行数据是哪个结构写出来的」，让下一次
 *   改结构的人有地方下钉子，而不是靠 git log 考古。
 */
export const SCHEMA_VERSION = 2

/**
 * 已经不再使用的表。启动时 `DROP TABLE`。
 * 顺序：先子表。SQLite 默认不强制外键，但按依赖倒序删，迁移日志也好读。
 */
export const DROPPABLE_TABLES: Array<{ table: string; reason: string }> = [
  {
    table: 'models',
    reason: '模型选择交给 Magpie。little-one 不再保存模型清单。',
  },
  {
    table: 'endpoints',
    reason: '协议与厂商地址交给 Magpie。little-one 只说一套 Chat Completions。',
  },
  {
    table: 'providers',
    reason: '厂商 key 交给 Magpie。little-one 的库里不再存 key。',
  },
]

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  instructions TEXT,
  tools        TEXT NOT NULL,
  createdAt    INTEGER NOT NULL,
  updatedAt    INTEGER NOT NULL,
  -- 引擎（2026-10-09）。'little-one' 自研 loop / 'claude' 委托 claude-cli。
  -- 老库迁移见 MIGRATABLE_COLUMNS；缺省即 little-one。
  engine       TEXT NOT NULL DEFAULT 'little-one',
  -- claude 引擎的会话锚：claude 侧 session id，resume 靠它。
  engineSessionId TEXT,
  -- 双审批开关（2026-10-09，契约 §五）。1 = 需要审批。
  -- 沙箱内工具默认 0（自动通过，脱手定位），业务工具默认 1（治理核心）。
  sandboxApproval  INTEGER NOT NULL DEFAULT 0,
  businessApproval INTEGER NOT NULL DEFAULT 1
);

-- 事件日志（2026-10-09）。**事件流从此是事实源**：断线重连靠它回放，
-- 审计靠它留痕。一次 run 的事件在流关闭后仍然可读。
-- seq 是 run 内单调递增，SSE 的 id: 行带它，重连用 after=seq 续传。
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  runId     TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  name      TEXT NOT NULL,
  data      TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE (runId, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_run ON events(runId, seq);

-- token 账本（2026-10-09，契约 §六）。**全程不出现钱** —— 定价随厂商与时间变，
-- 而 token 数是厂商无关的记账单位。一行 = 一次 run 的用量，按厂商/模型可分组。
CREATE TABLE IF NOT EXISTS usageLedger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  runId        TEXT NOT NULL,
  sessionId    TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  inputTokens  INTEGER NOT NULL,
  outputTokens INTEGER NOT NULL,
  createdAt    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_model ON usageLedger(provider, model);
CREATE INDEX IF NOT EXISTS idx_ledger_session ON usageLedger(sessionId);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  sessionId  TEXT NOT NULL,
  status     TEXT NOT NULL,
  startedAt  INTEGER NOT NULL,
  endedAt    INTEGER,
  steps      INTEGER,
  usage      TEXT,
  code       TEXT,
  error      TEXT,
  -- 预留（2026-10-09，暂无写入方）：这一轮是从哪一轮续出来的。
  -- OpenHands 的 Event.parent_id 从第一天就存在，后来对话树、分支、恢复全靠它。
  -- 现在加一列是零成本；等想要「从哪断的」时再补，就只能靠时间戳猜。
  parentRunId TEXT
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
`