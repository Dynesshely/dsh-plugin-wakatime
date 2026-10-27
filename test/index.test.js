/**
 * index.js 装配冒烟测试。
 *
 * 覆盖「apply → 读 cfg → 建状态目录 → 起 tracker → 注册页面数据路由」这条链路：
 * 1. 有 api_key 时能装配、收到事件、API 不可达时把心跳写进离线队列，
 *    并且 `GET /wakatime/usage.json` 返回契约里的字段；
 * 2. 没有 api_key 时仍然本地记账（页面可用），但绝不发网络请求；
 * 3. 卸载（effect 的清理函数）能停掉监听、路由与账本。
 *
 * 全程不访问真实 WakaTime：apiUrl 指向本机未监听端口，cfg 放在临时目录。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** 轮询直到条件成立，超时抛错。 */
async function waitFor(check, { timeoutMs = 8_000, intervalMs = 25 } = {}) {
  const startedAt = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 构造一个临时 HOME，并把环境变量指过去。 */
async function makeHome({ apiKey } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wakatime-dsh-test-'))
  const dshHome = join(root, 'dsh-home')
  await mkdir(dshHome, { recursive: true })
  const cfgLines = ['[settings]']
  if (apiKey) cfgLines.push(`api_key = ${apiKey}`)
  cfgLines.push('debug = true')
  await writeFile(join(root, '.wakatime.cfg'), `${cfgLines.join('\n')}\n`, 'utf8')
  const previous = { DSH_HOME: process.env.DSH_HOME, WAKATIME_HOME: process.env.WAKATIME_HOME }
  process.env.DSH_HOME = dshHome
  process.env.WAKATIME_HOME = root
  return {
    root,
    stateDir: join(dshHome, 'cache', 'wakatime-dsh'),
    restore() {
      if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.DSH_HOME
      if (previous.WAKATIME_HOME === undefined) delete process.env.WAKATIME_HOME
      else process.env.WAKATIME_HOME = previous.WAKATIME_HOME
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** 最小的 Cordis Context 替身：监听器、effect 清理函数、webServer 路由表。 */
function fakeContext() {
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const cleanups = []
  /** @type {Array<{ route: any, disposed: boolean }>} */
  const routes = []
  const webServer = {
    register(route) {
      const entry = { route, disposed: false }
      routes.push(entry)
      return () => {
        entry.disposed = true
      }
    },
  }
  return {
    listeners,
    cleanups,
    routes,
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {
        for (const item of cleanups.splice(0)) item()
      }
    },
    // 与真实 Cordis 一致：未声明 inject 的插件只能通过 ctx.get(name) 可选访问服务。
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    workingDirectory: { get: () => undefined },
    webServer,
  }
}

/** 假的 HTTP 响应对象，够 route handler 用。 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    },
  }
}

const session = (cwd) => ({ id: 'session-smoke', header: { cwd } })

test('有 api_key：装配成功、失败入队、路由返回契约数据、卸载后停止一切', async () => {
  const home = await makeHome({ apiKey: 'dummy-key-for-smoke-test' })
  const ctx = fakeContext()
  const { apply } = await import('../index.js')
  try {
    apply(ctx, {
      // 指向本机未监听的端口：请求应立即失败，走「可重试 → 入队」分支；探针也会失败但不影响页面。
      apiUrl: 'http://127.0.0.1:9/api/v1',
      minIntervalSeconds: 10,
    })

    await waitFor(() => existsSync(join(home.stateDir, 'wakatime.log')))
    await waitFor(() => ctx.listeners.has('session/event'))
    const log = await readFile(join(home.stateDir, 'wakatime.log'), 'utf8')
    assert.match(log, /插件已装配/)
    assert.match(log, /apiKey=已配置/)
    assert.match(log, /\/wakatime\/usage\.json/)

    // 路由注册：exact + 固定路径。
    const route = ctx.routes.find((entry) => entry.route.path === '/wakatime/usage.json')
    assert.ok(route, '应注册 /wakatime/usage.json')
    assert.equal(route.route.kind, 'exact')

    // 触发一次活动：Client 连不上 → 心跳进离线队列，同时本地账本记账。
    ctx.listeners.get('session/event')(session(home.root), { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    const queueFile = join(home.stateDir, 'heartbeat-queue.json')
    await waitFor(() => existsSync(queueFile))
    const queue = JSON.parse(await readFile(queueFile, 'utf8'))
    assert.equal(queue.entries.length, 1, '应为 1 条待重发心跳')
    assert.equal(queue.entries[0].category, 'ai coding')

    // 页面数据。
    const response = fakeResponse()
    await route.route.handler({ method: 'GET' }, response)
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.equal(response.headers['cache-control'], 'no-store')
    const payload = JSON.parse(response.body)
    assert.equal(payload.plugin.version, '0.2.0')
    assert.equal(payload.plugin.category, 'ai coding')
    assert.equal(payload.local.today.heartbeats, 1)
    assert.equal(payload.local.days.length, 7)
    assert.equal(payload.wakatime.apiKeyConfigured, true)
    assert.equal(payload.wakatime.queueSize, 1)
    assert.ok(payload.wakatime.today, '无论探针成功与否都要有 today 段')

    // 非 GET 方法被拒绝。
    const rejected = fakeResponse()
    await route.route.handler({ method: 'POST' }, rejected)
    assert.equal(rejected.statusCode, 405)

    // 卸载：监听器、路由、账本全部收尾。
    for (const dispose of ctx.cleanups) dispose()
    assert.equal(ctx.listeners.has('session/event'), false)
    assert.equal(route.disposed, true, '卸载时应注销路由')
    const usageFile = join(home.stateDir, 'usage.json')
    await waitFor(() => existsSync(usageFile))
    const usage = JSON.parse(await readFile(usageFile, 'utf8'))
    assert.equal(usage.days.length, 1)
    assert.equal(usage.days[0].heartbeats, 1)
    for (const dispose of ctx.cleanups) dispose()
  } finally {
    home.restore()
    await home.cleanup()
  }
})

test('没有 api_key：仍然本地记账，但不注册网络发送', async () => {
  const home = await makeHome({})
  const ctx = fakeContext()
  const { apply } = await import('../index.js')
  try {
    apply(ctx, { apiUrl: 'http://127.0.0.1:9/api/v1' })
    await waitFor(() => existsSync(join(home.stateDir, 'wakatime.log')))
    await waitFor(() => ctx.listeners.has('session/event'))
    const log = await readFile(join(home.stateDir, 'wakatime.log'), 'utf8')
    assert.match(log, /api_key/)

    ctx.listeners.get('session/event')(session(home.root), { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    for (const dispose of ctx.cleanups) dispose()

    const usageFile = join(home.stateDir, 'usage.json')
    await waitFor(() => existsSync(usageFile))
    const usage = JSON.parse(await readFile(usageFile, 'utf8'))
    assert.equal(usage.days[0].heartbeats, 1)
    assert.equal(existsSync(join(home.stateDir, 'heartbeat-queue.json')), false, '没有 key 时不应产生待发队列')
  } finally {
    home.restore()
    await home.cleanup()
  }
})
