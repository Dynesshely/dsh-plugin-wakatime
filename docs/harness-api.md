# DSH Host 插件契约：本机实测记录

记录 dsh-plugin-wakatime 作为 **Host 侧插件**在 DeepSeek Harness（下称 DSH）里真实遇到的契约：
怎么写、怎么装、怎么观察、哪些地方与直觉不同。

环境（除特别说明外，本文的「实测」都在这个环境里得到）：

- DSH 桌面运行时 `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.3**（`resources/app.asar/dsh/package.json`），Web GUI `http://127.0.0.1:51111`
- Cordis `4.0.5`，profile：`C:\Users\Dynesshely\.dsh\profiles\desktop`
- Node **v23.3.0**（DSH 自带）
- 插件仓库：`D:\Projects\Dynesshely\dsh-plugin-wakatime`

记号同 [`docs/wakatime-api.md`](wakatime-api.md)：**实测** / **源码** / **文档** / **推测**。

## 1. bundle 形态：一个包 = 一个 patch 文件

一个可安装的 DSH bundle 由两样东西组成（**实测**，本仓库即此形态）：

`package.json`：

```json
{
  "type": "module",
  "main": "index.js",
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: wakatime                     # 行 id，profile 里覆盖该行靠它
      name: dsh-plugin-wakatime        # 包名（Node 解析用）
      config: {}                       # 该行的配置，原样传给 apply
```

要点：

- patch 文件顶层是**数组**，每项是一个 patch 条目；`insert` 里可以放多行。**源码**（`@deepseek-ai/dsh-base/cordis.patch.yml` 顶部注释）：`A patch replaces the targeted row's whole config rather than merging into it` —— patch 是**整体替换**目标行的 `config`，不做深合并。这条决定了「默认值不会被合并进 config 对象」（见第 3 节）。
- `id` 是行 id，`name` 是包名。profile 的 `cordis.patch.yml` 里 `- id: <行 id>` 是覆盖既有行，`- insert:` 是追加新行（**实测**：本机 profile patch 里 `insert` 了 `mcp-library` 行，并用 `- id: dsh-context` 覆盖已装插件的配置）。
- 插件包可以带 `exports`（本仓库导出 `./icon`、`./locale/*.json`），用于 Plugin Manager 的图标与 locale 展示；这不影响加载。

安装完成后，profile 里能看到三处痕迹（**实测**）：

| 位置 | 内容 |
|---|---|
| `~/.dsh/profiles/desktop/package.json` → `dependencies` | `"dsh-plugin-wakatime": "link:D:/Projects/Dynesshely/dsh-plugin-wakatime"` |
| 同文件 → `dsh.profile.bundles` | 数组里多出 `"dsh-plugin-wakatime"` |
| `~/.dsh/profiles/desktop/node_modules/dsh-plugin-wakatime` | 指向仓库目录的链接（Target = `D:\Projects\Dynesshely\dsh-plugin-wakatime`） |

`link:` 这个前缀是第 6 节那个大坑的根源。

## 2. Host 插件入口：`name` / `Config` / `apply`

index.js 的形态（**实测**：本仓库即此形态，且本机加载成功、日志出现「插件已装配」）：

```js
import Schema from '@deepseek-ai/schemastery'

export const name = 'wakatime'               // 与 patch 行 id 一致

export const Config = Schema.object({        // 必须是 schemastery，不能是 zod
  enabled: Schema.boolean().default(true).description('是否启用。'),
  // ...
})

export function apply(ctx, config) {
  ctx.effect(() => {
    // 同步注册清理逻辑；异步初始化在内部自己收尾
    return () => { /* dispose */ }
  })
}
```

约定与踩坑：

- `apply(ctx, config)` **同步**执行；`ctx.effect(fn)` 也是同步注册的。异步初始化（读配置文件、建目录、`await` 网络）必须自己塞进 `ctx.effect` 的回调里管理，否则插件卸载时没人清理。本插件的做法：`ctx.effect(() => { void bootstrap(...).then(stop => { ... }); return cleanup })`，用一个 `disposed` 标志处理「异步装配完成时插件已被卸载」的竞态。
- `apply` 里**不要抛异常**。插件装配失败不应拖垮宿主：本插件把整个 bootstrap 包在 try/catch 里，失败只写一条日志并保持 inert。
- `export const inject = [...]` 是可选的依赖声明（例如注册模型可见工具时需要 `tools`）。本插件**不注册工具**，所以没有 `inject`；`inject` 的确切语义（缺失时插件是否延迟激活）**未验证**。

## 3. Config 必须用 `@deepseek-ai/schemastery`

这是本项目最容易踩、也最不直观的一条。

