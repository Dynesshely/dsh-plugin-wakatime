# WakaTime API v1：本插件实际依赖的契约

本文件不是 WakaTime API 的完整复述，只记录**本插件真的用到**的那部分，以及我们在本机验证过的边界。
实现契约以 [`docs/design.md`](design.md) 为准；本文与 design.md 冲突时，以本文的实测证据为准，并把冲突反馈给 Lead 改 design.md。

## 0. 证据分级

全文用四种记号，请不要混读：

| 记号 | 含义 | 出处 |
|---|---|---|
| **实测** | 本机（Windows / Node v23.3.0 / DeepSeek Harness）真的跑过并看到结果 | 行内注明证据（日志原文、命令、profile 文件等） |
| **文档** | WakaTime 官方页面 | 附链接 |
| **源码** | wakatime-cli / 官方插件仓库源码 | 附 GitHub 链接 |
| **推测** | 由上述证据推断，未直接验证 | 会写清「未验证」 |

官方来源：

- API 文档：<https://wakatime.com/developers>（尤其 Heartbeats、Authentication、Writing your own plugin 三节）
- 插件开发指南：<https://wakatime.com/help/creating-plugin>
- 官方 CLI 源码：<https://github.com/wakatime/wakatime-cli>

## 1. 端点

| 用途 | 方法与路径 | 请求体 | 备注 |
|---|---|---|---|
| 单条心跳 | `POST /api/v1/users/current/heartbeats` | 一个 heartbeat **对象** | 本插件 1 条时用它 |
| 批量心跳 | `POST /api/v1/users/current/heartbeats.bulk` | heartbeat **数组** | 每请求 **最多 25 条**，本插件按 25 切批 |
| 基地址 | `https://api.wakatime.com/api/v1` | — | 插件配置 `apiUrl` 可覆盖（自建网关才需要） |

- **文档**：bulk 端点「limited to 25 per POST request」；示例响应为 `202`；文档同时建议「一般不需要直接调这个端点，应该用 wakatime-cli」。
- **源码**：wakatime-cli 只把 `201` 与 `202` 视为成功（`case http.StatusCreated, http.StatusAccepted`），其余状态一律报错。所以客户端必须把整个 2xx 都当成功。
- **实测**：本机插件发出的单条心跳返回 `201`，日志原文 `POST /users/current/heartbeats → 201（1 条）`（`C:\Users\Dynesshely\.dsh\cache\wakatime-dsh\wakatime.log`，2026-10-27T08:13:55Z）。

为什么直连 API 而不是像官方插件那样调 wakatime-cli：**文档**（<https://wakatime.com/help/creating-plugin>）把官方插件描述为「编辑器插件 + wakatime-cli」两段式——编辑器侧只负责探测活动并调用 wakatime-cli，由 wakatime-cli 探测项目/分支/语言、维护离线库并真正发请求。我们选择直连，代价是自己只有会话目录、项目名与 token 数可用，换来的是没有 Go 二进制、没有下载与自更新逻辑。**这不是官方推荐路径**，属于明确取舍，写在 design.md 里。

## 2. 认证

- **文档**：插件用**只写**（write-only）的 API key，通过 HTTP Basic 认证发送——把 key 原文 base64 后放进 `Authorization`，并在前面加 `Basic`。官方例子：key 为 `12345` 时发 `Authorization: Basic MTIzNDU=`。
- **文档**：也支持 `?api_key=XXX` 查询参数，但**本插件不使用**——key 落到 URL 上，容易被代理日志、访问日志、错误上报留存。
- key 来源：`~/.wakatime.cfg` 的 `[settings] api_key`（**实测**本机该文件与该键都存在；插件只在日志里写「已配置 / 缺失」，不打印、不复制明文）。
- 我们的请求头写法（`lib/client.js`）：

```js
headers.Authorization = 'Basic ' + Buffer.from(apiKey, 'utf8').toString('base64')
```

- 没有 key 时不发请求、插件保持惰性（inert），只记一条 warning，不阻塞 DSH 启动（设计上的硬要求，见 design.md）。
- **文档**：读数据（summaries/stats）要用 OAuth 2.0 access token，API key 只用于上报。本插件不读任何 WakaTime 数据。

## 3. heartbeat 字段

### 3.1 我们发送的字段

