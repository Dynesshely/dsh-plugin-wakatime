# Web 页面「使用时间」实现笔记（v0.2）

本文只记录 Client 半边（`client.js`）的实现要点、依赖契约与验证结果。契约唯一来源是
`docs/design.md` 末尾「## v0.2：Web 页面「使用时间」」。

## 交付文件

| 文件 | 改动 |
| --- | --- |
| `client.js` | 新建。纯 JS，无构建、无第三方依赖，React 从 `require('react')` 取。 |
| `package.json` | 只加两处：`exports["./client"] = "./client.js"`、`dsh.client = { platform: "web", immediately: true }`。 |
| `docs/ui-notes.md` | 本文件。 |

未触碰 `index.js`、`lib/**`、`test/**`、`README.md`、`docs/design.md`、`locale/*.json`、`icon.svg`、
`cordis.patch.yml`；未执行 `git commit` / `git push`。

## 注册方式

模块格式与 `plugins/session-notifier/client.js`、官方模板 `templates/decoration/client.js` 一致：

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-wakatime',          // 必须等于包名（graph 行 id 即包名）
  factory(require) { /* … */ return { inject: ['slots', 'locale'], apply } },
})
```

`apply(ctx)` 内：

1. `ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-wakatime: dictionaries')`，
   `const t = ctx.locale.bind(NS)`。
2. `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'wakatime-usage', locale: NS }, UsagePanel))`
3. `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'wakatime-usage', order: 21, locale: NS, label: () => t('panel.title') }, UsagePanelIcon))`

两处注册各自 `try/catch`，任意一处失败只留一条 `console.warn`，不会让另一处失效。

一处**与任务描述不同、以真实实现为准**的细节：注册项里的 `locale` 参数是
**locale 命名空间字符串**（`'dsh-wakatime'`），不是 `ctx.locale` 服务对象。依据是
`dsh-context/lib/client.js` 的 `slots.register({ name: 'sidebar.panellist', id: oc, order: 20, label: () => r('ov.title'), locale: i })`，
其中 `i` 是传入的 ns 字符串 `oc = 'dsh-context'`；`session-notifier` 同样写 `locale: NS`。
`sections` 注册的参数名也是 `key`（main）与 `id`（sidebar.panellist），二者不可互换。

图标组件签名 `({ size, active })`：`size` 为数值（缺省回退 18），`active === true` 时描边用
`--dsw-alias-brand-primary`，否则 `--dsw-alias-label-secondary`。图形是自绘的线性秒表（表盘 + 表冠 +
右侧计时按钮）加盘内终端提示符 `>` 与光标，32×32 网格，`stroke="currentColor"` 的等价写法是直接
给 `stroke` 赋主题变量。

## 页面用到的数据契约字段

只请求 `GET /wakatime/usage.json`（`fetch(..., { cache: 'no-store' })`，Host 侧响应头另有
`Cache-Control: no-store`，因此每次点「刷新」都会真正重新取）。

- `generatedAt`
- `plugin.version` / `plugin.enabled` / `plugin.category` / `plugin.minIntervalSeconds` / `plugin.idleTimeoutMinutes`
  （显示为标题下的元信息 chips；`enabled === false` 时追加醒目的停用 chip）
- `local.today.{date, seconds, heartbeats, inputTokens, outputTokens, promptChars, sessions}`
- `local.weekSeconds` / `local.totalSeconds` / `local.sessionsTracked`
- `local.days[].{date, seconds}`（取最近 7 条；今天由 `local.today.date` 判定并高亮）
- `local.projects[].{name, seconds}`（取前 5，按最大值归一画比例条）
- `wakatime.apiKeyConfigured` / `hostname` / `queueSize` / `lastSentAt` / `lastError` / `disabledReason`
- `wakatime.today.{categorySeconds, heartbeats, fetchedAt, error}`（`error` 存在时该格改为错误文案 + 错误色）

所有字段都做了类型/缺省容错（`toNumber` / `toText`），Host 少给字段只降级不崩。

## 视觉与主题

颜色全部走主题令牌，没有写死色值；深浅色由宿主变量自己适配：

`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-border-l1`、
`--dsw-alias-border-l2`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、
`--dsw-alias-brand-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary`、
`--dsw-alias-state-warn-primary`。

「未配置 key」与「上报暂停」两条提示条用 `color-mix(in srgb, var(--dsw-alias-state-*) 10%…)` 做底，
透明混合不引入新色。页面样式全部是内联 React `style` 对象，**没有注入全局 CSS**，卸载即消失。

## 文案与格式化

locale 命名空间 `dsh-wakatime`，`zh` / `en` 两套词典键完全对齐（`zh['panel.title'] = '使用时间'`，
`en = 'Usage'`）。`t` 只保证返回字符串，所以占位符由本地 `fill(template, params)` 替换 `{n}` / `{error}`，
不依赖 `t` 是否支持参数。

时长格式化（`formatDuration`）：

| 输入 | zh | en |
| --- | --- | --- |
| 0 / 无效 | `0 分钟` | `0m` |
| 1–59 s | `<1 分钟` | `<1 min` |
| 34 min | `34 分钟` | `34m` |
| 2h 34m | `2 小时 34 分` | `2h 34m` |
| 2h 整 | `2 小时` | `2h` |