- **实测**（Lead 探针）：`Config` 用 **zod** 声明时，`Config.listConfigs` 返回 `status = "unsupported"`，Plugin Manager / Settings 里没有可用的配置表单；把同一个 schema 换成 **schemastery** 后，同一位置返回 `status = "schema"`，表单正常投影。
- 原因（**推测**）：宿主用 schemastery 的 schema 直接投影成表单并校验，zod 的 schema 对象没有对应的投影器。结论本身是实测的，判定细节未验证。
- 版本：本机 `@deepseek-ai/dsh-tools` 的依赖里是 `@deepseek-ai/schemastery ~3.18.5`（**源码**），本仓库声明 `^3.18.4`。
- 依赖来源：**宿主不替被 link 的插件提供 schemastery**。本机 profile 的 `node_modules` 下没有 `@deepseek-ai/` 目录（**实测**），所以插件只能在仓库里自己装（见第 6 节）。

`config` 的三个实测结论：

1. patch 里的 `config` 会**原样**传给 `apply`，schemastery 的 `.default(...)` **不会**被合并进这个对象。所以插件必须自己兜 `undefined`（本插件所有读取点都带默认值，例如 `settings.minIntervalSeconds ?? 120`）。
2. `config: {}` 能通过校验，前提是**每个字段都有 default**（本仓库如此）。
3. 配置真的生效：把行配置改成 `debug: true` 前后，日志从只有 `[info]` 变成出现 `[debug] POST /users/current/heartbeats → 201（1 条）`（**实测**，同一份日志里三段装配分别对应 `debug=false` / `debug=false` / `debug=true`）。

本插件实际的 14 个键见 README 的配置表；`Config` 里字符串型覆盖项默认 `''`，语义是「留空 = 回退到 `~/.wakatime.cfg` 或内置默认值」。

## 4. 事件：`ctx.on('session/event', (session, event) => …)`

- **实测**：`ctx.on('session/event', handler)` 可用，handler 拿到 `(session, event)`。本插件的 heartbeat（日志 `heartbeat ok`）就是被这条通道驱动的。
- **实测**：`event.time` 是**毫秒** epoch。探针记录到 `1793088756972`，换算为 `2026-10-27T08:12:36.972Z`，与同一刻日志行 `2026-10-27T08:12:36.981Z` 对得上 —— 若当成秒会跑到 5 万年后，所以必须按毫秒用。（本插件另做了 `value < 1e12 → 乘 1000` 的容错，防上游改单位。）
- **实测**，`event.type` 至少包含：

  | 类型 | 我们能拿到的东西 |
  |---|---|
  | `user/message` | 用户消息；`data.message.content` 是块数组，文本块为 `{type:'text', text}` |
  | `assistant/message` | `data.usage = { inputTokens, outputTokens, totalTokens }`；`data.message.content` 是块数组（`reasoning` / `tool-call` / `text`） |
  | `tool/call` / `tool/result` | 工具调用与结果 |
  | `turn/start` / `turn/end` | 轮次边界 |
  | `step/start` / `step/end` | 步边界 |
  | `job/registered` 等 | **同一通道上也会混进非会话事件**，必须 `default:` 忽略，不要假设 `event.type` 只有会话事件 |

- **实测**：`ctx.on` 返回一个 dispose 函数（本插件在 `stop()` 里逐个调用）。插件卸载时该 dispose 是否一定被调用，**未单独验证**。
- 一个实现细节：`ctx.on` 的回调里做 IO 要自己兜异常。本插件把每条事件的处理都包在 try/catch 里，事件回调抛异常会把宿主日志刷爆。

## 5. 会话元数据：cwd 与子代理

- **实测**：`session.header.cwd` 是会话工作目录（绝对路径），本机每个会话都有值，这就是 heartbeat 的 `entity`。
- `ctx.workingDirectory.get(session)` 是兜底路径（`@deepseek-ai/dsh-working-directory` 包存在，服务名推测为 `workingDirectory`）。本机从未触发这条兜底，**未验证**其返回值形态；本插件把它包在 try/catch 里，取不到就当「没有 cwd」跳过该会话并记一次告警。
- **实测**（口径来自探针）：识别子代理会话用 `session.header.parentSession` 存在，或 `session.header.origin === 'subagent'`。本插件默认**不单独统计**子代理会话——同一段墙钟时间主会话已经在计时，两处都上报会把时间算两遍。
- `ctx.on('session/disposed', handler)` 也在用（清理该会话的运行时状态）；本机未观察到它被触发的日志，**未验证**触发时机。

## 6. 安装、升级与热更新（最容易翻车的一节）

### 6.1 装

`plugin_manager` 的 `install_bundle`，`target` 用**仓库绝对路径**（`D:\Projects\Dynesshely\dsh-plugin-wakatime`）。结果是 pnpm 的 `link:`，也就是：

