# dsh-plugin-wakatime 设计契约（Lead 定稿）

本文件是团队协作的唯一实现契约。接口签名、文件职责、行为语义以此为准；如与调研结论冲突，以 `docs/wakatime-api.md` / `docs/harness-api.md` 的实测证据为准，并同步告知 Lead 修改本文件。

## 目标

DeepSeek Harness（DSH）Host 侧插件。把用户「使用 AI 进行 coding」的时长，按 WakaTime 官方插件的方式，以 `category: "ai coding"` 的 heartbeat 上报到 WakaTime API v1，从而计入 WakaTime 的 AI Coding 统计。

非目标（本期不做）：Client/Web UI 面板、模型可见工具的复杂查询、OAuth、非 WakaTime 后端。

## 仓库结构

```
package.json              # bundle 清单（dsh.bundle.patch）
cordis.patch.yml          # Loader patch：insert wakatime 行
index.js                  # Host 插件入口：Config + apply(ctx, config)
icon.svg                  # 插件图标（原创）
locale/en.json            # meta.title / meta.description
locale/zh.json
lib/cfg.js                # ~/.wakatime.cfg 解析 + 配置解析（纯函数，可单测）
lib/heartbeat.js          # heartbeat 构造（纯函数，可单测）
lib/client.js             # HTTP 客户端：认证、单发/批量、重试、代理
lib/queue.js              # 持久化离线队列（原子写）
lib/tracker.js            # DSH 事件 → 活动状态 → heartbeat 调度
lib/state.js              # 运行状态（当日计数、最近错误）供日志/诊断用
lib/logger.js             # 可选 debug 文件日志
test/*.test.js            # node:test 单测（不依赖 DSH 运行时）
README.md LICENSE .gitignore .gitattributes
docs/                     # 调研与设计
```

约定：ESM（`"type": "module"`），`lib/*.js` 均为 ESM。唯一运行时依赖是 `@deepseek-ai/schemastery`（DSH 用来声明与投影插件 Config 的 schema 库；用 zod 声明会被判为 `unsupported`，实测见 `docs/harness-api.md`）。测试用 `node --test`（Node >= 20，本机 v23）。因为 `install_bundle` 对本地目录是「软链安装」，不会代装依赖，所以首次安装前必须在仓库根目录执行 `pnpm install`；安装/升级后需要重启 DSH 才能加载新的 Host 代码。

## 配置解析（lib/cfg.js）

```js
/** 解析 INI 文本 → { sections: { [section]: { [key]: string } } }。容错：BOM、CRLF、注释(#/;)、= 两侧空格、键名小写、无 section 的键归入 settings。 */
export function parseIni(text) {}

/** 读取 ~/.wakatime.cfg（默认路径可用 opts.cfgPath 覆盖）。文件不存在/不可读 → 返回 { found:false }，绝不抛错。 */
export async function readWakaTimeConfig({ cfgPath, homeDir = os.homedir(), env = process.env } = {}) {}

/** 合并插件 config 与 cfg 文件，得到最终运行配置（见下）。 */
export function resolveSettings({ file, config = {}, env = process.env }) {}
```

resolveSettings 输出：

```js
{
  apiKey: string | undefined,       // cfg [settings].api_key（插件 config.apiKey 优先）
  apiUrl: string,                   // 默认 https://api.wakatime.com/api/v1
  proxy: string | undefined,        // cfg [settings].proxy
  hostname: string | undefined,     // cfg [settings].hostname 或 os.hostname()
  debug: boolean,                   // cfg [settings].debug === 'true'
  enabled: boolean,                 // 插件 config.enabled，默认 true
  minIntervalSeconds: number,       // 两次 heartbeat 最小间隔，默认 120，范围 10..900
  idleTimeoutMinutes: number,       // 超过该空闲时间不再续算/清空待发增量，默认 15（WakaTime 官方 keystroke timeout）
  entityType: 'file' | 'app',       // 默认 'file'
  category: string,                 // 默认 'ai coding'
  projectFromCwd: boolean,          // 默认 true：用 cwd basename 作为 project
  includeSubagentSessions: boolean, // 默认 false：子代理会话不单独计数，避免同一墙钟时间重复计入
  language: string | undefined,     // 默认 undefined（不上报 language）
  userAgent: string,                // 固定：见 wakatime-api.md
  stateDir: string                  // 队列/日志/状态文件目录
}
```

