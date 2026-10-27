/**
 * 追踪器：把 DSH 的 Session 活动翻译成 WakaTime heartbeat。
 *
 * 设计要点（详见 docs/design.md）：
 * - 只关心「用户在跟 AI 一起写代码」这件事本身：用户发消息、模型产出、工具调用、
 *   轮次开始/结束都算活动；子代理会话默认不单独计数，避免同一段墙钟时间被计两次。
 * - 全局节流：所有会话共用一个最小发送间隔，保证同一时刻只有一条 heartbeat，
 *   WakaTime 侧不会因为并行会话把时间口径撑大。
 * - 令牌与提示词字符数按「自上次成功发送以来的增量」累计，避免重复计入。
 * - 失败一律降级：可重试的进磁盘队列（带退避），永久失败丢弃并记录；
 *   401 之后停止发送，直到插件重新加载。
 */
import { basename } from 'node:path'
import { buildHeartbeat } from './heartbeat.js'

/** 定时器节奏：负责「长回合保活」与离线队列排空。 */
const TICK_MS = 15_000
/** 单会话超过该时长没有活动就从内存里移除（不影响已发送的数据）。 */
const EVICT_IDLE_MS = 6 * 60 * 60 * 1000
/** 队列一旦非空，重试退避的上限。 */
const MAX_QUEUE_BACKOFF_MS = 10 * 60 * 1000

/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx  Host 插件上下文。
 * @param {object} options.settings  `resolveSettings()` 的输出。
 * @param {object} options.client    `createClient()` 的返回值。
 * @param {object} options.queue     `createQueue()` 的返回值。
 * @param {object} options.logger    `createLogger()` 的返回值。
 * @param {object} options.state     `createState()` 的返回值。
 * @param {() => number} [options.now] 可注入时钟（测试用）。
 */
