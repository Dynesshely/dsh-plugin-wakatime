/**
 * dsh-plugin-wakatime —— WakaTime HTTP 客户端（lib/client.js）
 *
 * 设计要点：
 * - 所有错误都转成 `{ ok: false, ... }` 返回值，绝不向外抛异常；
 * - 1 条心跳走 `/users/current/heartbeats`，多条走 `/users/current/heartbeats.bulk`，每批最多 25 条；
 * - Basic 认证（base64 的是 api_key 原文），401 永久失败并置 `disabledReason = 'unauthorized'`；
 * - 429 / 5xx / 网络错误可重试，`retryAfterMs` 优先取 `Retry-After`（秒或 HTTP-date），否则指数退避；
 * - 代理需要 undici 的 ProxyAgent：动态 `import('undici')`，不可用时记一条 warning 并直连（不影响主流程）。
 *
 * @module wakatime/lib/client
 */
import { defaultUserAgent } from './cfg.js';

/** 批量端点单次请求允许的最大心跳条数（WakaTime API 限制）。 */
export const MAX_BATCH_SIZE = 25;
/** 默认请求超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 10000;
/** 默认 API 基地址。 */
const FALLBACK_API_URL = 'https://api.wakatime.com/api/v1';
/** 指数退避：首次 2s，翻倍，封顶 60s。 */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * 解析 `Retry-After` 头。支持两种合法形式：秒数（可为小数）与 HTTP-date。
 *
 * @param {string | null | undefined} value 响应头原始值
 * @param {number} [now] 当前时间戳（毫秒），便于测试注入
 * @returns {number | undefined} 需要等待的毫秒数；无法解析时返回 undefined
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

/**
 * 隐藏代理 URL 中的用户名/密码，避免日志泄漏凭据。
 * @param {string} rawUrl
 * @returns {string}
 */
function redactProxyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
      return url.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * 计算指数退避毫秒数。
 * @param {number} attempt 连续可重试失败次数（从 1 开始）
 * @returns {number}
 */