stateDir 规则：`process.env.DSH_HOME` 存在 → `<DSH_HOME>/cache/wakatime-dsh`；否则 `<os.homedir()>/.dsh/cache/wakatime-dsh`；目录不可创建时退化为 `os.tmpdir()/wakatime-dsh`。

## heartbeat 构造（lib/heartbeat.js）

```js
/**
 * @param {object} input
 * @param {number} input.time              // 毫秒 epoch；构造时按秒（含小数）输出
 * @param {string} input.entity            // 项目绝对路径（session cwd）
 * @param {'file'|'app'} input.type
 * @param {string} input.category          // 'ai coding'
 * @param {string} [input.project]
 * @param {string} [input.branch]
 * @param {string} [input.language]
 * @param {string} [input.aiSession]       // session id
 * @param {number} [input.aiInputTokens]   // 本次 heartbeat 之前累计的输入 token
 * @param {number} [input.aiOutputTokens]
 * @param {number} [input.aiPromptLength]  // 用户本轮/本段时间键入的字符数
 * @param {number} [input.aiLineChanges]
 * @returns {object} WakaTime heartbeat JSON（字段名严格按 API）
 */
export function buildHeartbeat(input) {}
```

规则：`time` 秒级（`Math.round(ms)/1000`，保留 3 位小数）；数值字段为 0 或无意义时**省略**，不要发 0/undefined；`project` 为空则省略；字符串去首尾空白。禁止输出 null 字段。

## HTTP 客户端（lib/client.js）

```js
export function createClient({ apiKey, apiUrl, proxy, hostname, userAgent, fetchImpl = fetch, logger, timeoutMs = 10000 }) {
  return {
    /** 单批 ≤ 25 条；返回 { ok, status, retryAfterMs?, error?, sent:number } */
    async sendBatch(heartbeats) {},
    /** 便捷：按 25 条切批发送，遇 4xx(非 401/429) 视为永久失败，返回汇总 */
    async send(heartbeats) {},
  }
}
```

语义：
- 认证 `Authorization: Basic base64(apiKey)`（base64 的是 api_key 原文，UTF-8）。不使用 `?api_key=`。
- 端点：1 条 → `POST {apiUrl}/users/current/heartbeats`；多条 → `POST {apiUrl}/users/current/heartbeats.bulk`，每批最多 25 条。
- 头：`Content-Type: application/json`、`User-Agent: <userAgent>`。
- 2xx（201/202）→ ok。401 → 永久失败并置 `disabledReason='unauthorized'`（调用方停止重试直到配置变化）。429/5xx/网络错误 → 可重试，`retryAfterMs` 优先取 `Retry-After` 头（秒或 HTTP 日期），否则指数退避。
- 请求超时用 `AbortSignal.timeout`。
- 代理：`proxy` 存在时按 `docs/wakatime-api.md` 的结论实现（优先 undici ProxyAgent；不可用时记录告警并直连，不影响基本功能）。
- 不得抛出未捕获异常：所有错误转为返回值。

## 持久化队列（lib/queue.js）

```js
export function createQueue({ file, maxEntries = 500, logger }) {
  return {
    async load(),               // 启动时读盘，损坏文件改名后从空队列开始
    async push(heartbeats),     // 追加并落盘（原子：写 tmp + rename）
    async drain(n = 25),        // 取队首 n 条（不删除）
    async commit(n),            // 成功后删除前 n 条并落盘
    async drop(n),              // 永久失败丢弃前 n 条
    size(),
  }
}
```

## 追踪器（lib/tracker.js）

