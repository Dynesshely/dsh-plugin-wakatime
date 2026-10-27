/**
 * dsh-plugin-wakatime —— DSH Host 插件入口。
 *
 * 插件把「用户在 DeepSeek Harness 里用 AI 一起写代码」的时间，按 WakaTime 官方
 * 客户端插件的方式，以 `category: "ai coding"` 的 heartbeat 上报到 WakaTime API v1。
 *
 * 加载链路：cordis.patch.yml 插入 `wakatime` 行 → DSH 加载本文件 → 校验 Config →
 * 调用 `apply(ctx, config)`。`apply` 内部只做装配，不抛异常：任何初始化失败都退化成
 * 「插了但不做事」，绝不阻塞 DSH 启动。
 */
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

import { ensureStateDir, PLUGIN_VERSION, readWakaTimeConfig, resolveSettings } from './lib/cfg.js'
import { createClient } from './lib/client.js'
import { createLogger } from './lib/logger.js'
import { createQueue } from './lib/queue.js'
import { createReport } from './lib/report.js'
import { createState } from './lib/state.js'
import { createTracker } from './lib/tracker.js'
import { createUsageStore } from './lib/usage.js'
import { createTodayProbe } from './lib/wakatime-today.js'

/** 插件名，与 cordis.patch.yml 的行 id 保持一致。 */
export const name = 'wakatime'

/**
 * 插件配置（Settings 里可见）。
 *
 * 使用 DSH 自带的 `@deepseek-ai/schemastery` 声明，Plugin Manager 才能把配置
 * 投影成表单；zod 之类的通用 schema 库在这里会被判为 `unsupported`。
 *
 * 所有字段都有默认值，因此 patch 里的 `config: {}` 一定可以通过校验。空字符串
 * 表示「回退到 ~/.wakatime.cfg 或内置默认值」，所以覆盖项默认留空。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 WakaTime 上报。'),
  apiKey: Schema.string().default('').description('覆盖 ~/.wakatime.cfg 中的 api_key，留空则读配置文件。'),
  apiUrl: Schema.string().default('').description('WakaTime API 基地址，留空使用官方地址。'),
  proxy: Schema.string().default('').description('HTTP 代理，留空则沿用 ~/.wakatime.cfg 的 proxy。'),
  hostname: Schema.string().default('').description('上报的机器名，留空使用系统主机名。'),
  debug: Schema.boolean().default(false).description('写入更详细的诊断日志。'),
  minIntervalSeconds: Schema.number().min(10).max(900).default(120).description('两次心跳之间的最小间隔（秒）。'),
  idleTimeoutMinutes: Schema.number().min(1).max(240).default(15).description('超过该空闲分钟数视为离开，不再累计时间。'),
  entityType: Schema.union([Schema.const('file'), Schema.const('app')]).default('file').description('心跳 entity 的类型，file 表示用会话目录路径。'),
  category: Schema.string().default('ai coding').description('WakaTime 活动类别。'),
  projectFromCwd: Schema.boolean().default(true).description('用会话工作目录的目录名作为 WakaTime 项目名。'),
  includeSubagentSessions: Schema.boolean().default(false).description('是否把子代理会话也单独计时（可能与主会话重复计数）。'),
  language: Schema.string().default('').description('固定上报的语言名，留空则不上报。'),
  userAgent: Schema.string().default('').description('自定义 User-Agent，留空使用内置值。'),
})

/**
 * Host 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {Record<string, unknown>} [config] 经过 Config 校验后的行配置。
 */
export function apply(ctx, config = {}) {
  /** 插件是否已被卸载（异步装配期间可能先卸载）。 */
  let disposed = false
  /** `tracker.start()` 返回的清理函数。 */
  let stopTracker = () => {}

  const cleanup = () => {
    if (disposed) return
    disposed = true
    try {
      stopTracker()
    } catch {
      // 清理失败不向外抛。
    }
    stopTracker = () => {}
  }

  // 装配是异步的（要读 cfg 文件、建状态目录），但 Cordis 的 effect 是同步注册的：
  // 先返回清理函数，装配完成后再把真正的 stopTracker 填进去。
  ctx.effect(() => {
    disposed = false
    void bootstrap(ctx, config, () => disposed).then((stop) => {
      if (disposed) {
        try {
          stop()
        } catch {
          // 装配完成时插件已被卸载，直接丢弃。
        }
        return
      }
      stopTracker = stop
    })
    return cleanup
  })
}

/**
 * 真正的装配流程。任何异常都在这里被吞掉并写日志，保证插件本身不会拖垮宿主。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 * @param {() => boolean} isDisposed
 * @returns {Promise<() => void>}
 */
