/**
 * WakaTime 侧「今日 AI Coding」只读探针（lib/wakatime-today.js）。
 *
 * 页面要显示「WakaTime 认为你今天 AI 编程了多久」。api_key 是写权限的，但读取自己账号的
 * 心跳在本机实测可用（见 docs/wakatime-api.md），所以这里直接读今天的原始心跳并按
 * WakaTime 的时长口径复算：相邻心跳间隔累加、单段封顶 idleTimeout。
 *
 * 结果缓存 ttlMs，失败也只缓存很短时间，避免页面刷新把 API 打爆。
 */
import { dayKey } from './usage.js'

/** 分类名在 API 返回里可能是 `AI Coding` 或 `ai coding`。 */
function isAiCoding(category) {
  return typeof category === 'string' && category.toLowerCase() === 'ai coding'
}

/**
 * @param {object} options
 * @param {string | undefined} options.apiKey
 * @param {string} options.apiUrl
 * @param {string} options.userAgent
 * @param {() => number} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.ttlMs]
 * @param {number} [options.idleTimeoutMinutes]
 * @param {{ warn: (message: string) => void }} [options.logger]
 */
export function createTodayProbe({
  apiKey,
  apiUrl,
  userAgent,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  ttlMs = 60_000,
  idleTimeoutMinutes = 15,
  logger,
} = {}) {
  const baseUrl = typeof apiUrl === 'string' && apiUrl !== '' ? apiUrl.replace(/\/+$/, '') : 'https://api.wakatime.com/api/v1'
  const maxGapSeconds = Math.max(1, idleTimeoutMinutes) * 60
  /** @type {{ fetchedAt: number, value: object } | undefined} */
  let cache
  let warned = false

  /**
   * 按 WakaTime 的时长口径求和。
   * @param {Array<{ time?: number, category?: string }>} heartbeats
   * @returns {{ categorySeconds: number, heartbeats: number }}
   */
  function sumAiCoding(heartbeats) {
    const times = heartbeats
      .filter((item) => item && isAiCoding(item.category) && typeof item.time === 'number' && Number.isFinite(item.time))
      .map((item) => item.time)
      .sort((a, b) => a - b)

    let seconds = 0
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index] - times[index - 1]
      if (gap > 0) seconds += Math.min(gap, maxGapSeconds)
    }
    return { categorySeconds: Math.round(seconds), heartbeats: times.length }
  }

  return {
    /**
     * @returns {Promise<{ categorySeconds: number, heartbeats: number, fetchedAt?: number, error: string | null }>}
     */
    async snapshot() {
      const at = now()
      if (cache && at - cache.fetchedAt < ttlMs) return cache.value

      if (!apiKey) {
        return { categorySeconds: 0, heartbeats: 0, error: 'api_key_not_configured' }
      }
      if (typeof fetchImpl !== 'function') {
        return { categorySeconds: 0, heartbeats: 0, error: 'fetch_unavailable' }
      }

      const url = `${baseUrl}/users/current/heartbeats?date=${dayKey(at)}`
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Basic ${Buffer.from(apiKey, 'utf8').toString('base64')}`,
            Accept: 'application/json',
            'User-Agent': userAgent ?? 'dsh-plugin-wakatime',
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response?.ok) {
          const status = Number(response?.status ?? 0)
          const value = { categorySeconds: cache?.value?.categorySeconds ?? 0, heartbeats: cache?.value?.heartbeats ?? 0, fetchedAt: at, error: `http_${status}` }
          // 失败只缓存 15 秒：既不打爆 API，也不会让页面长时间卡在错误值上。
          cache = { fetchedAt: at - ttlMs + 15_000, value }
          if (!warned && status !== 401) {
            warned = true
            logger?.warn?.(`读取 WakaTime 今日心跳失败：HTTP ${status}`)
          }
          return value
        }
        const payload = await response.json()
        const list = Array.isArray(payload?.data) ? payload.data : []
        const { categorySeconds, heartbeats } = sumAiCoding(list)
        const value = { categorySeconds, heartbeats, fetchedAt: at, error: null }
        cache = { fetchedAt: at, value }
        return value
      } catch (error) {
        const message = error?.name === 'TimeoutError' ? 'timeout' : String(error?.message ?? error)
        const value = { categorySeconds: cache?.value?.categorySeconds ?? 0, heartbeats: cache?.value?.heartbeats ?? 0, fetchedAt: at, error: message }
        cache = { fetchedAt: at - ttlMs + 15_000, value }
        if (!warned) {
          warned = true
          logger?.warn?.(`读取 WakaTime 今日心跳失败：${message}`)
        }
        return value
      }
    },
  }
}
