<p align="center">
  <img src="docs/banner.svg" alt="dsh-plugin-wakatime — WakaTime heartbeats for DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3f8cff.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A520-339933.svg" alt="Node >= 20">
  <a href="https://wakatime.com/developers"><img src="https://img.shields.io/badge/WakaTime-API%20v1-3f8cff.svg" alt="WakaTime API v1"></a>
  <img src="https://img.shields.io/badge/DeepSeek-Harness-1f2b3d.svg" alt="DeepSeek Harness">
</p>

# dsh-plugin-wakatime

一个 [DeepSeek Harness](https://github.com/Dynesshely)（DSH）的 Host 侧插件：把你在 DSH 里**和 AI 一起写代码**的时长，按 WakaTime 官方客户端的做法，以 `category: "ai coding"` 的 heartbeat 上报到 WakaTime API v1，从而计入 **AI Coding** 统计。

它不伪造「手写代码」的逐文件发键记录，只回答一个问题：这段时间你是不是在跟 AI 做这个项目。装上之后在后台计时，没有面板、没有命令，诊断靠日志。

## 特性

- **按项目计时**：`entity` 取会话工作目录、`project` 取目录名，WakaTime 里能按项目看到 AI 时间。
- **带上 AI 维度**：心跳携带会话 id、输入/输出 token 增量、你键入的字符数，供 WakaTime 的 AI 统计使用。
- **跟随 DSH 的真实活动**：用户消息、模型回复、工具调用、轮次起止都会触发；长回合有保活，空闲超时后停止，不会「开着去吃饭」白算。
- **失败不丢数据**：429/5xx/断网先落本地队列（原子写、上限 500 条）再按退避补发；401 直接停报，不刷请求。
- **不干扰宿主**：没有 `api_key` 时只记一条告警并保持 inert，不影响 DSH 启动。

## 安装

`install_bundle` 对本地目录是**软链安装**，不会代装插件自己的依赖，所以先装依赖：

```bash
git clone git@github.com:Dynesshely/dsh-plugin-wakatime.git
cd dsh-plugin-wakatime
pnpm install        # 或 npm install
```

然后在 DSH 的 Plugin Manager 里把本仓库根目录的绝对路径作为 bundle 目标安装：

```text
plugin_manager → install_bundle → D:\Projects\Dynesshely\dsh-plugin-wakatime
```

安装或升级后**重启 DSH**（Host 代码在进程里，刷新页面不生效）。卸载用 `remove_bundle`，包名 `dsh-plugin-wakatime`。

前提：`~/.wakatime.cfg` 的 `[settings]` 里已有 `api_key`（和其他 WakaTime 客户端共用同一个文件）；文件里的 `proxy`、`hostname`、`debug` 会被沿用。

## 配置

配置写在插件行的 `config`（或 Settings 的插件表单）里，优先级：插件 `config` > `~/.wakatime.cfg` > 内置默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `minIntervalSeconds` | `120` | 两次心跳的最小间隔，全局生效 |
| `idleTimeoutMinutes` | `15` | 空闲超过该时长即结束当前一段计时 |
| `entityType` | `'file'` | `file` 用项目目录，`app` 用应用名 `DeepSeek Harness` |
| `includeSubagentSessions` | `false` | 子代理会话是否单独计时（默认否，避免同一段墙钟时间记两遍） |
| `debug` | `false` | 写更详细的诊断日志 |

字符串型覆盖项（`apiKey`、`apiUrl`、`proxy`、`hostname`、`language`、`userAgent`）留空表示回退，不是「设成空字符串」。另外还有 `category`、`projectFromCwd` 两项，完整 14 键与语义见 [docs/design.md](docs/design.md)。

## 工作方式

```text
session/event  →  累计活动与 token/字符增量  →  全局节流（≥ minIntervalSeconds）
                                                     │
                                    ┌────────────────┴────────────────┐
                               成功 → WakaTime          失败 → 本地队列 → 退避补发
```

- 触发事件：`user/message`、`assistant/message`（含 `usage`）、`tool/call`、`tool/result`、`turn/start`、`turn/end`；`turn` 进行中由 15s tick 保活。
- 发送：单条走 `/users/current/heartbeats`，多条走 `.bulk`（每批 ≤25）；认证为 `Authorization: Basic base64(api_key)`。
- 诊断：`<DSH_HOME>/cache/wakatime-dsh/wakatime.log`（没有 `DSH_HOME` 时在 `~/.dsh/cache/`），离线队列与状态也在同目录。

## 隐私

上报内容只有：项目工作目录路径、项目名、DSH 会话 id、输入/输出 token 数、键入字符数、时间戳，以及配置了的 `language` 与主机名。

**不上报**：代码内容、提示词正文、模型回复正文、文件内容、终端输出。插件处理的是事件元数据，不是文本本身。

## 开发

无构建步骤，纯 ESM，`lib/*.js` 可以脱离 DSH 运行时单独测试：

```bash
node --test        # 67 个用例：配置解析、心跳构造、HTTP 客户端、离线队列、追踪器、入口装配
```

```text
index.js            Host 入口：Config + apply(ctx, config)
lib/tracker.js      session/event → 活动状态 → 心跳调度
lib/client.js       WakaTime HTTP 客户端（认证、批量、重试、代理降级）
lib/heartbeat.js    heartbeat 构造（纯函数）
lib/cfg.js          ~/.wakatime.cfg 与插件配置合并
lib/queue.js        持久化离线队列（原子写）
test/               node:test 单测
docs/               design.md · wakatime-api.md · harness-api.md
```

实现契约见 [docs/design.md](docs/design.md)，WakaTime 字段与 DSH 插件机制的实测记录见 [docs/wakatime-api.md](docs/wakatime-api.md) 与 [docs/harness-api.md](docs/harness-api.md)。

## 许可证

[MIT](LICENSE) © 2026 Dynesshely
