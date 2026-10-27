/**
 * dsh-plugin-wakatime —— 配置解析（lib/cfg.js）
 *
 * 职责边界：本文件把「读文件」和「纯计算」分开。
 * - parseIni / resolveSettings / computeStateDir / defaultUserAgent / clampInt 等均为纯函数（无 IO、无全局状态）；
 * - readWakaTimeConfig / ensureStateDir 承担唯一的文件 IO，且约定「绝不抛错」。
 *
 * 配置来源优先级：插件 config（DSH 传入） > ~/.wakatime.cfg [settings] > 内置默认值。
 *
 * @module wakatime/lib/cfg
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 默认 WakaTime API 基地址（末尾不带斜杠）。 */
export const DEFAULT_API_URL = 'https://api.wakatime.com/api/v1';
/** 默认 heartbeat category。 */
export const DEFAULT_CATEGORY = 'ai coding';
/** 两次 heartbeat 之间的默认最小间隔（秒）。 */
export const DEFAULT_MIN_INTERVAL_SECONDS = 120;
/** 最小间隔允许范围（秒）。 */
export const MIN_INTERVAL_RANGE = Object.freeze([10, 900]);
/** 空闲超时默认值（分钟，对齐 WakaTime 官方 keystroke timeout）。 */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;
/** 空闲超时允许范围（分钟）。 */
export const IDLE_TIMEOUT_RANGE = Object.freeze([1, 240]);
/** 队列/日志/状态目录名。 */
export const STATE_DIR_NAME = 'wakatime-dsh';
/** 插件版本（仅用于 User-Agent 与文档展示）。 */
export const PLUGIN_VERSION = '0.1.0';

/**
 * 判断一个值是否是非空（去空白后）字符串。
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 取字符串的去除首尾空白版本；非字符串/空串返回 undefined。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeString(value) {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

/**
 * 解析 INI 文本。
 *
 * 容错规则（见 docs/design.md）：
 * - 去掉 UTF-8 BOM；LF / CRLF / CR 均可作为换行；
 * - 整行 `#` 或 `;` 开头视为注释；空行忽略；
 * - `=` 两侧空白会被去掉，键名与 section 名统一转小写；
 * - 第一个 `[section]` 之前的键归入 `settings`；
 * - 以空白开头的续行并入上一个键的值（用单个空格连接）；
 * - 同名键重复出现时后者覆盖前者；不含 `=` 且非续行的乱行直接忽略。
 *
 * @param {string} text INI 文本（可为空）
 * @returns {{ sections: Record<string, Record<string, string>> }} 解析结果；无 section 时 sections 为空对象
 */
export function parseIni(text) {
  const sections = {};
  if (typeof text !== 'string' || text === '') return { sections };

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let currentSection = 'settings';
  /** @type {string | null} */
  let lastKey = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '') {
      // 空行结束续行上下文
      lastKey = null;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const sectionMatch = /^\[([^\]]*)\]$/.exec(trimmed);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase() || 'settings';
      if (!sections[currentSection]) sections[currentSection] = {};
      lastKey = null;
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      // 只有「原始行以空白开头 + 存在上一个键」才当作续行，避免把乱行拼坏上一个值。
      const isContinuation = /^[ \t]/.test(rawLine) && lastKey !== null;
      if (isContinuation) {
        const bucket = sections[currentSection] ?? (sections[currentSection] = {});
        bucket[lastKey] = `${bucket[lastKey]} ${trimmed}`.trim();
      }
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
    if (key === '') continue;
    const value = trimmed.slice(eqIndex + 1).trim();
    const bucket = sections[currentSection] ?? (sections[currentSection] = {});
    bucket[key] = value;
    lastKey = key;
  }

  return { sections };
}

/**
 * 计算 ~/.wakatime.cfg 的路径。支持 `WAKATIME_HOME` 环境变量（与 WakaTime 官方 CLI 一致）。
 *
 * @param {{ cfgPath?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string} 解析后的绝对路径
 */
