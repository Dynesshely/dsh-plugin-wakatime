/**
 * 本地使用统计（lib/usage.js）。
 *
 * 与「上报是否成功」无关：只要追踪器认为这一段时间在跟 AI 写代码，就记进本地账本，
 * 所以 WakaTime 没配 key、离线、或 401 的情况下，「使用时间」页面仍然有数据。
 *
 * 记账模型与 WakaTime 一致：两条相邻心跳之间的间隔算时长，超过 idleTimeout 的部分不计
 * （离开电脑的时间不会被算进去）。数据按本地日历日分桶，保留最近 30 天，原子写盘。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 保留天数。 */
export const KEEP_DAYS = 30
/** 页面上的项目榜单最多保留多少个。 */
export const MAX_PROJECTS = 20
/** 每个桶里记住的会话 id 上限，避免文件无限长。 */
const MAX_SESSIONS_PER_DAY = 50
/** 落盘防抖。 */
const PERSIST_DEBOUNCE_MS = 2_000

/**
 * 空桶。
 * @param {string} date `YYYY-MM-DD`
 */
function emptyDay(date) {
  return { date, seconds: 0, heartbeats: 0, inputTokens: 0, outputTokens: 0, promptChars: 0, sessions: [], projects: {} }
}

/**
 * 本地日期键（不用 UTC，跨天按用户所在时区切）。
 * @param {number} ms 毫秒时间戳
 * @returns {string} `YYYY-MM-DD`
 */
export function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 非负有限的整数化。
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.round(value)
}

/**
 * @param {object} options
 * @param {string} options.file          落盘路径。
 * @param {() => number} [options.now]   可注入时钟（测试用）。
 * @param {number} [options.idleTimeoutMinutes] 单次间隔计入的上限（分钟）。
 * @param {number} [options.keepDays]    保留天数。
 */
export function createUsageStore({
  file,
  now = Date.now,
  idleTimeoutMinutes = 15,
  keepDays = KEEP_DAYS,
} = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createUsageStore: file 必须是非空字符串')

  /** @type {Map<string, ReturnType<typeof emptyDay>>} */
  const days = new Map()
  /** 上一次记账的时间点（毫秒）；不落盘，重启后从 0 重新起算。 */
  let lastAt
  let persistTimer
  let writing = Promise.resolve()
  let dirty = false
  let lastError

  const maxGapMs = Math.max(1, idleTimeoutMinutes) * 60 * 1000

  function prune() {
    const cutoff = dayKey(now() - (keepDays - 1) * 24 * 60 * 60 * 1000)
    for (const key of days.keys()) {
      if (key < cutoff) days.delete(key)
    }
  }

  function bucket(ms) {
    const key = dayKey(ms)
    let day = days.get(key)
    if (!day) {
      day = emptyDay(key)
      days.set(key, day)
      prune()
    }
    return day
  }

  function serialize() {
    return JSON.stringify({
      version: 1,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    })
  }

  async function writeNow() {
    dirty = false
    const payload = serialize()
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      lastError = String(error)
      dirty = true
    }
  }

  function schedulePersist() {
    dirty = true
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      writing = writing.then(() => (dirty ? writeNow() : undefined)).catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  return {
    /** 从磁盘载入；损坏文件改名后从空账本开始，绝不抛错。 */
    async load() {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') lastError = String(error)
        return
      }
      try {
        const parsed = JSON.parse(text)
        const list = Array.isArray(parsed) ? parsed : parsed?.days
        if (!Array.isArray(list)) throw new Error('usage 文件结构不符')
        for (const item of list) {
          if (!item || typeof item.date !== 'string') continue
          const day = emptyDay(item.date)
          day.seconds = Number.isFinite(item.seconds) ? Math.max(0, item.seconds) : 0
          day.heartbeats = count(item.heartbeats)
          day.inputTokens = count(item.inputTokens)
          day.outputTokens = count(item.outputTokens)
          day.promptChars = count(item.promptChars)
          day.sessions = Array.isArray(item.sessions) ? item.sessions.filter((id) => typeof id === 'string').slice(0, MAX_SESSIONS_PER_DAY) : []
          day.projects = item.projects && typeof item.projects === 'object' ? item.projects : {}
          days.set(day.date, day)
        }
        prune()
      } catch {
        try {
          await rename(file, `${file}.corrupt-${Date.now()}`)
        } catch {
          // 改名失败也无所谓，内存里从空账本开始。
        }
      }
    },

    /**
     * 记录一次活动区间。
     *
     * @param {{ at?: number, project?: string, inputTokens?: number, outputTokens?: number, promptChars?: number, sessionId?: string }} input
     * @returns {number} 本次计入的秒数（未满 1 秒时为小数，快照里会取整）。
     */
    credit(input = {}) {
      const at = Number.isFinite(input.at) ? Number(input.at) : now()
      const day = bucket(at)
      let credited = 0
      if (Number.isFinite(lastAt) && at > lastAt) {
        credited = Math.min((at - lastAt) / 1000, maxGapMs / 1000)
        day.seconds += credited
      }
      lastAt = at
      day.heartbeats += 1
      day.inputTokens += count(input.inputTokens)
      day.outputTokens += count(input.outputTokens)
      day.promptChars += count(input.promptChars)

      const project = typeof input.project === 'string' && input.project !== '' ? input.project : undefined
      if (project) day.projects[project] = (day.projects[project] ?? 0) + credited

      const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined
      if (sessionId && !day.sessions.includes(sessionId)) {
        day.sessions.push(sessionId)
        if (day.sessions.length > MAX_SESSIONS_PER_DAY) day.sessions.shift()
      }

      schedulePersist()
      return credited
    },

    /** 页面快照。纯数据，可直接 JSON 化。 */
    snapshot() {
      const todayKey = dayKey(now())
      const today = days.get(todayKey) ?? emptyDay(todayKey)

      const weekDays = []
      let weekSeconds = 0
      for (let offset = 6; offset >= 0; offset -= 1) {
        const key = dayKey(now() - offset * 24 * 60 * 60 * 1000)
        const day = days.get(key)
        const seconds = Math.round(day?.seconds ?? 0)
        weekSeconds += seconds
        weekDays.push({ date: key, seconds, heartbeats: day?.heartbeats ?? 0 })
      }

      let totalSeconds = 0
      /** @type {Record<string, number>} */
      const projectTotals = {}
      for (const day of days.values()) {
        totalSeconds += day.seconds
        for (const [name, seconds] of Object.entries(day.projects)) {
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue
          projectTotals[name] = (projectTotals[name] ?? 0) + seconds
        }
      }

      const projects = Object.entries(projectTotals)
        .map(([name, seconds]) => ({ name, seconds: Math.round(seconds) }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 5)

      return {
        today: {
          date: todayKey,
          seconds: Math.round(today.seconds),
          heartbeats: today.heartbeats,
          inputTokens: today.inputTokens,
          outputTokens: today.outputTokens,
          promptChars: today.promptChars,
          sessions: today.sessions.length,
        },
        weekSeconds: Math.round(weekSeconds),
        totalSeconds: Math.round(totalSeconds),
        days: weekDays,
        projects,
        sessionsTracked: today.sessions.length,
        lastHeartbeatAt: Number.isFinite(lastAt) ? lastAt : undefined,
      }
    },

    /** 立刻落盘（测试与卸载时用）。 */
    async flush() {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = undefined
      }
      await writing
      if (dirty) await writeNow()
    },

    /** 卸载：停掉防抖并落盘。 */
    async dispose() {
      await this.flush()
    },

    /** 最近一次持久化错误（供诊断）。 */
    lastError() {
      return lastError
    },
  }
}