- 只做**软链**，**不会安装插件自己的 `dependencies`**；
- 插件里的 `import '@deepseek-ai/schemastery'` 从**仓库自己的 `node_modules`** 解析。

所以顺序必须是：

```powershell
cd D:\Projects\Dynesshely\dsh-plugin-wakatime
pnpm install          # 或 npm install；唯一依赖是 @deepseek-ai/schemastery
# 然后才 install_bundle
```

- **实测**：仓库里跑过 `pnpm install` 后，`node_modules/@deepseek-ai/schemastery` 存在，`node -e "import('@deepseek-ai/schemastery')…"` 正常；而 `node -e "import('undici')…"` 返回 `ERR_MODULE_NOT_FOUND`（本机 Node 23.3.0 不自带可 import 的 undici）。
- **实测**（Lead 的 zod 探针）：仓库没装依赖时直接 link 安装，插件 import 依赖会 `ERR_MODULE_NOT_FOUND` —— 这就是「link 不装依赖」的实证。新版 pnpm 出于安全默认不执行依赖的构建脚本，但 schemastery 是纯 JS，不需要构建脚本。

安装返回值的语义（**实测**）：`application = "applied"` 表示改动已写进 profile 并生效到该层；`application = "failed"` 时看 `error.diagnostic`，通常是 pnpm 解析/网络问题或包名/路径不对。

### 6.2 热更新：没有

- **实测**：在 linked 目录里改 `index.js`，**不会**重新加载；重复 install / remove 也不会换新的模块代。因为 Node 的 ESM 模块缓存不会失效，而 DSH 的 HMR 只覆盖 profile 配置层——**源码**佐证：`@deepseek-ai/dsh-base/cordis.patch.yml` 里 `hmr` 行的配置是 `root: []`，意思是「不额外监视模块根」。
- **实测**：同一份日志里出现三段「插件已装配」，分别对应 `debug=false` / `false` / `true` 三种行配置——说明每次重启都会重新装配，且配置改动只有重启后才生效。
- 结论：**装完/改完必须重启 DSH**；刷新页面只重载 Client 半边，对 Host 代码无效。

### 6.3 卸

`remove_bundle`（包名 `dsh-plugin-wakatime`），或从 profile 的插件列表移除。

- **实测**：profile 的 `node_modules` 里能看到历史安装残留（`dsh-probe-wakatime`、`dsh-probe2-wakatime`、`dsh-plugin-wakatime-verify` 之类探针包名的软链）。判断「装没装」要看 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`，不要看 `node_modules` 里有没有目录。
- 卸载后同样需要重启才会停止计时。

## 7. 生命周期与定时器：优先用 `ctx.interval`

- **源码**：`@deepseek-ai/dsh-base/cordis.patch.yml` 里有 `- id: timer, name: '@deepseek-ai/cordis-plugin-timer'`，默认启用。该服务把 `timeout / interval / throttle / debounce / setTimeout / setInterval` **mixin 到 Cordis 上下文**，且内部都用 `ctx.effect` 注册清理（`cordis-plugin-timer/lib/index.js`）。
- 也就是说 Host 插件上下文里应当有 `ctx.interval(cb, ms)`、`ctx.timeout(cb, ms)`，随插件卸载自动 `clearInterval`。**推测**：本机未在插件代码里实际调用过这两个方法；服务行在 base patch 里存在是源码事实。
- 本插件当前用**裸 `setInterval` + `timer.unref()` + stop 里 `clearInterval`**（15s tick），与 design.md 一致、也不依赖宿主服务；若要更贴 Cordis 契约，可换成 `ctx.interval(tick, 15000)`，由 fiber 自动清理（**建议**，未改代码）。
- `ctx.effect(fn)` 是唯一的清理登记点：`fn` 里同步建立资源并返回 dispose；异步建立的资源要按第 2 节的写法自己收尾。

## 8. 日志：Host 插件自己落盘

- 本插件**不依赖** `ctx.logger`（是否存在未验证），自带文件日志：
  - 目录：`<DSH_HOME>/cache/wakatime-dsh`；没有 `DSH_HOME` 时 `~/.dsh/cache/wakatime-dsh`；建不出来退化到系统临时目录（**实测**本机为 `C:\Users\Dynesshely\.dsh\cache\wakatime-dsh`）。
  - 文件：`wakatime.log`，**实测**内容形如：

    ```
    2026-10-27T08:13:54.318Z [info] WakaTime 上报已启动：间隔 120s，空闲 15min，子代理会话不计入
    2026-10-27T08:13:54.319Z [info] 插件已装配：cfg=... apiKey=已配置 queue=0 debug=true
    2026-10-27T08:13:54.334Z [warn] 未找到可用的 undici ProxyAgent（ERR_MODULE_NOT_FOUND），代理 http://localhost:40404 已降级为直连
    2026-10-27T08:13:55.814Z [debug] POST /users/current/heartbeats → 201（1 条）
    2026-10-27T08:13:55.815Z [info] heartbeat ok project=default-workspace session=session-... tokens=0/0 prompt=0
    ```

- 观察方式（Windows）：`Get-Content -Force -Tail 40 C:\Users\<你>\.dsh\cache\wakatime-dsh\wakatime.log`。
- 为什么不 `console.log`：Host 跑在桌面应用进程里，stdout 是否可取决于怎么启动的（**推测**，本机未验证 GUI 模式下 stdio 去向）。落盘至少保证用户能自查。
- 隐私要求：日志**不得**写 `api_key` 明文。本插件只写「已配置 / 缺失」，代理地址会脱敏成 `http://localhost:40404` 这种无凭据形式（**实测**）。

