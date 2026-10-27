/**
 * lib/tracker.js 的行为测试。
 *
 * 不依赖 DSH 运行时：用假的 ctx/client/queue/logger 加可控时钟，验证
 * 「什么算活动、什么时候发、失败怎么降级」这三件事。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createTracker } from '../lib/tracker.js'
import { createState } from '../lib/state.js'

const MIN_INTERVAL_SECONDS = 120

/**
 * 构造一组测试替身。
 * @param {object} [overrides]
 */
function harness(overrides = {}) {
  let clock = 1_700_000_000_000
  const heartbeats = []
  const queued = []
  const logs = []
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  let sendResult = { ok: true, status: 201, sent: 1 }
  let drainResult = { ok: true, status: 202, sent: 0 }
  let queueSize = 0
  const draincalls = []

  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    workingDirectory: {
      get() {
        return undefined
      },
    },
  }

  const client = {
    async sendBatch(batch) {
      heartbeats.push(...batch)
      return sendResult
    },
    async send(batch) {
      draincalls.push(batch.length)
      return drainResult
    },
  }

  const queue = {
    size: () => queueSize,
    async push(items) {
      queued.push(...items)
      queueSize += items.length
      return items.length
    },
    async drain(n) {
      const items = queued.slice(0, n)
      return items
    },
    async commit(n) {
      queued.splice(0, n)
      queueSize = queued.length
    },
    async drop(n) {
      queued.splice(0, n)
      queueSize = queued.length
    },
    async load() {},
  }

  const logger = {
    info: (message) => logs.push(`info:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
    error: (message) => logs.push(`error:${message}`),
    debug: (message) => logs.push(`debug:${message}`),
    lastError: () => undefined,
  }

  const state = createState({ now: () => clock })
  /** 本地账本的替身：记录每次 credit 的入参。 */
  const ledger = []
  const usage = {
    credit(input) {
      ledger.push(input)
      return 0
    },
  }

  const settings = {
    apiKey: 'test-key',
    apiUrl: 'https://example.invalid/api/v1',
    proxy: undefined,
    hostname: 'test-host',
    debug: true,
    enabled: true,
    minIntervalSeconds: MIN_INTERVAL_SECONDS,
    idleTimeoutMinutes: 15,
    entityType: 'file',
    category: 'ai coding',
    projectFromCwd: true,
    includeSubagentSessions: false,
    language: undefined,
    userAgent: 'dsh-plugin-wakatime-test',
    stateDir: 'C:\\tmp\\wakatime-test',
    cfgPath: 'C:\\Users\\test\\.wakatime.cfg',
    ...overrides.settings,
  }

  const tracker = createTracker({
    ctx,
    settings,
    client,
    queue,
    logger,
    state,
    usage,
    now: () => clock,
  })

  return {
    tracker,
    ctx,
    client,
    queue,
    logger,
    state,
    settings,
    listeners,
    heartbeats,
    queued,
    logs,
    ledger,
    draincalls,
    advance(ms) {
      clock += ms
    },
    now: () => clock,
    emit(session, type, data = {}, at = clock) {
      const handler = listeners.get('session/event')
      assert.ok(handler, 'session/event 监听器应当已注册')
      handler(session, { type, seq: 1, time: at, data, surfaceOp: 'append' })
    },
    setSendResult(result) {
      sendResult = result
    },
    setDrainResult(result) {
      drainResult = result
    },
  }
}

function session(id = 's1', cwd = 'D:\\Projects\\demo', header = {}) {
  return { id, header: { cwd, ...header } }
}

/** 等待 tracker 内部的 promise 链跑完（sendEntry 是 async 的）。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('用户消息累计 ai_prompt_length，模型消息累计 token', async () => {
  const h = harness()
  h.tracker.start()
  h.emit(session(), 'user/message', { role: 'user', content: [{ type: 'text', text: '帮我重构这段代码' }] })
  await settle()
  assert.equal(h.heartbeats.length, 1)
  assert.equal(h.heartbeats[0].ai_prompt_length, 8)
  assert.equal(h.heartbeats[0].ai_input_tokens, undefined)

  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.emit(session(), 'assistant/message', {
    message: { role: 'assistant' },
    usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
  })
  await settle()
  assert.equal(h.heartbeats.length, 2)
  assert.equal(h.heartbeats[1].ai_input_tokens, 1200)
  assert.equal(h.heartbeats[1].ai_output_tokens, 340)
  assert.equal(h.heartbeats[1].ai_prompt_length, undefined, '增量应当在发送后清零')
  h.tracker.stop()
})

test('心跳字段：entity 为会话目录、project 为目录名、category 为 ai coding', async () => {
  const h = harness()
  h.tracker.start()
  h.emit(session('s9', 'D:\\Projects\\Dynesshely\\dsh-plugin-wakatime'), 'turn/start', { turn: 1 })
  await settle()
  const hb = h.heartbeats[0]
  assert.equal(hb.entity, 'D:\\Projects\\Dynesshely\\dsh-plugin-wakatime')
  assert.equal(hb.project, 'dsh-plugin-wakatime')
  assert.equal(hb.category, 'ai coding')
  assert.equal(hb.type, 'file')
  assert.equal(hb.ai_session, 's9')
  assert.equal(typeof hb.time, 'number')
  assert.ok(hb.time > 1_600_000_000)
  h.tracker.stop()
})

test('最小间隔内不重复发送，跨间隔后发送', async () => {
  const h = harness()
  h.tracker.start()
  h.emit(session(), 'turn/start', { turn: 1 })
  await settle()
  assert.equal(h.heartbeats.length, 1)

  h.advance(30_000)
  h.emit(session(), 'tool/call', { name: 'read' })
  await settle()
  assert.equal(h.heartbeats.length, 1, '30s 内不应再发')

  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.emit(session(), 'tool/call', { name: 'edit' })
  await settle()
  assert.equal(h.heartbeats.length, 2, '超过最小间隔后应发送')
  h.tracker.stop()
})

test('长回合由 tick 保活；空闲超过 idleTimeout 后停止发送', async () => {
  const h = harness()
  h.tracker.start()
  h.emit(session(), 'turn/start', { turn: 1 })
  await settle()
  assert.equal(h.heartbeats.length, 1)

  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.tracker._tick()
  await settle()
  assert.equal(h.heartbeats.length, 2, '回合内 tick 应保活')

  h.emit(session(), 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.tracker._tick()
  await settle()
  assert.equal(h.heartbeats.length, 3, 'turn/end 后仍应冲刷最后一条增量')

  // 长时间无活动：tick 不再发送
  h.advance(60 * 60 * 1000)
  h.tracker._tick()
  await settle()
  assert.equal(h.heartbeats.length, 3, '空闲后不应继续计入')
  h.tracker.stop()
})

test('entityType=app 时 entity 使用应用名', async () => {
  const h = harness({ settings: { entityType: 'app' } })
  h.tracker.start()
  h.emit(session('s1', 'D:\\Projects\\demo'), 'turn/start', { turn: 1 })
  await settle()
  assert.equal(h.heartbeats.length, 1)
  assert.equal(h.heartbeats[0].entity, 'DeepSeek Harness')
  assert.equal(h.heartbeats[0].type, 'app')
  assert.equal(h.heartbeats[0].project, 'demo', '项目名仍取会话目录名')
  h.tracker.stop()
})

test('子代理会话默认忽略，可以配置计入', async () => {
  const ignored = harness()
  ignored.tracker.start()
  ignored.emit(session('sub1', 'D:\\p', { parentSession: 'parent' }), 'user/message', { content: 'hi' })
  await settle()
  assert.equal(ignored.heartbeats.length, 0)

  const counted = harness({ settings: { includeSubagentSessions: true } })
  counted.tracker.start()
  counted.emit(session('sub1', 'D:\\p', { origin: 'subagent' }), 'user/message', { content: 'hi' })
  await settle()
  assert.equal(counted.heartbeats.length, 1)
  ignored.tracker.stop()
  counted.tracker.stop()
})

test('没有工作目录的会话不发送也不抛错，并只告警一次', async () => {
  const h = harness()
  h.tracker.start()
  const bare = { id: 's-nocwd', header: {} }
  h.emit(bare, 'turn/start', { turn: 1 })
  await settle()
  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.emit(bare, 'tool/call', { name: 'read' })
  await settle()
  assert.equal(h.heartbeats.length, 0)
  assert.equal(h.logs.filter((line) => line.includes('没有可用的工作目录')).length, 1)
  h.tracker.stop()
})

test('可重试失败进入离线队列并退避', async () => {
  const h = harness()
  h.setSendResult({ ok: false, status: 500, sent: 0, retryable: true, retryAfterMs: 5_000 })
  h.tracker.start()
  h.emit(session(), 'turn/start', { turn: 1 })
  await settle()
  assert.equal(h.queued.length, 1, '失败的心跳应进队列')
  assert.equal(h.heartbeats.length, 1)

  // 退避期内不再发（5s 退避 + 120s 全局最小间隔，两者都未到）
  h.advance(1_000)
  h.emit(session(), 'tool/call', { name: 'read' })
  await settle()
  assert.equal(h.heartbeats.length, 1)

  // 超过最小间隔后退避结束、恢复发送
  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.emit(session(), 'tool/call', { name: 'read' })
  await settle()
  assert.equal(h.heartbeats.length, 2)
  h.tracker.stop()
})

test('401 后停止上报', async () => {
  const h = harness()
  h.setSendResult({ ok: false, status: 401, sent: 0, retryable: false, permanent: true, disabledReason: 'unauthorized' })
  h.tracker.start()
  h.emit(session(), 'turn/start', { turn: 1 })
  await settle()
  assert.equal(h.heartbeats.length, 1)

  h.advance(MIN_INTERVAL_SECONDS * 1000)
  h.emit(session(), 'tool/call', { name: 'read' })
  await settle()
  assert.equal(h.heartbeats.length, 1, '认证失败后不应继续发')
  assert.equal(h.tracker.status().disabledReason, 'unauthorized')
  h.tracker.stop()
})

test('tick 会排空离线队列并在成功后提交', async () => {
  const h = harness()
  h.tracker.start()
  await h.queue.push([{ entity: 'x', type: 'file', category: 'ai coding', time: 1 }])
  h.draincalls.length = 0
  h.advance(60_000)
  h.tracker._tick()
  await settle()
  await settle()
  assert.deepEqual(h.draincalls, [1])
  assert.equal(h.queue.size(), 0, '成功后应提交（出队）')
  assert.equal(h.tracker.status().queueSize, 0)
  h.tracker.stop()
})

test('未配置 apiKey：仍本地记账，但不发网络请求', async () => {
  const h = harness({ settings: { apiKey: undefined } })
  const stop = h.tracker.start()
  assert.equal(typeof stop, 'function')
  // 监听仍然注册：本地面板要有数据，只是没有上行目的地。
  assert.equal(h.listeners.has('session/event'), true)
  assert.equal(h.tracker.status().apiKeyConfigured, false)

  h.emit(session('s1', 'D:\\Projects\\demo'), 'turn/start', { turn: 1 })
  await settle()
  assert.equal(h.heartbeats.length, 0, '不应发起网络请求')
  assert.equal(h.ledger.length, 1, '本地账本应记录一次')
  assert.equal(h.ledger[0].project, 'demo')
  assert.equal(h.ledger[0].sessionId, 's1')
  assert.ok(h.logs.some((line) => line.includes('api_key')))
  h.tracker.stop()
})