function backoffDelay(attempt) {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 5);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * 从响应体里尽力提取可读的错误描述（截断到 300 字符，避免日志爆炸）。
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function extractErrorText(response) {
  try {
    if (typeof response?.text !== 'function') return '';
    const text = await response.text();
    if (typeof text !== 'string' || text.trim() === '') return '';
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error ?? parsed?.message ?? parsed?.errors;
      if (typeof message === 'string') return message.slice(0, 300);
      if (message !== undefined) return JSON.stringify(message).slice(0, 300);
    } catch {
      // 非 JSON，直接返回原文
    }
    return text.trim().slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * 把入参归一化成心跳对象数组：数组原样过滤，单个对象包成数组，其它视为空。
 * @param {unknown} heartbeats
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeHeartbeats(heartbeats) {
  if (Array.isArray(heartbeats)) {
    return heartbeats.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  }
  if (heartbeats !== null && typeof heartbeats === 'object' && !Array.isArray(heartbeats)) {
    return [heartbeats];
  }
  return [];
}

/** undici 模块的动态导入结果缓存（模块级，进程内只尝试一次）。 */
let undiciModulePromise;

/**
 * 动态导入 undici，失败时缓存错误、不抛异常。
 * @returns {Promise<{ module?: unknown, error?: Error }>}
 */
function loadUndici() {
  if (!undiciModulePromise) {
    undiciModulePromise = import('undici').then(
      (module) => ({ module }),
      (error) => ({ error }),
    );
  }
  return undiciModulePromise;
}

/**
 * 创建 WakaTime 客户端。
 *
 * @param {{
 *   apiKey?: string,
 *   apiUrl?: string,
 *   proxy?: string,
 *   hostname?: string,
 *   userAgent?: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: { debug?: (msg: string) => void, warn?: (msg: string) => void, error?: (msg: string) => void },
 *   timeoutMs?: number,
 * }} [options]
 * @returns {{
 *   sendBatch: (heartbeats: unknown) => Promise<{
 *     ok: boolean, status: number, sent: number,
 *     retryAfterMs?: number, retryable?: boolean, permanent?: boolean,
 *     error?: string, disabledReason?: string,
 *   }>,
 *   send: (heartbeats: unknown) => Promise<{
 *     ok: boolean, status: number, sent: number,
 *     retryAfterMs?: number, retryable?: boolean, permanent?: boolean,
 *     error?: string, disabledReason?: string,
 *   }>,
 *   readonly disabledReason: 'unauthorized' | undefined,
 *   readonly maxBatchSize: number,
 * }}
 */
export function createClient({
  apiKey,
  apiUrl = FALLBACK_API_URL,
  proxy,
  hostname,
  userAgent = defaultUserAgent(),
  fetchImpl = globalThis.fetch,
  logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const baseUrl = (typeof apiUrl === 'string' && apiUrl.trim() !== '' ? apiUrl.trim() : FALLBACK_API_URL).replace(/\/+$/, '');
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const authHeader = key ? `Basic ${Buffer.from(key, 'utf8').toString('base64')}` : undefined;
  const proxyUrl = typeof proxy === 'string' && proxy.trim() !== '' ? proxy.trim() : undefined;

  /** @type {'unauthorized' | undefined} */
  let disabledReason;
  let consecutiveRetryableFailures = 0;
  let proxyWarningEmitted = false;
  let dispatcherPromise;

  /**
   * 构造请求头。
   * @returns {Record<string, string>}
   */
  function buildHeaders() {
    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': userAgent,
    };
    if (authHeader) headers.Authorization = authHeader;
    if (typeof hostname === 'string' && hostname.trim() !== '') headers['X-Machine-Name'] = hostname.trim();
    return headers;
  }

  /**
   * 代理 dispatcher：有 proxy 才尝试创建 ProxyAgent；任何失败都降级直连，只告警一次。
   * @returns {Promise<unknown | undefined>}
   */
  async function resolveDispatcher() {
    if (!proxyUrl) return undefined;
    if (!dispatcherPromise) {
      dispatcherPromise = (async () => {
        const { module, error } = await loadUndici();
        const ProxyAgent = module?.ProxyAgent;
        if (typeof ProxyAgent !== 'function') {
          if (!proxyWarningEmitted) {
            proxyWarningEmitted = true;
            logger?.warn?.(`未找到可用的 undici ProxyAgent（${error?.code ?? 'unavailable'}），代理 ${redactProxyUrl(proxyUrl)} 已降级为直连`);
          }
          return undefined;
        }
        try {
          return new ProxyAgent(proxyUrl);
        } catch (agentError) {
          if (!proxyWarningEmitted) {
            proxyWarningEmitted = true;
            logger?.warn?.(`ProxyAgent 初始化失败（${agentError?.message ?? agentError}），代理 ${redactProxyUrl(proxyUrl)} 已降级为直连`);
          }
          return undefined;
        }
      })();
    }
    return dispatcherPromise;
  }

  /**
   * 发送一个 ≤25 条的批次。
   * @param {Array<Record<string, unknown>>} chunk
   * @returns {Promise<{ ok: boolean, status: number, sent: number, retryAfterMs?: number, retryable?: boolean, permanent?: boolean, error?: string }>}
   */
  async function postChunk(chunk) {
    const endpoint = chunk.length === 1 ? '/users/current/heartbeats' : '/users/current/heartbeats.bulk';
    const url = `${baseUrl}${endpoint}`;
    const payload = chunk.length === 1 ? chunk[0] : chunk;

    try {
      const dispatcher = await resolveDispatcher();
      /** @type {RequestInit & { dispatcher?: unknown }} */
      const requestInit = {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(normalizedTimeout),
      };
      if (dispatcher) requestInit.dispatcher = dispatcher;

      const response = await fetchImpl(url, requestInit);
      const status = Number(response?.status ?? 0);
      const retryAfterMs = parseRetryAfter(response?.headers?.get?.('retry-after'));

      if (status >= 200 && status < 300) {
        consecutiveRetryableFailures = 0;
        logger?.debug?.(`POST ${endpoint} → ${status}（${chunk.length} 条）`);
        return { ok: true, status, sent: chunk.length };
      }

      const detail = await extractErrorText(response);
      const errorSuffix = detail ? `: ${detail}` : '';

      if (status === 401) {
        disabledReason = 'unauthorized';
        consecutiveRetryableFailures = 0;
        const error = `unauthorized${errorSuffix}`;
        logger?.warn?.('WakaTime 认证失败（401），暂停上报直到配置变化');
        return { ok: false, status, sent: 0, retryable: false, permanent: true, error, disabledReason };
      }

      if (status === 403) {
        consecutiveRetryableFailures = 0;
        const error = `forbidden${errorSuffix}`;
        logger?.warn?.('WakaTime 拒绝访问（403），本条请求不会再重试');
        return { ok: false, status, sent: 0, retryable: false, permanent: true, error };
      }

      if (status === 429 || status >= 500) {
        consecutiveRetryableFailures += 1;
        const delay = retryAfterMs ?? backoffDelay(consecutiveRetryableFailures);
        logger?.debug?.(`POST ${endpoint} → ${status}，${delay}ms 后重试${errorSuffix}`);
        return {
          ok: false,
          status,
          sent: 0,
          retryable: true,
          permanent: false,
          retryAfterMs: delay,
          error: `http ${status}${errorSuffix}`,
        };
      }

      // 其余 4xx（400/404 等）视为永久失败：同样的请求重发也不会成功。
      consecutiveRetryableFailures = 0;
      logger?.warn?.(`POST ${endpoint} → ${status}，请求被拒绝${errorSuffix}`);
      return { ok: false, status, sent: 0, retryable: false, permanent: true, error: `http ${status}${errorSuffix}` };
    } catch (error) {
      consecutiveRetryableFailures += 1;
      const name = error?.name ?? 'Error';
      const isTimeout = name === 'TimeoutError' || name === 'AbortError';
      const message = isTimeout
        ? `timeout after ${normalizedTimeout}ms`
        : `${name}: ${error?.message ?? String(error)}`;
      const delay = backoffDelay(consecutiveRetryableFailures);
      logger?.debug?.(`POST ${endpoint} 失败（${message}），${delay}ms 后重试`);
      return {
        ok: false,
        status: 0,
        sent: 0,
        retryable: true,
        permanent: false,
        retryAfterMs: delay,
        error: message,
      };
    }
  }

  /**
   * 批量发送心跳（每批 ≤25，超出自动切批；遇到失败立即停止并返回该失败）。
   *
   * @param {unknown} heartbeats 单条心跳或心跳数组
   * @returns {Promise<{
   *   ok: boolean, status: number, sent: number,
   *   retryAfterMs?: number, retryable?: boolean, permanent?: boolean,
   *   error?: string, disabledReason?: string,
   * }>}
   */
  async function sendBatch(heartbeats) {
    try {
      if (!authHeader) {
        return { ok: false, status: 0, sent: 0, retryable: false, permanent: true, error: 'missing api_key' };
      }
      if (disabledReason) {
        return {
          ok: false,
          status: 401,
          sent: 0,
          retryable: false,
          permanent: true,
          error: 'disabled: unauthorized',
          disabledReason,
        };
      }

      const list = normalizeHeartbeats(heartbeats);
      if (list.length === 0) return { ok: true, status: 0, sent: 0 };

      let sent = 0;
      let lastStatus = 0;
      for (let offset = 0; offset < list.length; offset += MAX_BATCH_SIZE) {
        const chunk = list.slice(offset, offset + MAX_BATCH_SIZE);
        const result = await postChunk(chunk);
        if (!result.ok) {
          return { ...result, sent, ...(disabledReason ? { disabledReason } : {}) };
        }
        sent += chunk.length;
        lastStatus = result.status;
      }
      return { ok: true, status: lastStatus, sent };
    } catch (error) {
      // 兜底：任何实现缺陷都不允许冒泡成未捕获异常。
      return {
        ok: false,
        status: 0,
        sent: 0,
        retryable: true,
        permanent: false,
        error: `unexpected: ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      };
    }
  }

  /** @type {ReturnType<typeof createClient>} */
  const client = {
    sendBatch,
    send: sendBatch,
  };
  Object.defineProperties(client, {
    disabledReason: { get: () => disabledReason, enumerable: true },
    maxBatchSize: { value: MAX_BATCH_SIZE, enumerable: true },
  });
  return client;
}