## 9. 注册模型可见工具（未实现，未验证）

design.md 里把「注册只读工具 `wakatime_status`」列为可选，最终**没有实现**：改为落盘的 `status()` 与日志。因此本文无法给出可信的 `tools.register` 签名与 scope 结论 —— 相关包是 `@deepseek-ai/dsh-tools`（**源码**：其 `package.json` 描述为 "Tool registry and execution pipeline"），但工具注册的确切 API、工具在哪个 scope 可见、`inject: ['tools']` 是否必需，**都需要单独做一次探针**，不要照着猜写代码。

## 10. 参考：profile 里已有的插件 dsh-context

**实测**（`~/.dsh/profiles/desktop/node_modules/dsh-context/package.json`）：

- `"dependencies": { "zod": "^4.4.3" }`
- `"peerDependencies": { "@deepseek-ai/schemastery": "^3.18.2" }`
- 它是以 `file:`（tarball）装的，不是 `link:`；自带的 `cordis.patch.yml` 是 `- insert: [{ id: dsh-context, name: dsh-context }]`

启示（**推测**，值得考虑但不阻塞）：把 schemastery 写成 `peerDependencies` 更贴近 DSH 生态——它是宿主侧库，插件不该自带一份；但本机实测 profile 的 `node_modules` 里并没有 `@deepseek-ai/schemastery`，所以「宿主是否总能提供」尚未确认。本插件当前用 `dependencies` 自装，在 `link:` 安装下要求仓库先 `pnpm install`，行为是可解释的。

## 11. 已知坑汇总

| 坑 | 现象 | 处置 |
|---|---|---|
| `link:` 不装依赖 | 插件 import 依赖 `ERR_MODULE_NOT_FOUND`，插件 inert | 仓库先 `pnpm install`，再装 bundle，再重启 |
| Config 用 zod | Plugin Manager 里没有配置表单（`status="unsupported"`） | 换 `@deepseek-ai/schemastery` |
| 以为默认值会合并 | `config` 里只有显式写出的键，`undefined` 到处跑 | 插件自己兜默认值 |
| 改代码没反应 | 改完 `index.js` 行为不变 | 重启 DSH；HMR 不覆盖被 link 的模块 |
| 刷新页面 | 以为就等于重启 | 只重载 Client 半边，Host 不变 |
| 事件通道混杂 | 收到 `job/registered` 之类非会话事件 | `switch` 的 `default` 必须忽略 |
| `event.time` 当秒用 | 时间戳跑到几万年后 | 按毫秒处理，或做 `<1e12` 容错 |
| 看 `node_modules` 判断是否安装 | 卸载后残留软链仍在 | 看 profile `package.json` 的 `dependencies` / `bundles` |
| 子代理重复计时 | 同一段时间被算两遍 | 默认忽略 `header.parentSession` / `origin === 'subagent'` |

## 12. 与 design.md 的偏差（需 Lead 决定是否回写）

1. design.md 的入口示例写的是「`Config` = zod schema，见 docs/harness-api.md」——**实测**必须 schemastery；本仓库 index.js 已经是 schemastery，本轮已把 README 的说法对齐，README 里「运行时零第三方依赖」也随之删除。
2. design.md 提到「`ctx.timer` 是否存在」——**源码**显示 `ctx.interval` / `ctx.timeout`（timer 服务默认挂载）可用，但当前实现用的是裸 `setInterval`；不影响正确性，只是少了一处「随 fiber 自动清理」的好处。
3. design.md 里的可选工具 `wakatime_status` 未实现（见第 9 节），当前诊断走 `lib/state.js` + 日志文件。
4. design.md 写 `export const inject = ['tools']`——现状没有 `inject`（不注册工具），两处并不矛盾，但 design.md 的示例容易让人以为必须有 `inject`。