| 字段 | 类型 | 本插件 | 说明 |
|---|---|---|---|
| `entity` | string | **必发** | 会话工作目录绝对路径（`entityType: 'app'` 时为应用名）。官方定义：「entity 是对其计时的对象，例如绝对文件路径或域名」 |
| `type` | string | **必发** | 我们只发 `file` 或 `app`。官方允许 `file / app / url / domain` |
| `category` | string | **必发** | 固定 `ai coding`（见第 4 节）。官方说明：通常由 `type` 自动推断，但可显式指定 |
| `time` | float | **必发** | UNIX 秒，可带小数。我们用 `Math.round(ms) / 1000`，最多 3 位小数 |
| `project` | string | 可选 | 会话目录最后一级目录名（`projectFromCwd`，默认开） |
| `language` | string | 可选 | 只有配置了 `language` 才发；不填则完全省略该字段 |
| `ai_session` | string | 可选 | DSH session id，官方定义「AI session id」 |
| `ai_input_tokens` | integer | 可选 | 自上次上报以来该会话的输入 token 增量 |
| `ai_output_tokens` | integer | 可选 | 同上，输出 token |
| `ai_prompt_length` | integer | 可选 | 自上次上报以来你键入的**字符数**（不是 token） |
| `ai_line_changes` | integer | **不发** | 目前不统计行变更；`buildHeartbeat` 支持该字段，但 tracker 不传 |
| `branch` | string | **不发** | 未做 git 探测；官方为可选字段，省略合法 |

**实测**：上述「0 / 空串 / undefined 一律省略、绝不发 null」由 `test/heartbeat.test.js` 覆盖，且真实请求（日志中的 201）即为该 payload 的产物。

### 3.2 官方还有、我们不发的字段

官方 heartbeat POST 还接受：`project_root_count`、`dependencies`、`lines`、`lineno`、`cursorpos`、`is_write`、`human_line_changes`、`ai_subscription_plan`。
**源码**：wakatime-cli 的 `Heartbeat` 结构里还有一个 `ai_cached_input_tokens`（`json:"ai_cached_input_tokens,omitempty"`），官方 POST 文档没有列出它——说明公开文档落后于服务端。本插件不依赖这些字段。

### 3.3 time 的精度与「重复心跳」

- **文档**：`time` 是 float 的 UNIX 时间戳，「小数点后是秒的小数部分」。秒级 + 小数合法。
- **源码**：wakatime-cli 用 `time + cursorpos + entitytype + category + project + branch + entity + is_write` 拼出 `Heartbeat.ID()`，用于本地离线库去重。**推测**：服务端也按这组字段识别「同一条心跳」。我们每次上报的 `time` 不同、`entity`/`ai_session` 固定，因此不会互相覆盖。
- 官方文档**没有**承诺「相同 time 的心跳会被去重」，所以离线补发时宁可重发也不要丢——重复最多导致同一条时间被记两次，丢数据则直接少算时间。

## 4. `category: "ai coding"` 是什么意思

- **文档**：`category` 的合法值包含 `coding, building, indexing, debugging, browsing, running tests, writing tests, manual testing, writing docs, communicating, code reviewing, notes, researching, learning, designing, ai coding`。`ai coding` 就是「用 GenAI 工具写代码」这一类活动的归类。
- **文档**：AI 相关的统计由 `ai_*` 字段 + `category` 一起构成；Leaderboard 甚至有 `board_type=manual`（"Hours Coded excluding AI Coding"），说明 AI 时间是被**单独归类**、可以从人工编码时间里剔除的。
- 由此得到两条实现约束：
  1. `category` 必须是 `ai coding`。若落回默认的 `coding`，这段时间会混进「手写代码」，AI Coding 视图里看不到，人工编码时长还会虚高。
  2. `ai_*` 字段是「**自上次心跳以来的增量**」（文档原文："since the last heartbeat"）。所以本插件在发送成功后清零增量，而不是发累计值；否则一次会话的 token 会被重复计入很多遍。

## 5. User-Agent：编辑器与 OS 从哪来

- **文档**：heartbeat POST 端点说明「Editor and OS are detected from the User-Agent header」。即 dashboard 里「用的是什么编辑器、什么系统」不是请求字段，而是解析 UA 得到的。
- **源码**：wakatime-cli 的 UA 模板是

  ```
  wakatime/<cli 版本> (<OS>-<内核>-<平台>) <运行时版本> <插件名/版本>
  ```

  例（示意，非本机输出）：`wakatime/13.0.6 (Windows-10.0.19045-x86_64) go1.21.0 vscode-wakatime/24.0.0`。
  同一个值还会同时通过 `User-Agent` 头（`WithUserAgent`）与 heartbeat JSON 的 `user_agent` 字段冗余发送；`X-Machine-Name`（主机名，URL 转义）与 `Timezone` 头也是 CLI 的可选头。
