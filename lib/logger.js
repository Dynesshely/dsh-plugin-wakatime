/**
 * 可选的诊断日志。
 *
 * DSH 的 Host 进程不会把插件内的 console 输出稳定地留给用户，所以插件把关键事件
 * 写进自己的日志文件（默认目录由 `lib/cfg.js` 的 stateDir 决定）。日志始终只记录
 * 计数、路径、状态码，**绝不记录** api_key、提示词正文或代码内容。
 *
 * 日志文件达到上限时轮转为 `<file>.1`，只保留一代，避免无限增长。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 256 * 1024

/**
 * @param {object} options
 * @param {string} options.file      日志文件绝对路径。
 * @param {boolean} [options.debug]  是否写入 debug 级日志。
 * @param {object} [options.sink]    可注入的写入端（测试用），需实现 write(line)。
 * @returns {{ info: (message: string) => void, warn: (m: string) => void, debug: (m: string) => void, error: (m: string) => void, lastError: () => string | undefined }}
 */
export function createLogger({ file, debug = false, sink }) {
  let lastError
  let usable = true

  function ensureDir() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      return true
    } catch {
      return false
    }
  }

  function rotateIfNeeded() {
    try {
      if (statSync(file).size < MAX_BYTES) return
      renameSync(file, `${file}.1`)
    } catch {
      // 文件不存在或无法轮转：忽略，继续尝试追加。
    }
  }

  /**
   * @param {'info'|'warn'|'error'|'debug'} level
   * @param {string} message
   */
  function write(level, message) {
    if (level === 'debug' && !debug) return
    if (level === 'error') lastError = message
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    if (sink) {
      try {
        sink.write(line)
      } catch {
        // 注入端失败不影响插件工作。
      }
      return
    }
    if (!usable) return
    if (!ensureDir()) {
      usable = false
      return
    }
    try {
      rotateIfNeeded()
      appendFileSync(file, line, 'utf8')
    } catch {
      usable = false
    }
  }

  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => write('debug', message),
    lastError: () => lastError,
  }
}