export function resolveConfigPath({ cfgPath, homeDir = os.homedir(), env = process.env } = {}) {
  if (isNonEmptyString(cfgPath)) return path.resolve(cfgPath);
  const wakatimeHome = normalizeString(env?.WAKATIME_HOME);
  const baseDir = wakatimeHome ? path.resolve(wakatimeHome) : path.resolve(homeDir);
  return path.join(baseDir, '.wakatime.cfg');
}

/**
 * 读取 ~/.wakatime.cfg。任何错误（不存在、无权限、编码错误）都转成 `{ found: false }` 返回，绝不抛错。
 *
 * 返回对象里只放解析后的键值，不附带文件原文，避免 api_key 意外进入日志。
 *
 * @param {{ cfgPath?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<
 *   | { found: true, path: string, sections: Record<string, Record<string, string>>, settings: Record<string, string> }
 *   | { found: false, path: string, error?: string }
 * >}
 */
export async function readWakaTimeConfig({ cfgPath, homeDir = os.homedir(), env = process.env } = {}) {
  const resolvedPath = resolveConfigPath({ cfgPath, homeDir, env });
  let text;
  try {
    text = await fsp.readFile(resolvedPath, 'utf8');
  } catch (error) {
    return { found: false, path: resolvedPath, error: error?.code ?? 'read_failed' };
  }

  const { sections } = parseIni(text);
  return {
    found: true,
    path: resolvedPath,
    sections,
    settings: sections.settings ?? {},
  };
}

/**
 * 把任意数字限制在整数范围内；非有限数字时用默认值。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  const base = Number.isFinite(num) ? Math.round(num) : fallback;
  return Math.min(max, Math.max(min, base));
}

/**
 * 去掉 URL 末尾的斜杠，并按需补上协议前缀。
 * @param {string} apiUrl
 * @returns {string}
 */
function normalizeApiUrl(apiUrl) {
  const trimmed = apiUrl.replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * 生成默认 User-Agent。
 *
 * 采用 WakaTime 官方插件指南的形态：`<plugin>/<ver> (<OS>-<release>-<arch>) node/<ver>`，
 * 首个 token 即插件名，dashboard 会据此把流量归到 DeepSeek Harness 这个「编辑器」上。
 * 不冒充 wakatime-cli 或其他编辑器（见 docs/wakatime-api.md）。
 *
 * @param {{
 *   pluginVersion?: string,
 *   platform?: string,
 *   release?: string,
 *   arch?: string,
 *   nodeVersion?: string,
 * }} [opts]
 * @returns {string}
 */
export function defaultUserAgent({
  pluginVersion = PLUGIN_VERSION,
  platform = process.platform,
  release = os.release(),
  arch = process.arch,
  nodeVersion = process.versions?.node ?? '0.0.0',
} = {}) {
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
  return `dsh-plugin-wakatime/${pluginVersion} (${osName}-${release}-${arch}) node/${nodeVersion}`;
}

/**
 * 计算状态目录（纯函数，不创建目录）：
 * `DSH_HOME` 存在 → `<DSH_HOME>/cache/wakatime-dsh`；否则 `<homedir>/.dsh/cache/wakatime-dsh`。
 *
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts]
 * @returns {string} 绝对路径
 */
export function computeStateDir({ env = process.env, homeDir = os.homedir() } = {}) {
  const dshHome = normalizeString(env?.DSH_HOME);
  const baseDir = dshHome
    ? path.join(path.resolve(dshHome), 'cache')
    : path.join(path.resolve(homeDir), '.dsh', 'cache');
  return path.join(baseDir, STATE_DIR_NAME);
}

/**
 * 确保状态目录存在。目录不可创建时退化到 `os.tmpdir()/wakatime-dsh`；两者都失败也不抛错，
 * 返回退化路径交给上层（队列写入自身也会 mkdir，失败会转成返回值）。
 *
 * @param {string} dir 目标目录
 * @param {{ fallbackDir?: string, logger?: { warn?: (msg: string) => void } }} [opts]
 * @returns {Promise<string>} 实际可用的目录
 */
export async function ensureStateDir(dir, { fallbackDir = path.join(os.tmpdir(), STATE_DIR_NAME), logger } = {}) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    logger?.warn?.(`无法创建状态目录 ${dir}（${error?.code ?? error?.message}），退化到 ${fallbackDir}`);
  }
  try {
    await fsp.mkdir(fallbackDir, { recursive: true });
    return fallbackDir;
  } catch {
    return fallbackDir;
  }
}

