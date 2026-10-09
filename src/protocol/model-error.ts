/**
 * 模型错误的规范化 —— **run.failed 的 code 从哪来，以及给用户看什么字**。
 *
 * ## 为什么要这一层
 *
 * 厂商的错误五花八门，而它们的**处置方式完全不同**：
 *
 * | 厂商返回 | 真正的处置 |
 * |---|---|
 * | 401 key 无效 | 去配置 key —— 重试一万次也是同一把废 key |
 * | 429 「余额不足或无可用资源包」 | 去充值 —— 等再久也没用 |
 * | 429 「rate limit exceeded」 | **等 30 秒就好** —— 重试是有效的 |
 * | 404 model 不存在 | 去改模型配置 |
 * | 5xx | 等一下重试 |
 *
 * 之前这些全被压成同一个 `model_error`，raven 只能把厂商原文显示给用户。
 * 而厂商原文既不稳定（`message` 随时会改），也不可执行 ——
 * 「余额不足或无可用资源包,请充值。」这句话里没有「该做什么」。
 *
 * ⚠️ **这一层不碰 SDK。** 它只吃一个扁平的事实对象 `{ statusCode, vendorCode, message }`，
 * 由 driver 从 SDK 错误的 cause 链里挖出来。理由是本地的一条分层纪律：
 * 协议层零 SDK 依赖（有机器检查），把`AI_APICallError` 引进协议层就破功了。
 */

/** 事实。**driver 负责从 SDK 错误里挖出这三个字段，其余一律不管。 */
export type ModelErrorFacts = {
  /** HTTP 状态码。没有就是 0（很多厂商的错误不带状态码）。 */
  statusCode: number
  /** 厂商自己的错误码，例如智谱的 `1113`、OpenAI 的 `insufficient_quota`。 */
  vendorCode?: string
  /** 错误自带的 code。已经被人分好类的错误要原样透传，见`classifyModelError`。 */
  existingCode?: string
  /** 厂商原文。只用于兜底展示与排查，不参与判定以外的逻辑。 */
  message: string
}

/**
 * 规范化的结果。
 *
 * `code` 属于契约（`run.failed` 的 code），`hint` 是给人看的可执行提示。
 * `retryable` 单独拎出来，是因为「能不能重试」这件事**不该由前端读文案猜** ——
 * 猜错的代价是用户看着一个永远转圈的进度条。
 */
export type ModelErrorCode =
  | 'model_auth_failed'
  | 'model_quota_exhausted'
  | 'model_rate_limited'
  | 'model_content_filtered'
  | 'model_not_found'
  | 'model_upstream_error'
  | 'model_error'
  | 'internal_error'
  /**
   * 透传的错误自带 code。
   *
   * ⚠️ 用 `(string & {})` 而不是收窄成 `never`：规范化层**允许透传未知 code**
   * （见`classifyModelError` 的兜底 ①），而 raven 的约定是「未知 code 走
   * default 分支」，所以透传是安全的。这个交集类型保留了上面那些字面量的
   * 编辑器补全，又不会在类型上把别的 code 挡掉。
   */
  | (string & {})

export type ModelError = {
  code: ModelErrorCode
  /** 直接进 `run.failed.error`，是厂商原文（含 request_id，便于查工单）。 */
  error: string
  /** 给用户的可执行提示。一句话，说清「现在该做什么」。 */
  hint: string
  /** 同样的请求再发一次有没有意义。 */
  retryable: boolean
}

/**
 * 判定顺序**不能换**。
 *
 * 顺序的依据是「特异性」：越具体的越先判，而后面的判据更宽。
 * 比如 `rate limit` 与 `quota` 在某些厂商的文案里会同时出现
 * （「quota exceeded, rate limited」），而这两件事要采取的行动不一样。
 * 所以先看**厂商码**（最结构化），再看**状态码**，最后才用文案兜底。
 */