export function createTracker({ ctx, settings, client, queue, logger, state, now = Date.now }) {
  /** @type {Map<string, object>} sessionId -> 会话运行时状态 */
  const sessions = new Map()
  /** 全局最近一次成功发送/入队的时间，保证跨会话节流。 */
  let lastGlobalSendAt = 0
  /** 队列整体退避截止时间。 */
  let queueBackoffUntil = 0
  let timer
  let stopped = false
  let disposers = []
  let disabledReason
  const warned = new Set()

  const minIntervalMs = Math.max(10, settings.minIntervalSeconds ?? 120) * 1000
  const idleMs = Math.max(1, settings.idleTimeoutMinutes ?? 15) * 60 * 1000

  /** 警告只记一次，避免长会话刷爆日志。 */
  function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    logger.warn(message)
  }

  /** 事件时间统一到毫秒：DSH 用毫秒，但容忍秒级输入。 */
  function toMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return now()
    return value < 1e12 ? value * 1000 : value
  }

  /** 取会话工作目录：优先 header.cwd，其次 workingDirectory 服务。 */
  function sessionCwd(session) {
    const headerCwd = session?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd.length > 0) return headerCwd
    try {
      const resolved = ctx?.workingDirectory?.get?.(session)
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    } catch {
      // 服务未挂载或会话尚未绑定目录：交给下一轮再试。
    }
    return undefined
  }

  /** 子代理会话默认忽略（同一墙钟时间由根会话统一计数）。 */
  function isIgnoredSession(session) {
    if (settings.includeSubagentSessions) return false
    const header = session?.header
    if (!header) return false
    return Boolean(header.parentSession) || header.origin === 'subagent'
  }

  /** 统计一条用户消息里的可见字符数（不含工具调用参数）。 */
  function messageTextLength(data) {
    const message = data?.message ?? data
    const content = message?.content
    let total = 0
    if (typeof content === 'string') {
      total += content.length
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') total += block.length
        else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') total += block.text.length
      }
    }
    if (total === 0 && typeof message?.text === 'string') total = message.text.length
    return total
  }

  /** 非负整数归一化，避免 usage 里出现 undefined/NaN。 */
  function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
    return Math.round(value)
  }

  /** 取出或创建某个会话的运行时状态。 */
  function entryFor(session) {
    const id = String(session?.id ?? '')
    if (!id) return undefined
    let entry = sessions.get(id)
    if (entry) return entry
    const cwd = sessionCwd(session)
    entry = {
      id,
      session,
      cwd,
      pending: { inputTokens: 0, outputTokens: 0, promptLength: 0 },
      dirty: false,
      inTurn: false,
      lastActivityAt: 0,
      lastSentAt: 0,
      backoffUntil: 0,
      cwdWarned: false,
    }
    sessions.set(id, entry)
    state.trackSession(id)
    return entry
  }

  function resetPending(entry) {
    entry.pending.inputTokens = 0
    entry.pending.outputTokens = 0
    entry.pending.promptLength = 0
  }

  /** 构造并发送一条 heartbeat；所有失败路径都在内部消化。 */
  async function sendEntry(entry, at) {
    if (disabledReason) return
    const cwd = entry.cwd ?? sessionCwd(entry.session)
    if (!cwd) {
      if (!entry.cwdWarned) {
        entry.cwdWarned = true
        logger.warn(`会话 ${entry.id} 没有可用的工作目录，跳过上报；目录确定后会自动恢复。`)
      }
      return
    }
    entry.cwd = cwd
    entry.dirty = false
    const apiKey = settings.apiKey
    if (!apiKey) return

    const heartbeat = buildHeartbeat({
      time: now(),
      // type=file 时 entity 用项目目录（WakaTime 可据此识别项目），type=app 时用应用名。
      entity: settings.entityType === 'app' ? 'DeepSeek Harness' : cwd,
      type: settings.entityType === 'app' ? 'app' : 'file',
      category: settings.category || 'ai coding',
      project: settings.projectFromCwd ? basename(cwd) : undefined,
      language: settings.language,
      aiSession: entry.id,
      aiInputTokens: entry.pending.inputTokens,
      aiOutputTokens: entry.pending.outputTokens,
      aiPromptLength: entry.pending.promptLength,
    })

    let result
    try {
      result = await client.sendBatch([heartbeat])
    } catch (error) {
      result = { ok: false, status: 0, retryable: true, error: String(error) }
    }

    if (result?.ok) {
      resetPending(entry)
      lastGlobalSendAt = at
      entry.lastSentAt = at
      entry.backoffUntil = 0
      state.noteSent(1)
      logger.info(`heartbeat ok project=${basename(cwd)} session=${entry.id} tokens=${heartbeat.ai_input_tokens ?? 0}/${heartbeat.ai_output_tokens ?? 0} prompt=${heartbeat.ai_prompt_length ?? 0}`)
      return
    }

    const status = result?.status ?? 0
    const retryable = result?.retryable ?? (status === 0 || status === 429 || status >= 500)
    if (retryable && status !== 401) {
      resetPending(entry)
      try {
        await queue.push([heartbeat])
      } catch (error) {
        logger.warn(`离线队列写入失败：${String(error)}`)
      }
      const retryAfter = typeof result?.retryAfterMs === 'number' && result.retryAfterMs > 0 ? result.retryAfterMs : minIntervalMs
      entry.backoffUntil = at + retryAfter
      lastGlobalSendAt = at
      entry.lastSentAt = at
      logger.warn(`heartbeat 暂存待重发 status=${status || 'network'} retryAfterMs=${retryAfter}`)
      return
    }

    resetPending(entry)
    lastGlobalSendAt = at
    entry.lastSentAt = at
    state.noteDropped(1)
    state.noteError(`heartbeat 被永久拒绝 status=${status} ${result?.error ?? ''}`.trim())
    if (status === 401) {
      disabledReason = 'unauthorized'
      state.setDisabledReason('unauthorized')
      logger.error('WakaTime 认证失败（401）：api_key 无效或已失效，已停止上报。修正 ~/.wakatime.cfg 后重新加载插件。')
      return
    }
    logger.warn(`heartbeat 被永久拒绝并丢弃 status=${status}`)
  }

  /** 满足条件时发送；节流与退避都在这里判断。 */
  function maybeSend(entry, at) {
    if (stopped || disabledReason) return
    if (!settings.enabled) return
    if (!entry.dirty) return
    if (at < entry.backoffUntil) return
    if (at - lastGlobalSendAt < minIntervalMs) return
    void sendEntry(entry, at)
  }

  /** 排空离线队列；与实时心跳基本互斥，避免同一时刻刷两条。 */
  async function drainQueue(at) {
    if (stopped || disabledReason || !settings.enabled) return
    if (at < queueBackoffUntil) return
    if (queue.size() === 0) return
    if (at - lastGlobalSendAt < Math.min(minIntervalMs, 5_000)) return

    let pending
    try {
      pending = await queue.drain(25)
    } catch (error) {
      logger.warn(`离线队列读取失败：${String(error)}`)
      return
    }
    if (!pending || pending.length === 0) return

    let result
    try {
      result = await client.send(pending)
    } catch (error) {
      result = { ok: false, status: 0, retryable: true, error: String(error) }
    }

    if (result?.ok) {
      await queue.commit(pending.length)
      lastGlobalSendAt = at
      state.noteSent(pending.length)
      logger.info(`离线队列补发 ${pending.length} 条成功`)
      return
    }

    const status = result?.status ?? 0
    const retryable = result?.retryable ?? (status === 0 || status === 429 || status >= 500)
    if (retryable && status !== 401) {
      const retryAfter = typeof result?.retryAfterMs === 'number' && result.retryAfterMs > 0 ? result.retryAfterMs : 60_000
      queueBackoffUntil = at + Math.min(retryAfter, MAX_QUEUE_BACKOFF_MS)
      logger.warn(`离线队列补发失败 status=${status || 'network'}，${Math.round(Math.min(retryAfter, MAX_QUEUE_BACKOFF_MS) / 1000)}s 后重试`)
      return
    }

    await queue.drop(pending.length)
    state.noteDropped(pending.length)
    state.noteError(`离线队列被永久拒绝 status=${status}`)
    if (status === 401) {
      disabledReason = 'unauthorized'
      state.setDisabledReason('unauthorized')
      logger.error('WakaTime 认证失败（401）：已停止上报。')
    }
  }

  /** 单个 Session 事件的入口。 */
  function onSessionEvent(session, event) {
    if (stopped || !event || typeof event.type !== 'string') return
    if (isIgnoredSession(session)) return
    const entry = entryFor(session)
    if (!entry) return
    const at = toMs(event.time)

    switch (event.type) {
      case 'user/message': {
        entry.pending.promptLength += messageTextLength(event.data)
        entry.dirty = true
        break
      }
      case 'assistant/message': {
        const usage = event.data?.usage
        if (usage) {
          entry.pending.inputTokens += positiveInteger(usage.inputTokens)
          entry.pending.outputTokens += positiveInteger(usage.outputTokens)
        }
        entry.dirty = true
        break
      }
      case 'tool/call':
      case 'tool/result':
      case 'step/start':
      case 'step/end':
        entry.dirty = true
        break
      case 'turn/start':
        entry.inTurn = true
        entry.dirty = true
        break
      case 'turn/end':
        entry.inTurn = false
        entry.dirty = true
        break
      default:
        return
    }

    entry.lastActivityAt = at
    maybeSend(entry, at)
  }

  function onSessionDisposed(session) {
    const id = String(session?.id ?? '')
    if (!id) return
    sessions.delete(id)
    state.untrackSession(id)
  }

  /** 定时任务：长回合保活、空闲回收、离线队列排空。 */
  function tick() {
    if (stopped) return
    const at = now()
    void drainQueue(at)

    for (const [id, entry] of sessions) {
      const idleFor = at - entry.lastActivityAt
      if (idleFor <= idleMs) {
        // 长回合里模型可能十几分钟只产出不说话：只要还在回合中就算「AI 仍在工作」，
        // 用 tick 保持心跳，避免 WakaTime 侧出现超过 keystroke timeout 的空档。
        if (entry.inTurn) entry.dirty = true
        maybeSend(entry, at)
        continue
      }
      // 刚过空闲阈值：把最后一次增量补发出去，然后停止；之后不再累计，直到出现新活动。
      if (entry.pending.inputTokens || entry.pending.outputTokens || entry.pending.promptLength) {
        entry.dirty = true
        if (at >= entry.backoffUntil) void sendEntry(entry, at)
      }
      entry.inTurn = false
      entry.dirty = false
      if (at - Math.max(entry.lastActivityAt, entry.lastSentAt) > EVICT_IDLE_MS) {
        sessions.delete(id)
        state.untrackSession(id)
      }
    }
  }

  function start() {
    if (typeof ctx?.on !== 'function') {
      logger.error('插件上下文中没有事件系统（ctx.on），WakaTime 追踪未启动。')
      return () => {}
    }
    if (!settings.apiKey) {
      logger.warn(`未在 ${settings.cfgPath ?? '~/.wakatime.cfg'} 找到 [settings] api_key，WakaTime 上报处于惰性状态。`)
      return () => {}
    }
    if (!settings.enabled) {
      logger.info('WakaTime 上报已在配置中禁用（enabled=false）。')
      return () => {}
    }

    const register = (name, handler) => {
      try {
        const dispose = ctx.on(name, handler)
        if (typeof dispose === 'function') disposers.push(dispose)
        return true
      } catch (error) {
        logger.warn(`注册 ${name} 监听失败：${String(error)}`)
        return false
      }
    }

    register('session/event', onSessionEvent)
    register('session/disposed', onSessionDisposed)
    timer = setInterval(tick, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    logger.info(`WakaTime 上报已启动：间隔 ${Math.round(minIntervalMs / 1000)}s，空闲 ${Math.round(idleMs / 60000)}min，子代理会话${settings.includeSubagentSessions ? '计入' : '不计入'}`)

    return () => stop()
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 清理失败不影响卸载。
      }
    }
    disposers = []
    sessions.clear()
  }

  return {
    start,
    stop,
    /** 供 index.js 暴露诊断信息。 */
    status() {
      return {
        enabled: settings.enabled,
        apiKeyConfigured: Boolean(settings.apiKey),
        minIntervalSeconds: settings.minIntervalSeconds,
        idleTimeoutMinutes: settings.idleTimeoutMinutes,
        entityType: settings.entityType,
        category: settings.category,
        subagentsCounted: settings.includeSubagentSessions,
        queueSize: queue.size(),
        ...state.snapshot(),
      }
    },
    /** 仅测试使用：直接注入事件，不依赖 ctx。 */
    _onSessionEvent: onSessionEvent,
    _tick: tick,
  }
}