token / 字符数用紧凑计数（`999` / `1.2k` / `120k` / `1.4M`）；时间戳格式化为本地 `MM-DD HH:mm`；
日期标签用字符串切分得到 `M/D`，**不使用 `new Date('YYYY-MM-DD')`**（会被按 UTC 解析而错位一天）。

语言判定不用浏览器 API：词典里放了一个私有键 `meta.lang`（`zh` / `en`），页面内
`const lang = t('meta.lang') === 'zh' ? 'zh' : 'en'`，语言切换后重新渲染即自动跟随。

## 状态处理

- 首次加载：骨架（`aria-busy` + 三块占位 + 「正在读取使用统计…」）。
- 失败：卡片显示「读取使用统计失败」+ 原始错误文本（`HTTP 404` 等，等宽字体）+ 重试按钮。
- 刷新：按钮进入 disabled + 「刷新中…」，旧数据保留在屏幕上，成功后整体替换。
- 竞态：每次请求带自增 `requestId`，过期响应不会覆盖新结果。
- 无数据：`days` 为空显示空态文案；`projects` 为空同理。

## 验证记录（如实）

1. **静态检查**：`node --check client.js` 通过；`package.json` 可被 `JSON.parse`，`exports` 与
   `dsh.client` 两处改动如上，`name` / `version` / `dependencies` / `scripts` 未变。
2. **安装**：`plugin_manager` `install_bundle` 首次返回 `application: "failed"` +
   `error.code: "already-installed"`（包已在 profile 里，`source: link:D:\Projects\Dynesshely\dsh-plugin-wakatime`）。
   按提示先 `remove_bundle`（`applied`，无 warning），再 `install_bundle`，结果：
   `application: "applied"`、`enabled: true`、`warnings: []` —— **没有任何与 client 相关的 warning**。
3. **Client occupant：未能确认（不是"确认出现"）**。
   `cordis_inspect_query` 的 client 侧全部方法都超时：`Slots.listSubTree`（`root=sidebar.panellist`、
   `root=main`、无 root 全树）、`Service.listService`、`Builtin.listBuiltins` 一律
   `timed out after 10000ms … Open or reconnect the Harness page`。因此这一条**没有拿到证据**，
   不能声称 `occupant id=wakatime-usage, active: true` 或 `main` 里已注册 `key=wakatime-usage`。
4. **为什么重装后也不会立刻出现**（源码依据，不是猜测）：
   `@deepseek-ai/dsh-client-modules` 的 `ClientModuleRegistry` 在**构造时**扫描一次
   `ctx.loader.entries()`，把每个 entry 的 `package.json` 解析结果缓存在 `pkgMeta`（键为
   `<baseUrl>\0<loaderName>`）；`resolveMeta` 是唯一写入点、没有任何失效/清空逻辑，而
   `reconcilePackage` 只在 `internal/plugin` 事件（Loader 行变化）时走一遍这个缓存。
   本机 DSH 进程启动于 **2026-10-26 20:50**，远早于本次新增 `dsh.client`，所以缓存里该包是
   `null`（"没有 client 声明"）；重装只重建 Loader 行，不会重读 `package.json`。
   结论：**新增 Client 半边必须重启 DSH 才会进入模块图**，仅重装/刷新页面不够。
5. **Host 接口现状**：`GET http://127.0.0.1:51111/wakatime/usage.json` 当前返回 **404**
   （Host 侧的 `/wakatime/usage.json` 路由与 `lib/usage.js` 由 Lead 并行实现，尚未加载）。
   页面此时按设计进入「错误 + 重试」态，属预期，不是 Client 侧 bug。
6. **视觉未验证**：本环境无法截图、不能驱动浏览器，深浅色观感、间距、柱状图比例的实际渲染都
   **没有被人眼确认过**。能确认的只有上面第 1、2 条（语法、清单、安装结果）。

## 重启 DSH 后的验证步骤（交接给 Lead）

重启 Host 进程后，页面刷新一次，然后：

```
cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={ root: 'sidebar.panellist' })
# 期望 occupants 里出现 id=wakatime-usage（order 21，active=true）
cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={ root: 'main' })
# 期望出现 key=wakatime-usage
Invoke-WebRequest http://127.0.0.1:51111/wakatime/usage.json   # 期望 200 + JSON
```

若重启后 `sidebar.panellist` 仍无 `wakatime-usage`，先看 Host 启动日志里有没有
`client-modules:` 前缀的告警（例如 `declares dsh.client but exports no "./client" bundle`），
再确认 profile 软链是否指向本仓库、`client.js` 是否存在。

## 已知遗留

- `package.json` 的 `files` 数组里**没有** `client.js`。本次写作用域只授权改 `dsh.client` 段与
  `./client` export，所以没动它；本地 `link:` 安装不受 `files` 影响（软链整个目录），
  但将来 `npm pack` / 发布前必须把 `client.js` 加进 `files`，否则打包件会缺 Client 半边。
- 柱状图与比例条没有动画（内联样式无法声明 keyframes，注入全局 CSS 会污染宿主），
  刷新时直接切换数值。