export function classifyModelError(facts: ModelErrorFacts): ModelError {
  const { statusCode, vendorCode = '', message } = facts
  const text = message.toLowerCase()

  // ── 1. 欠费 / 余额不足 ────────────────────────────────────────
  // ⚠️ 必须在限流**之前**判：智谱把余额不足也报成 429（code 1113），
  //    而「rate limit」那个词在部分厂商的余额文案里也会出现。
  //    这两件事的行动完全相反 —— 一个要充值，一个要等待 —— 判错就是让用户干等。
  if (
    vendorCode === '1113' ||
    vendorCode === 'insufficient_quota' ||
    vendorCode === 'billing_hard_limit_reached' ||
    /余额不足|欠费|无可用资源包|insufficient[_ ]?(balance|quota)|billing|arrears?/i.test(text)
  ) {
    return {
      code: 'model_quota_exhausted',
      error: message,
      hint: '模型服务的余额不足或资源包已用尽，请充值后重试。这不是本机的问题，重试无用。',
      retryable: false,
    }
  }

  // ── 2. 凭据无效 ─────────────────────────────────────────────
  // ⚠️ 要排在限流**之后**吗？不 —— 401 只可能是凭据问题，没有歧义。
  //    但要排除一种情况：厂商把「模型不存在」也报成 401（OpenAI 偶尔这样），
  //    所以下面用 model_not_found 的判据把它接走。
  if (statusCode === 401 || vendorCode === 'invalid_api_key' || /api key|unauthorized|authentication|鉴权|认证失败/i.test(text)) {
    if (/model|模型/.test(text) && statusCode !== 401) {
      return { code: 'model_not_found', error: message, hint: '这个模型 id 在厂商那边不存在。', retryable: false }
    }
    return {
      code: 'model_auth_failed',
      error: message,
      hint: '模型服务的 API key 无效或未配置。请检查该厂商对应的密钥环境变量是否设置。',
      retryable: false,
    }
  }

  // ── 3. 限流：等一会就好，和上面两件事的行动相反 ──────────────
  if (
    statusCode === 429 ||
    vendorCode === 'rate_limit_exceeded' ||
    /rate limit|too many requests|请求过于频繁|限流|qps/i.test(text)
  ) {
    return {
      code: 'model_rate_limited',
      error: message,
      hint: '被厂商限流了。稍等几十秒重试通常就能过去。',
      retryable: true,
    }
  }

  // ── 4. 内容过滤 ─────────────────────────────────────────────
  if (statusCode === 400 && /content filter|内容审核|敏感|违规|safety|blocked/i.test(text)) {
    return {
      code: 'model_content_filtered',
      error: message,
      hint: '请求被厂商的内容过滤拦下了。换个说法再试。',
      retryable: false,
    }
  }

  // ── 5. 模型 / 端点不存在 ────────────────────────────────────
  if (
    statusCode === 404 ||
    vendorCode === 'model_not_found' ||
    /model .*(not found|does not exist|不存在)|模型.*不存在/i.test(text)
  ) {
    return {
      code: 'model_not_found',
      error: message,
      hint: '配置里的模型 id 或端点地址在厂商那边不存在。请检查模型目录。',
      retryable: false,
    }
  }

  // ── 6. 上游 5xx ─────────────────────────────────────────────
  if (statusCode >= 500) {
    return {
      code: 'model_upstream_error',
      error: message,
      hint: '模型服务自己出错了（上游 5xx）。这是厂商侧的问题，稍后重试。',
      retryable: true,
    }
  }

  // ── 7. 兜底 ─────────────────────────────────────────────────
  //
  // ⚠️ 三条兜底规则，按「谁的问题」分，顺序不能换：
  //
  // ① 错误自带 code 而我们认不出来 → **原样透传**。
  //   上游（SDK 或别的层）已经分好类的错误不该被这里改写：
  //   契约里 code 是 raven 的分支依据，篡改它等于把别的分类器的判断抹掉。
  //
  // ② 有 statusCode / vendorCode 却没命中任何规则 → `model_error`。
  //   它来自厂商，不是我方崩了。显示成「Runtime 崩了，请重试」会让用户去重启服务，
  //   而重启对这个错误毫无作用。
  //
  // ③ 什么都没有 → `internal_error`。**不认识就当自己这边的问题** ——
  //   这是更安全的默认：把厂商的怪错误说成「崩了」只会让人反复重启。
  if (facts.existingCode) {
    return {
      code: facts.existingCode,
      error: message,
      hint: '上游已分类的错误，原样透传。',
      retryable: false,
    }
  }
  if (statusCode >= 400 || vendorCode !== '') {
    return {
      code: 'model_error',
      error: message,
      hint: '模型服务返回了一个我们没归类的错误。下面是原文，可以据此排查。',
      retryable: false,
    }
  }
  return {
    code: 'internal_error',
    error: message,
    hint: 'Runtime 内部错误。可以重试，持续出现就该看日志。',
    retryable: true,
  }
}