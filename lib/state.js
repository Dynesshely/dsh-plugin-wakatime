/**
 * 运行时状态：当日心跳计数、最近心跳时间、最近错误、跟踪中的会话数。
 *
 * 这些数字用于日志与 `status()` 输出，不参与上报逻辑，因此只保存在内存里。
 * 「当日」按本地时区的日历日切换，跨日时自动清零。
 */

/**
 * @param {object} [options]
 * @param {() => number} [options.now] 可注入时钟（测试用，毫秒）。
 */
export function createState({ now = Date.now } = {}) {
  let day = dayKey(now())
  let sentToday = 0
  let droppedToday = 0
  let lastHeartbeatAt
  let lastError
  let disabledReason
  const sessions = new Set()

  function dayKey(ms) {
    const date = new Date(ms)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const dayOfMonth = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${dayOfMonth}`
  }

  function rollDay() {
    const current = dayKey(now())
    if (current === day) return
    day = current
    sentToday = 0
    droppedToday = 0
  }

  return {
    /** 记录一次成功发送，返回落盘后的当日计数。 */
    noteSent(count = 1) {
      rollDay()
      sentToday += count
      lastHeartbeatAt = now()
      return sentToday
    },

    /** 记录一次被永久丢弃的心跳（如 400）。 */
    noteDropped(count = 1) {
      rollDay()
      droppedToday += count
    },

    /** 记录最近的错误文本（用于 status）。 */
    noteError(message) {
      lastError = message
    },

    /** 记录一次性禁用原因（如 unauthorized）。 */
    setDisabledReason(reason) {
      disabledReason = reason
    },

    /** 跟踪会话数变化。 */
    trackSession(sessionId) {
      sessions.add(String(sessionId))
    },

    untrackSession(sessionId) {
      sessions.delete(String(sessionId))
    },

    /** @returns {object} 供 `tracker.status()` 与日志使用的快照。 */
    snapshot() {
      rollDay()
      return {
        heartbeatsSentToday: sentToday,
        heartbeatsDroppedToday: droppedToday,
        lastHeartbeatAt,
        lastError,
        disabledReason,
        sessionsTracked: sessions.size,
      }
    },
  }
}
