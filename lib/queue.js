/**
 * dsh-plugin-wakatime —— 持久化离线队列（lib/queue.js）
 *
 * 设计要点：
 * - 文件格式：`{ version: 1, entries: [...] }`（兼容旧的纯数组格式）；
 * - 写入原子化：先写 `*.tmp-*` 再 rename，避免半截文件；
 * - 损坏文件：改名成 `*.corrupt-<时间戳>` 后从空队列开始，并记一条 warning；
 * - 上限淘汰：超过 maxEntries 时丢弃最旧的条目（保留最新）。
 *
 * @module wakatime/lib/queue
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 队列文件当前版本号。 */
export const QUEUE_VERSION = 1;
/** 默认队列上限。 */
export const DEFAULT_MAX_ENTRIES = 500;
/** drain 默认取出的条数（等于 WakaTime 批量上限）。 */
export const DEFAULT_DRAIN_SIZE = 25;

/**
 * 判断是否为可入队的心跳对象（非 null、非数组的普通对象）。
 * @param {unknown} value
 * @returns {boolean}
 */
function isHeartbeat(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一化条目数量参数。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [max]
 * @returns {number}
 */
function normalizeCount(value, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

/**
 * 创建持久化队列。所有文件 IO 都以「返回值/日志」方式处理失败，不向外抛异常；
 * 内存中的队列状态在写盘失败时仍然保留，下一次操作会再次尝试落盘。
 *
 * @param {{
 *   file: string,
 *   maxEntries?: number,
 *   logger?: { debug?: (msg: string) => void, warn?: (msg: string) => void, error?: (msg: string) => void },
 * }} options
 * @returns {{
 *   load: () => Promise<number>,
 *   push: (heartbeats: unknown) => Promise<number>,
 *   drain: (n?: number) => Promise<Array<Record<string, unknown>>>,
 *   commit: (n: number) => Promise<number>,
 *   drop: (n: number) => Promise<number>,
 *   size: () => number,
 *   readonly file: string,
 *   readonly lastError: Error | undefined,
 * }}
 */
export function createQueue({ file, maxEntries = DEFAULT_MAX_ENTRIES, logger } = {}) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new TypeError('createQueue: options.file 必须是非空路径字符串');
  }

  const queueFile = path.resolve(file);
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;

  /** @type {Array<Record<string, unknown>>} */
  let entries = [];
  let loaded = false;
  /** @type {Promise<void> | null} */
  let loadPromise = null;
  /** 串行化落盘，避免并发 push 交错写坏文件。 */
  let writeChain = Promise.resolve();
  let tempCounter = 0;
  /** @type {Error | undefined} */
  let lastError;

  /**
   * 原子落盘：mkdir → 写 tmp → rename。失败时清理 tmp 并记录错误（不抛）。
   * @returns {Promise<boolean>} 是否成功
   */
  async function writeAtomically() {
    try {
      await fsp.mkdir(path.dirname(queueFile), { recursive: true });
      const payload = JSON.stringify({ version: QUEUE_VERSION, entries });
      tempCounter += 1;
      const tmpFile = `${queueFile}.tmp-${process.pid}-${Date.now()}-${tempCounter}`;
      await fsp.writeFile(tmpFile, payload, 'utf8');
      try {
        await fsp.rename(tmpFile, queueFile);
      } catch (error) {
        await fsp.rm(tmpFile, { force: true }).catch(() => {});
        throw error;
      }
      lastError = undefined;
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger?.error?.(`队列写盘失败（${queueFile}）：${lastError.message}`);
      return false;
    }
  }

  /**
   * 排队一次落盘（串行执行）。
   * @returns {Promise<boolean>}
   */
  function persist() {
    const next = writeChain.then(() => writeAtomically());
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 读盘并恢复队列；文件不存在→空队列；损坏→改名后空队列。
   * @returns {Promise<number>} 载入的条目数
   */
  async function load() {
    let text;
    try {
      text = await fsp.readFile(queueFile, 'utf8');
    } catch (error) {
      loaded = true;
      if (error?.code === 'ENOENT') {
        entries = [];
        return 0;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      logger?.warn?.(`队列文件不可读（${queueFile}）：${lastError.message}，从空队列开始`);
      entries = [];
      return 0;
    }

    try {
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      const list = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)
          ? parsed.entries
          : null;
      if (list === null) throw new Error('队列文件结构不符合预期');
      entries = list.filter(isHeartbeat).slice(-limit);
      loaded = true;
      return entries.length;
    } catch (error) {
      loaded = true;
      const corruptFile = `${queueFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        await fsp.rename(queueFile, corruptFile);
      } catch (renameError) {
        logger?.warn?.(`损坏的队列文件改名失败：${renameError?.message ?? renameError}`);
      }
      entries = [];
      lastError = error instanceof Error ? error : new Error(String(error));
      logger?.warn?.(`队列文件损坏（${lastError.message}），已改名 ${corruptFile} 并从空队列开始`);
      return 0;
    }
  }

  /**
   * 确保只读盘一次（load 与其它操作并发时复用同一个 Promise）。
   * @returns {Promise<void>}
   */
  async function ensureLoaded() {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = load().then(
        () => undefined,
        () => {
          loaded = true;
        },
      );
    }
    await loadPromise;
  }

  /**
   * 批量追加心跳并落盘；超过上限时淘汰最旧的条目。
   * @param {unknown} heartbeats 单条心跳或心跳数组
   * @returns {Promise<number>} 追加后的队列长度
   */
  async function push(heartbeats) {
    await ensureLoaded();
    const incoming = (Array.isArray(heartbeats) ? heartbeats : [heartbeats]).filter(isHeartbeat);
    if (incoming.length === 0) return entries.length;

    entries.push(...incoming);
    if (entries.length > limit) {
      const dropped = entries.length - limit;
      entries = entries.slice(dropped);
      logger?.warn?.(`队列超过上限 ${limit}，淘汰最旧的 ${dropped} 条心跳`);
    }
    await persist();
    return entries.length;
  }

  /**
   * 取队首 n 条（不删除），用于发送前读取。
   * @param {number} [n] 默认 25
   * @returns {Promise<Array<Record<string, unknown>>>} 心跳数组的浅拷贝
   */
  async function drain(n = DEFAULT_DRAIN_SIZE) {
    await ensureLoaded();
    const count = Math.min(normalizeCount(n, DEFAULT_DRAIN_SIZE), entries.length);
    return entries.slice(0, count);
  }

  /**
   * 发送成功后删除队首 n 条并落盘。
   * @param {number} n
   * @returns {Promise<number>} 实际删除的条数
   */
  async function commit(n) {
    await ensureLoaded();
    const count = Math.min(normalizeCount(n, 0), entries.length);
    if (count === 0) return 0;
    entries = entries.slice(count);
    await persist();
    return count;
  }

  /**
   * 永久失败时丢弃队首 n 条并落盘。
   * @param {number} n
   * @returns {Promise<number>} 实际丢弃的条数
   */
  async function drop(n) {
    await ensureLoaded();
    const count = Math.min(normalizeCount(n, 0), entries.length);
    if (count === 0) return 0;
    entries = entries.slice(count);
    logger?.warn?.(`丢弃 ${count} 条永久失败的心跳`);
    await persist();
    return count;
  }

  /**
   * 当前内存队列长度（未 load 时为 0）。
   * @returns {number}
   */
  function size() {
    return entries.length;
  }

  /** @type {ReturnType<typeof createQueue>} */
  const queue = {
    load: async () => {
      if (loaded) return entries.length;
      return load();
    },
    push,
    drain,
    commit,
    drop,
    size,
  };
  Object.defineProperties(queue, {
    file: { value: queueFile, enumerable: true },
    lastError: { get: () => lastError, enumerable: true },
  });
  return queue;
}
