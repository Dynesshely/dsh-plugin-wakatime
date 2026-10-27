/**
 * 页面数据装配（lib/report.js）。
 *
 * 把本地账本、追踪器状态、离线队列与 WakaTime 只读探针拼成 `/wakatime/usage.json`
 * 的响应体。这一层不碰网络以外的东西，字段契约见 docs/design.md 的 v0.2 一节。
 */

/**
 * @param {object} options
 * @param {object} options.usage     `createUsageStore()` 的返回值。
 * @param {object} options.probe     `createTodayProbe()` 的返回值。
 * @param {object} options.tracker   `createTracker()` 的返回值。
 * @param {object} options.queue     `createQueue()` 的返回值。
 * @param {object} options.settings  `resolveSettings()` 的输出。
 * @param {string} options.version   插件版本。
 * @param {() => number} [options.now]
 */
export function createReport({ usage, probe, tracker, queue, settings, version, now = Date.now }) {
  return {
    /** @returns {Promise<object>} 可直接 JSON 化的页面数据。 */
    async snapshot() {
      const local = usage.snapshot()
      const status = typeof tracker?.status === 'function' ? tracker.status() : {}
      const today = await probe.snapshot()

      return {
        generatedAt: now(),
        plugin: {
          version,
          enabled: Boolean(settings?.enabled),
          category: settings?.category ?? 'ai coding',
          minIntervalSeconds: settings?.minIntervalSeconds,
          idleTimeoutMinutes: settings?.idleTimeoutMinutes,
        },
        local: {
          ...local,
          sessionsTracked: status.sessionsTracked ?? local.sessionsTracked,
          queueSize: typeof queue?.size === 'function' ? queue.size() : 0,
        },
        wakatime: {
          apiKeyConfigured: Boolean(settings?.apiKey),
          hostname: settings?.hostname,
          queueSize: typeof queue?.size === 'function' ? queue.size() : 0,
          lastSentAt: status.lastHeartbeatAt ?? local.lastHeartbeatAt,
          lastError: status.lastError ?? usage.lastError?.() ?? null,
          disabledReason: status.disabledReason ?? null,
          today,
        },
      }
    },
  }
}
