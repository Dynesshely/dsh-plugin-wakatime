/**
 * index.js 装配冒烟测试。
 *
 * 覆盖「apply → 读 cfg → 建状态目录 → 起 tracker」这条链路，并验证：
 * 1. 没有 api_key 时插件保持 inert，不注册监听、不发请求；
 * 2. 有 api_key 时能装配、收到事件、在 API 不可达时把心跳写进离线队列；
 * 3. 卸载（effect 的清理函数）能停掉定时器与监听。
 *
 * 全程不访问真实 WakaTime：apiUrl 指向本机未监听端口，cfg 放在临时目录。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** 轮询直到条件成立，超时抛错。 */
async function waitFor(check, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
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

/** 最小的 Cordis Context 替身：记录监听器与 effect 清理函数。 */
function fakeContext() {
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const cleanups = []
  return {
    listeners,
    cleanups,
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
    workingDirectory: { get: () => undefined },
  }
}

const session = (cwd) => ({ id: 'session-smoke', header: { cwd } })

test('有 api_key：装配成功，事件降级写进离线队列，卸载后不再监听', async () => {
  const home = await makeHome({ apiKey: 'dummy-key-for-smoke-test' })
  const ctx = fakeContext()
  const { apply } = await import('../index.js')
  try {
    apply(ctx, {
      // 指向本机未监听的端口：请求应立即失败，走「可重试 → 入队」分支。
      apiUrl: 'http://127.0.0.1:9/api/v1',
      minIntervalSeconds: 10,
    })

    await waitFor(() => existsSync(join(home.stateDir, 'wakatime.log')))
    await waitFor(() => ctx.listeners.has('session/event'))
    const log = await readFile(join(home.stateDir, 'wakatime.log'), 'utf8')
    assert.match(log, /插件已装配/)
    assert.match(log, /apiKey=已配置/)

    // 触发一次活动：Client 连不上 → 心跳应进入离线队列。
    ctx.listeners.get('session/event')(session(home.root), { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    const queueFile = join(home.stateDir, 'heartbeat-queue.json')
    await waitFor(() => existsSync(queueFile))
    const queue = JSON.parse(await readFile(queueFile, 'utf8'))
    assert.ok(Array.isArray(queue.entries) && queue.entries.length === 1, '应为 1 条待重发心跳')
    assert.equal(queue.entries[0].category, 'ai coding')
    assert.equal(queue.entries[0].entity, home.root)
    assert.equal(queue.entries[0].ai_session, 'session-smoke')

    // 卸载：监听器被移除，effect 清理函数可安全重复调用。
    for (const dispose of ctx.cleanups) dispose()
    assert.equal(ctx.listeners.has('session/event'), false)
    for (const dispose of ctx.cleanups) dispose()
  } finally {
    home.restore()
    await home.cleanup()
  }
})

test('没有 api_key：插件 inert，不注册监听，只写一条告警', async () => {
  const home = await makeHome({})
  const ctx = fakeContext()
  const { apply } = await import('../index.js')
  try {
    apply(ctx, {})
    await waitFor(() => existsSync(join(home.stateDir, 'wakatime.log')))
    const log = await readFile(join(home.stateDir, 'wakatime.log'), 'utf8')
    assert.match(log, /api_key/)
    assert.equal(ctx.listeners.size, 0, '未配置 api_key 时不应注册事件监听')
    for (const dispose of ctx.cleanups) dispose()
  } finally {
    home.restore()
    await home.cleanup()
  }
})