- **本插件发的**（`lib/cfg.js` 的 `defaultUserAgent`，**实测**本机格式）：

  ```
  User-Agent: dsh-plugin-wakatime/0.1.0 (Windows-10.0.26200-x64) node/23.3.0
  ```

  形如 `<插件>/<版本> (<OS>-<release>-<arch>) node/<版本>`，**第一个 token 是插件名**，不带 `wakatime/` 前缀，也不冒充 wakatime-cli 或任何编辑器。配置项 `userAgent` 可以整体覆盖。
- **实测**：用这个 UA 直接调 API 能拿到 `201`，说明服务端接受。
- **未验证**：dashboard 的 Editors / OS 视图里究竟显示成什么名字（会不会是 `dsh-plugin-wakatime` 这一条）。自查途径（**文档**）：
  - <https://wakatime.com/plugins/status>
  - `GET https://api.wakatime.com/api/v1/users/current/user_agents`
  - dashboard 的 Editors / Operating Systems 面板
- **推测**：如果实测发现归属不对，最省事的对齐方式是同时按官方 CLI 的做法在 JSON 里带上 `user_agent` 字段；但**先测再改**，不要叠加上去当猜测性修复。

## 6. 错误语义、重试与限流

| 响应 | 本插件语义 | 依据 |
|---|---|---|
| `201` / `202` | 成功 | **文档**（示例为 202）+ **源码**（CLI 只认这两个）+ **实测**（本机 201） |
| `400` | 永久失败，丢弃该批 | **文档**：请求无效，需检查错误信息。响应体可能是 `{errors: {...}}` 或 `{error: "..."}`（**源码**：CLI 两种都解析） |
| `401` | 永久失败，**停止上报**直到配置变化 | **文档** Unauthorized + **源码** `ErrAuth`。本插件置 `disabledReason='unauthorized'`，只记一次错误日志 |
| `403` | 永久失败（丢弃本批），但**不**置 unauthorized | 实现取舍：403 通常是权限/规则问题，重发无意义，但 key 本身有效 |
| `404` | 永久失败 | 文档：资源不存在 |
| `429` | 可重试 | **文档**：限流，要求「任意 5 分钟窗口内平均少于 10 请求/秒」 |
| `5xx` | 可重试 | **文档** Server Error |
| `3xx`（尤其 `302`） | 落到「其它非 2xx」分支 → 永久失败丢弃；若被 fetch 自动跟随，则按最终状态判定 | **文档**：WakaTime 有时用 `302` 代替 `429`（会导致请求超时），建议把请求摊到几分钟里。**未实测**，见下方风险 |
| 网络错误 / 超时 | 可重试，指数退避 | 文档未细化；本插件用 10s `AbortSignal.timeout` + 退避 |

细节：

- `Retry-After` 支持**秒数**与 **HTTP-date** 两种写法，按毫秒回填到下一次发送时间；解析失败则退化为指数退避（`lib/client.js` 的 `parseRetryAfter`，`test/client.test.js` 覆盖）。
- **推测/风险**：Node 原生 `fetch` 默认 `redirect: 'follow'`。若服务端真用 `302` 表达限流，按 fetch 规范 301/302 会把 POST 改写成 GET 跟随，最终可能拿到一个 2xx 而被误判成功（心跳其实没写进去）。目前未在真实 302 下验证；若日后遇到「日志说成功但 dashboard 没数据」，先查这一点（可用 `redirect: 'manual'` 或检查 `response.redirected`）。
- 我们的节流下限比官方严格得多：同一会话两次上报至少 120s（`minIntervalSeconds`），远低于 10 req/s 的限制，正常使用不会触发 429。

## 7. 代理（本机实测过的分歧点）

- **文档/源码**：`~/.wakatime.cfg` 的 `proxy` 是给 wakatime-cli 用的（CLI 支持 HTTPS / SOCKS / NTLM 代理）。**本机 Node 23.3 的原生 fetch 既不读这个键，也不读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。**
- **实测**本机 `~/.wakatime.cfg` 里 `proxy = http://localhost:40404`；同时 `node -e "import('undici')"` 在本机（Node v23.3.0）返回 `ERR_MODULE_NOT_FOUND` —— 仓库和 profile 都没有 `undici`。
- 因此插件的实际行为是：**检测到 proxy → 尝试 `import('undici')` 拿 `ProxyAgent` → 拿不到就记一条 warning 并直连**。日志原文（**实测**）：

  ```
  [warn] 未找到可用的 undici ProxyAgent（ERR_MODULE_NOT_FOUND），代理 http://localhost:40404 已降级为直连
  ```