async function bootstrap(ctx, config, isDisposed) {
  let logger
  try {
    const file = await readWakaTimeConfig({})
    const settings = resolveSettings({ file, config })
    const stateDir = await ensureStateDir(settings.stateDir)
    logger = createLogger({ file: join(stateDir, 'wakatime.log'), debug: settings.debug })

    if (!file.found) {
      logger.warn(`未找到 ${file.path}（${file.error ?? 'not found'}）；请按 WakaTime 官方客户端的约定在其中配置 [settings] api_key。`)
    }
    if (isDisposed()) return () => {}

    const client = createClient({
      apiKey: settings.apiKey,
      apiUrl: settings.apiUrl,
      proxy: settings.proxy,
      hostname: settings.hostname,
      userAgent: settings.userAgent,
      logger,
    })
    const queue = createQueue({ file: join(stateDir, 'heartbeat-queue.json'), logger })
    const state = createState()
    const usage = createUsageStore({ file: join(stateDir, 'usage.json'), idleTimeoutMinutes: settings.idleTimeoutMinutes })
    const tracker = createTracker({ ctx, settings, client, queue, logger, state, usage })
    const probe = createTodayProbe({
      apiKey: settings.apiKey,
      apiUrl: settings.apiUrl,
      userAgent: settings.userAgent,
      idleTimeoutMinutes: settings.idleTimeoutMinutes,
      logger,
    })
    const report = createReport({ usage, probe, tracker, queue, settings, version: PLUGIN_VERSION })

    // 队列 / 账本加载失败都不影响实时上报：两者内部都已做损坏恢复。
    await queue.load().catch((error) => logger.warn(`离线队列加载失败：${String(error)}`))
    await usage.load().catch((error) => logger.warn(`本地统计加载失败：${String(error)}`))
    if (isDisposed()) return () => {}

    const stop = tracker.start()

    // 页面数据路由：只读、同源、每次现算（Cache-Control: no-store）。
    //
    // 注意：`ctx.webServer` 直接取会抛 `cannot get property "webServer" without inject`，
    // 未声明 inject 的插件只能用 `ctx.get('webServer')` 做可选访问（见 docs/harness-api.md）。
    let disposeRoute = () => {}
    try {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (webServer && typeof webServer.register === 'function') {
        disposeRoute = webServer.register({
          kind: 'exact',
          path: '/wakatime/usage.json',
          handler: async (request, response) => {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              response.statusCode = 405
              response.setHeader('Allow', 'GET, HEAD')
              response.end()
              return
            }
            try {
              const payload = await report.snapshot()
              const body = JSON.stringify(payload)
              response.statusCode = 200
              response.setHeader('Content-Type', 'application/json; charset=utf-8')
              response.setHeader('Cache-Control', 'no-store')
              response.setHeader('Content-Length', Buffer.byteLength(body))
              response.end(request.method === 'HEAD' ? undefined : body)
            } catch (error) {
              const body = JSON.stringify({ error: String(error) })
              response.statusCode = 500
              response.setHeader('Content-Type', 'application/json; charset=utf-8')
              response.end(body)
            }
          },
        })
        logger.info('页面数据路由已注册：GET /wakatime/usage.json')
      } else {
        logger.warn('未挂载 webServer 服务，跳过 /wakatime/usage.json 路由（页面会显示为不可用）。')
      }
    } catch (error) {
      logger.warn(`注册 /wakatime/usage.json 失败：${String(error)}`)
    }

    logger.info(
      `插件已装配：cfg=${file.path} stateDir=${stateDir} apiKey=${settings.apiKey ? '已配置' : '缺失'} queue=${queue.size()} debug=${settings.debug}`,
    )

    return () => {
      try {
        stop()
      } catch {
        // 继续清理其余资源。
      }
      try {
        disposeRoute()
      } catch {
        // 路由可能已被宿主回收。
      }
      void usage.dispose().catch(() => {})
    }
  } catch (error) {
    try {
      logger?.error(`插件装配失败：${error && error.stack ? error.stack : String(error)}`)
    } catch {
      // 日志都写不进去时只能放弃，插件保持 inert。
    }
    return () => {}
  }
}

// 便于测试与排查：把纯函数入口再导出一次，避免调用方深挖 lib/。
export { buildHeartbeat } from './lib/heartbeat.js'
export { parseIni, readWakaTimeConfig, resolveSettings } from './lib/cfg.js'
export { createTracker } from './lib/tracker.js'
export { createClient } from './lib/client.js'
export { createQueue } from './lib/queue.js'
export { createUsageStore, dayKey } from './lib/usage.js'
export { createReport } from './lib/report.js'
export { createTodayProbe } from './lib/wakatime-today.js'
