/**
 * lib/usage.js 的本地账本测试。
 *
 * 覆盖：间隔计费与 idleTimeout 封顶、token/字符/会话/项目归属、跨天分桶、
 * 7 天柱状数据、项目 Top5、落盘与损坏恢复。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createUsageStore, dayKey, KEEP_DAYS } from '../lib/usage.js'

/** 固定时钟：2026-10-27 12:00 本地时间。 */
const BASE = new Date(2026, 9, 27, 12, 0, 0).getTime() // 注意 JS 月份从 0 开始
const MINUTE = 60_000

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'wakatime-usage-'))
  return { dir, file: join(dir, 'usage.json'), async cleanup() { await rm(dir, { recursive: true, force: true }) } }
}

test('间隔计费：相邻心跳差计入，单段超过 idleTimeout 被截断', async () => {
  const tmp = await tempFile()
  let clock = BASE
  const store = createUsageStore({ file: tmp.file, now: () => clock, idleTimeoutMinutes: 15 })
  try {
    await store.load()
    assert.equal(store.credit({ at: clock, project: 'alpha' }), 0, '首条没有前一条，计 0')
    clock += 90_000
    assert.equal(store.credit({ at: clock, project: 'alpha' }), 90, '90 秒真实间隔')
    clock += 60 * 60 * 1000
    assert.equal(store.credit({ at: clock, project: 'alpha' }), 900, '超过 15 分钟的间隔封顶')
    const snap = store.snapshot()
    assert.equal(snap.today.seconds, 990)
    assert.equal(snap.today.heartbeats, 3)
    assert.equal(snap.today.projects ?? undefined, undefined)
    assert.deepEqual(snap.projects, [{ name: 'alpha', seconds: 990 }])
  } finally {
    await tmp.cleanup()
  }
})

test('token / 字符 / 会话按天累计，跨天开新桶', async () => {
  const tmp = await tempFile()
  let clock = BASE
  const store = createUsageStore({ file: tmp.file, now: () => clock })
  try {
    await store.load()
    store.credit({ at: clock, project: 'alpha', inputTokens: 100, outputTokens: 40, promptChars: 12, sessionId: 's1' })
    clock += 60_000
    store.credit({ at: clock, project: 'alpha', inputTokens: 50, outputTokens: 10, promptChars: 8, sessionId: 's2' })
    const today = store.snapshot().today
    assert.equal(today.inputTokens, 150)
    assert.equal(today.outputTokens, 50)
    assert.equal(today.promptChars, 20)
    assert.equal(today.sessions, 2)

    // 第二天
    clock = new Date(2026, 9, 28, 9, 0, 0).getTime()
    store.credit({ at: clock, project: 'beta', inputTokens: 7, sessionId: 's3' })
    const snap = store.snapshot()
    assert.equal(snap.today.date, '2026-10-28')
    assert.equal(snap.today.inputTokens, 7)
    assert.equal(snap.days.length, 7)
    assert.equal(snap.days.at(-1).date, '2026-10-28')
    assert.equal(snap.days.at(-2).seconds, 60, '前一天应保留 60 秒')
  } finally {
    await tmp.cleanup()
  }
})

test('项目 Top5 按累计时长排序', async () => {
  const tmp = await tempFile()
  let clock = BASE
  const store = createUsageStore({ file: tmp.file, now: () => clock })
  try {
    await store.load()
    const projects = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    // 每条间隔 1 分钟，项目轮流：后出现的项目累计更少
    for (let index = 0; index < 12; index += 1) {
      clock += MINUTE
      store.credit({ at: clock, project: projects[index % projects.length] })
    }
    const snap = store.snapshot()
    assert.ok(snap.projects.length <= 5)
    const seconds = snap.projects.map((item) => item.seconds)
    assert.deepEqual([...seconds].sort((a, b) => b - a), seconds, '应按降序')
  } finally {
    await tmp.cleanup()
  }
})

test('落盘后重新载入保持数据；损坏文件改名后从空账本开始', async () => {
  const tmp = await tempFile()
  let clock = BASE
  const store = createUsageStore({ file: tmp.file, now: () => clock })
  try {
    await store.load()
    clock += MINUTE
    store.credit({ at: clock, project: 'alpha', inputTokens: 9, sessionId: 's1' })
    await store.flush()

    const raw = JSON.parse(await readFile(tmp.file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.days.length, 1)
    assert.equal(raw.days[0].inputTokens, 9)

    const reloaded = createUsageStore({ file: tmp.file, now: () => clock })
    await reloaded.load()
    const snap = reloaded.snapshot()
    assert.equal(snap.today.inputTokens, 9)
    assert.equal(snap.today.seconds, 0, '间隔不跨进程恢复，避免把停机时间算进去')

    await writeFile(tmp.file, '{ not json', 'utf8')
    const broken = createUsageStore({ file: tmp.file, now: () => clock })
    await broken.load()
    assert.equal(broken.snapshot().today.seconds, 0)
  } finally {
    await tmp.cleanup()
  }
})

test('超过保留天数的旧桶被裁掉', async () => {
  const tmp = await tempFile()
  let clock = BASE
  const store = createUsageStore({ file: tmp.file, now: () => clock, keepDays: 3 })
  try {
    await store.load()
    const old = BASE - 10 * 24 * 60 * MINUTE
    await writeFile(
      tmp.file,
      JSON.stringify({
        version: 1,
        days: [
          { date: dayKey(old), seconds: 100, heartbeats: 1, inputTokens: 0, outputTokens: 0, promptChars: 0, sessions: [], projects: {} },
          { date: dayKey(BASE), seconds: 50, heartbeats: 1, inputTokens: 0, outputTokens: 0, promptChars: 0, sessions: [], projects: {} },
        ],
      }),
      'utf8',
    )
    await store.load()
    const snap = store.snapshot()
    assert.equal(snap.totalSeconds, 50, '10 天前的桶应被裁掉')
    assert.ok(KEEP_DAYS >= 3)
  } finally {
    await tmp.cleanup()
  }
})