- **实测**：本机直连 `api.wakatime.com` 可用（心跳 201），所以降级不影响这个环境。但如果某台机器**只能**经代理出网，心跳会失败 → 进离线队列 + 退避重试，日志会反复出现 `heartbeat 暂存待重发`。这属于「功能降级但不静默」。
- 要真正支持代理，可选做法（都**未实现**，仅记录）：
  1. 把 `undici` 变成插件依赖（或让宿主提供），`new ProxyAgent(proxy)` 后作为 `fetch` 的 `dispatcher` 传入——Node 的 fetch 支持该扩展字段；
  2. 自己实现 HTTP CONNECT 转发（SOCKS 需要额外库，纯 Node 不划算）；
  3. 在 Electron 环境里用会话级代理 API——但那属于客户端半边，与 Host 插件不在一个进程。
- 无论哪条路，都要求「代理不可用不致命」：只警告一次、继续直连，与本插件现在的策略一致。

## 8. `~/.wakatime.cfg`：我们只读，且只读四个键

- 位置：Windows 为 `C:\Users\<你>\.wakatime.cfg`；**实测**本机存在。
- **实测**本机内容（已脱敏，`api_key` 值不记录）：`[settings]` 段下 `api_key`、`proxy = http://localhost:40404`、`debug = false`。
- 我们用到的键：`api_key`、`proxy`、`hostname`、`debug`。
- 官方 CLI 认、但我们不用的键（**源码**：CLI 的 flags 与 `--config-read` 使用的键名，如 `--log-file` / `log_file`、`--verbose` / `verbose`、`--exclude` / `exclude`）：`log_file`、`verbose`、`exclude` / `include`、`hide_file_names` / `hide_project_names` / `hide_branch_names`、`plugin`、`api_url` 等。**注意**：`exclude` / `include` 这类过滤规则我们**没有实现**——本插件只上报项目目录，不逐文件上报，所以 dashboard 侧的项目过滤规则仍然有效，但 cfg 里的文件级 exclude 对我们无意义。
- 解析要求（`lib/cfg.js`，`test/cfg.test.js` 覆盖）：BOM、CRLF、`#`/`;` 注释、`=` 两侧空格、键名统一小写、无 section 的键归入 `[settings]`、未知键忽略、文件不存在返回 `{found:false}` 而不是抛错。
- 只读：插件从不写这个文件（用户可能在用别的 WakaTime 插件，写它就是抢地盘）。

## 9. 我们实际发出的请求（脱敏样例）

```
POST https://api.wakatime.com/api/v1/users/current/heartbeats
Authorization: Basic <base64(api_key)>
Content-Type: application/json
Accept: application/json
User-Agent: dsh-plugin-wakatime/0.1.0 (Windows-10.0.26200-x64) node/23.3.0
X-Machine-Name: <hostname>        ← 仅当配置/ cfg 里有 hostname 时才带

{
  "entity": "C:\\Users\\<你>\\Documents\\deepseek-harness\\default-workspace",
  "type": "file",
  "category": "ai coding",
  "time": 1793088756.972,
  "project": "default-workspace",
  "ai_session": "session-25e99778-2905-4580-92df-4488b0096ac5",
  "ai_input_tokens": 1234,
  "ai_output_tokens": 567,
  "ai_prompt_length": 89
}
```

- 字段顺序固定为 `entity, type, category, time`，其后是可选字段（**实测**：`lib/heartbeat.js` 按此顺序构造，单测覆盖）。
- `X-Machine-Name` 不是官方 POST 文档列出的请求字段，而是 **源码**里 wakatime-cli 的 `--hostname` 机制（`WithHostname`，值会做 URL 转义）。我们沿用同样的头，不额外发明字段。
- 多批时改 `POST .../heartbeats.bulk`，body 为数组，每批 ≤ 25 条。

## 10. 未验证清单（别当成结论用）

1. dashboard 的 Editors / OS 面板是否把流量归到 `dsh-plugin-wakatime` 名下（只有返回码实测过）。
2. 服务端对重复 `time` 的处理（官方文档无承诺，代码里只有 CLI 侧去重）。
3. 真实 `302` 限流下 Node fetch 的最终表现（见第 6 节的推测）。
4. `429` 时服务端是否真的带 `Retry-After`（代码支持两种写法，但没有真实 429 样本）。
5. 代理可用时的完整链路（本机没有 undici，无法验证 `ProxyAgent` 分支）。