/**
 * 合并插件 config 与 ~/.wakatime.cfg，得到最终运行配置（纯函数）。
 *
 * 优先级：插件 config > cfg 文件 [settings] > 默认值。数值项会被夹到合法范围，
 * 布尔项只接受真正的 boolean（字符串 'true' 仅对 cfg 文件的 debug 生效）。
 *
 * @param {{
 *   file?: { found?: boolean, settings?: Record<string, string> } | null,
 *   config?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {{
 *   apiKey: string | undefined,
 *   apiUrl: string,
 *   proxy: string | undefined,
 *   hostname: string | undefined,
 *   debug: boolean,
 *   enabled: boolean,
 *   minIntervalSeconds: number,
 *   idleTimeoutMinutes: number,
 *   entityType: 'file' | 'app',
 *   category: string,
 *   projectFromCwd: boolean,
 *   includeSubagentSessions: boolean,
 *   language: string | undefined,
 *   userAgent: string,
 *   stateDir: string,
 *   cfgPath: string,
 * }}
 */
export function resolveSettings({ file, config = {}, env = process.env } = {}) {
  const cfg = file && file.found !== false && file.settings && typeof file.settings === 'object' ? file.settings : {};
  const plugin = config && typeof config === 'object' ? config : {};

  const apiKey = normalizeString(plugin.apiKey) ?? normalizeString(cfg.api_key);
  const apiUrl = normalizeApiUrl(normalizeString(plugin.apiUrl) ?? DEFAULT_API_URL);
  const proxy = normalizeString(plugin.proxy) ?? normalizeString(cfg.proxy);
  const hostname = normalizeString(plugin.hostname) ?? normalizeString(cfg.hostname) ?? os.hostname();

  const debug = typeof plugin.debug === 'boolean'
    ? plugin.debug
    : String(cfg.debug ?? '').trim().toLowerCase() === 'true';
  const enabled = typeof plugin.enabled === 'boolean' ? plugin.enabled : true;
  const minIntervalSeconds = clampInt(
    plugin.minIntervalSeconds ?? DEFAULT_MIN_INTERVAL_SECONDS,
    DEFAULT_MIN_INTERVAL_SECONDS,
    MIN_INTERVAL_RANGE[0],
    MIN_INTERVAL_RANGE[1],
  );
  const idleTimeoutMinutes = clampInt(
    plugin.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES,
    DEFAULT_IDLE_TIMEOUT_MINUTES,
    IDLE_TIMEOUT_RANGE[0],
    IDLE_TIMEOUT_RANGE[1],
  );
  const entityType = plugin.entityType === 'app' ? 'app' : 'file';
  const category = normalizeString(plugin.category) ?? DEFAULT_CATEGORY;
  const projectFromCwd = typeof plugin.projectFromCwd === 'boolean' ? plugin.projectFromCwd : true;
  const includeSubagentSessions = typeof plugin.includeSubagentSessions === 'boolean'
    ? plugin.includeSubagentSessions
    : false;
  const language = normalizeString(plugin.language);
  const userAgent = normalizeString(plugin.userAgent) ?? defaultUserAgent();
  const stateDir = computeStateDir({ env });

  return {
    apiKey,
    apiUrl,
    proxy,
    hostname,
    debug,
    enabled,
    minIntervalSeconds,
    idleTimeoutMinutes,
    entityType,
    category,
    projectFromCwd,
    includeSubagentSessions,
    language,
    userAgent,
    stateDir,
    /** 实际读取的 cfg 文件路径（未找到文件时同样给出候选路径，供日志/诊断使用）。 */
    cfgPath: typeof file?.path === 'string' ? file.path : resolveConfigPath({ env }),
  };
}
