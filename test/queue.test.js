import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createQueue, QUEUE_VERSION } from '../lib/queue.js';

/**
 * 建临时目录，测试后清理。
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wakatime-queue-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 造一条心跳。
 * @param {number} index
 * @returns {{ entity: string, type: string, category: string, time: number }}
 */
function heartbeat(index) {
  return { entity: `/repo/file-${index}.js`, type: 'file', category: 'ai coding', time: 1730000000 + index };
}

/**
 * 读取队列文件内容。
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readQueueFile(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

test('push/drain/commit：追加、读取不删除、提交后删除并持久化', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  const queue = createQueue({ file });

  assert.equal(queue.size(), 0);
  assert.equal(await queue.push([heartbeat(0), heartbeat(1), heartbeat(2)]), 3);
  assert.equal(queue.size(), 3);

  const drained = await queue.drain(2);
  assert.deepEqual(drained.map((item) => item.time), [1730000000, 1730000001]);
  assert.equal(queue.size(), 3, 'drain 不应删除条目');

  assert.equal(await queue.commit(2), 2);
  assert.equal(queue.size(), 1);

  // 文件已落盘：新实例 load 后看到剩余 1 条
  const reloaded = createQueue({ file });
  assert.equal(await reloaded.load(), 1);
  assert.deepEqual((await reloaded.drain(25)).map((item) => item.time), [1730000002]);
});

test('load：文件不存在 → 0 条，不抛错', async (t) => {
  const dir = await makeTempDir(t);
  const queue = createQueue({ file: path.join(dir, 'missing', 'queue.json') });

  assert.equal(await queue.load(), 0);
  assert.equal(queue.size(), 0);
});

test('drain 默认取 25 条，n 大于队列长度时返回全部', async (t) => {
  const dir = await makeTempDir(t);
  const queue = createQueue({ file: path.join(dir, 'queue.json') });
  await queue.push(Array.from({ length: 30 }, (_, index) => heartbeat(index)));

  assert.equal((await queue.drain()).length, 25);
  assert.equal((await queue.drain(1000)).length, 30);
});

test('drop：永久失败丢弃队首 n 条并持久化', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  const warnings = [];
  const queue = createQueue({ file, logger: { warn: (msg) => warnings.push(msg) } });
  await queue.push([heartbeat(0), heartbeat(1), heartbeat(2)]);

  assert.equal(await queue.drop(2), 2);
  assert.equal(queue.size(), 1);
  assert.equal(warnings.length, 1);

  const reloaded = createQueue({ file });
  assert.equal(await reloaded.load(), 1);
  assert.equal((await reloaded.drain(1))[0].time, 1730000002);
});

test('commit/drop：0、负数、非法参数返回 0 且不影响队列', async (t) => {
  const dir = await makeTempDir(t);
  const queue = createQueue({ file: path.join(dir, 'queue.json') });
  await queue.push([heartbeat(0), heartbeat(1)]);

  assert.equal(await queue.commit(0), 0);
  assert.equal(await queue.commit(-3), 0);
  assert.equal(await queue.drop(Number.NaN), 0);
  assert.equal(queue.size(), 2);
});

test('损坏文件：改名 .corrupt-* 后从空队列开始，并记一条 warning', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  await fsp.writeFile(file, '{this is not json', 'utf8');

  const warnings = [];
  const queue = createQueue({ file, logger: { warn: (msg) => warnings.push(msg) } });

  assert.equal(await queue.load(), 0);
  assert.equal(queue.size(), 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /损坏/);

  const files = await fsp.readdir(dir);
  assert.equal(files.some((name) => name.startsWith('queue.json.corrupt-')), true, '损坏文件应被改名保留');
  assert.equal(files.includes('queue.json'), false, '原队列文件应已不存在');
});

test('结构不符（缺 entries 且非数组）也按损坏处理', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  await fsp.writeFile(file, JSON.stringify({ version: 99, items: [] }), 'utf8');

  const queue = createQueue({ file });
  assert.equal(await queue.load(), 0);
  const files = await fsp.readdir(dir);
  assert.equal(files.some((name) => name.startsWith('queue.json.corrupt-')), true);
});

test('兼容旧格式（纯数组 JSON）', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  await fsp.writeFile(file, JSON.stringify([heartbeat(0), heartbeat(1)]), 'utf8');

  const queue = createQueue({ file });
  assert.equal(await queue.load(), 2);
  assert.equal((await queue.drain(1))[0].time, 1730000000);
});

test('上限淘汰：maxEntries=3 时只保留最新 3 条', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  const warnings = [];
  const queue = createQueue({ file, maxEntries: 3, logger: { warn: (msg) => warnings.push(msg) } });

  await queue.push(Array.from({ length: 5 }, (_, index) => heartbeat(index)));

  assert.equal(queue.size(), 3);
  assert.deepEqual((await queue.drain(3)).map((item) => item.time), [1730000002, 1730000003, 1730000004]);
  assert.ok(warnings.some((msg) => /上限/.test(msg)));

  // 落盘的也是最新 3 条
  const reloaded = createQueue({ file, maxEntries: 3 });
  assert.equal(await reloaded.load(), 3);
  assert.deepEqual((await reloaded.drain(3)).map((item) => item.time), [1730000002, 1730000003, 1730000004]);
});

test('load 时也按上限截断超量文件', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  await fsp.writeFile(
    file,
    JSON.stringify({ version: QUEUE_VERSION, entries: [heartbeat(0), heartbeat(1), heartbeat(2)] }),
    'utf8',
  );

  const queue = createQueue({ file, maxEntries: 2 });
  assert.equal(await queue.load(), 2);
  assert.deepEqual((await queue.drain(2)).map((item) => item.time), [1730000001, 1730000002]);
});

test('写入格式：{ version, entries }，无残留 tmp 文件（原子写）', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  const queue = createQueue({ file });

  await queue.push([heartbeat(0), heartbeat(1)]);

  const parsed = await readQueueFile(file);
  assert.equal(parsed.version, QUEUE_VERSION);
  assert.equal(Array.isArray(parsed.entries), true);
  assert.equal(parsed.entries.length, 2);

  const files = await fsp.readdir(dir);
  assert.equal(files.some((name) => name.includes('.tmp-')), false, '不应残留临时文件');
});

test('并发 push：串行落盘，最终文件完整且不丢条目', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  const queue = createQueue({ file });

  await Promise.all(Array.from({ length: 10 }, (_, index) => queue.push(heartbeat(index))));

  assert.equal(queue.size(), 10);
  const parsed = await readQueueFile(file);
  assert.equal(parsed.entries.length, 10);
  assert.equal(parsed.entries[9].time, 1730000009);
});

test('过滤非法条目：null/数组/字符串/数字不入队，单个对象可入队', async (t) => {
  const dir = await makeTempDir(t);
  const queue = createQueue({ file: path.join(dir, 'queue.json') });

  assert.equal(await queue.push([null, 'x', 42, [heartbeat(0)], heartbeat(1)]), 1);
  assert.equal(await queue.push(heartbeat(2)), 2);
  assert.deepEqual((await queue.drain(2)).map((item) => item.time), [1730000001, 1730000002]);
});

test('push 空数组不落盘也不改变队列', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'queue.json');
  const queue = createQueue({ file });

  assert.equal(await queue.push([]), 0);
  assert.equal(await queue.push(undefined), 0);
  await assert.rejects(fsp.stat(file), '空 push 不应创建文件');
});

test('队列文件所在目录自动创建', async (t) => {
  const dir = await makeTempDir(t);
  const file = path.join(dir, 'deep', 'nested', 'queue.json');
  const queue = createQueue({ file });

  await queue.push([heartbeat(0)]);
  assert.equal((await fsp.stat(file)).isFile(), true);
  assert.equal(queue.file, path.resolve(file));
});

test('写盘失败：保留内存队列、记录 lastError、不抛异常', async (t) => {
  const dir = await makeTempDir(t);
  const blocker = path.join(dir, 'blocker');
  await fsp.writeFile(blocker, 'x');
  const file = path.join(blocker, 'queue.json');
  const errors = [];
  const queue = createQueue({ file, logger: { error: (msg) => errors.push(msg) } });

  const size = await queue.push([heartbeat(0)]);
  assert.equal(size, 1);
  assert.equal(queue.size(), 1);
  assert.ok(queue.lastError instanceof Error);
  assert.equal(errors.length >= 1, true);
});

test('createQueue：缺少 file 参数抛 TypeError', () => {
  assert.throws(() => createQueue({}), TypeError);
  assert.throws(() => createQueue({ file: '   ' }), TypeError);
});