```js
export function createTracker({ ctx, settings, client, queue, logger, state, now = Date.now }) {
  return { start(), stop(), status() }
}
```

行为：
1. `start()` 注册 `ctx.on('session/event', onSessionEvent)`、`ctx.on('session/disposed', ...)`（清理该会话状态）、以及一个 `setInterval`（15s）定时冲刷（用 `ctx.effect` 注册清理），返回 dispose。定时器承担两件事：回合进行中（`turn/start` 后未见 `turn/end`）且未超过空闲阈值时保持心跳，避免长回合出现超过 WakaTime keystroke timeout 的空档；排空离线队列。
2. 事件映射（`event.time` 单位必须是毫秒；若调研发现是秒则换算）：
   - `user/message`：用户提示 → 累计 `promptLength += 文本块字符数`，标记活动。
   - `assistant/message`：若有 `usage` 则累计 `inputTokens += usage.inputTokens`、`outputTokens += usage.outputTokens`；标记活动。
   - `tool/call` / `tool/result`、`turn/start`、`turn/end`：标记活动（不累计 token）。
   - 其它事件忽略。
3. 会话过滤：`session.header.parentSession` 存在（子代理）且 `includeSubagentSessions === false` → 忽略；否则按会话独立计时。
4. 发送条件（每会话）：该会话有「活动」且 `now - lastSentAt >= minInterval`；或距上次活动 ≥ idleTimeout 且有待发增量 → 立即冲刷一次；`turn/end` 后若待发增量存在且间隔 ≥ minInterval 可发送。
5. heartbeat 内容：entity = `session.header.cwd ?? ctx.workingDirectory.get(session)`（如果都拿不到则跳过该会话并记一次告警；`entityType: 'app'` 时 entity 换成应用名 `DeepSeek Harness`）；project = basename(cwd)（`projectFromCwd`）；aiSession = session.id；aiInputTokens/aiOutputTokens/aiPromptLength 为该会话「自上次发送以来的增量」，发送后清零。
6. 发送失败：可重试 → `queue.push` 并进入退避（下次发送 `max(minInterval, retryAfterMs)` 后）；永久失败 → 丢弃并记日志（401 时只记一次）。
7. `status()` 返回：`{ enabled, apiKeyConfigured, sessionsTracked, heartbeatsSentToday, lastHeartbeatAt, lastError, queueSize, disabledReason }`。

## 入口（index.js）

```js
export const name = 'wakatime'
export const Config = Schema.object({ /* @deepseek-ai/schemastery，见 index.js */ })
export function apply(ctx, config) { ... }
```

`apply` 内：解析配置 → 无 apiKey 时记一次性告警并保持 inert（不报错、不阻塞 DSH 启动）→ 创建 client/queue/tracker → `ctx.effect(() => tracker.start())`。本版不注册模型可见工具，诊断信息写入状态目录的 `wakatime.log`。

## 测试要求（test/）

- `cfg.test.js`：INI 解析容错（BOM/CRLF/注释/空格/无 section/未知键）、文件不存在、插件 config 覆盖文件。
- `heartbeat.test.js`：字段名/类型/单位、0 值省略、time 精度、entity 规范化。
- `client.test.js`：用本地 `node:http` 假服务器验证 Basic 认证头、UA、单发 vs 批量切分、25 条上限、201/202/401/429/500 映射、Retry-After 解析、超时。
- `queue.test.js`：追加/读取/提交/丢弃/损坏文件恢复/上限淘汰。
- `tracker.test.js`：用伪 ctx 与假 client 验证：user/message 累计 promptLength、assistant/message 累计 token、最小间隔节流、idle 冲刷、子代理会话被忽略、缺 cwd 跳过、401 后停止重试。

全部测试 `node --test` 通过；不得 require DSH 运行时。

## 交付与边界

- 不执行 `git commit` / `git push`（用户未要求）。
- 不修改 profile 的 package.json / cordis.patch.yml（安装由 Lead 用 plugin_manager 完成）。
- 文档与注释中文，代码标识符英文。
