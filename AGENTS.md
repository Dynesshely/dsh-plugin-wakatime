# AGENTS.md

本文件写给在这个仓库里干活的自动化代理（以及未来的我）。

## 提交信息（强制）

- **提交信息一律用英文。** subject 与 body 都用英文，不要写中文提交信息。
- 采用 Conventional Commits 风格：`feat:` / `fix:` / `docs:` / `test:` / `chore:` / `refactor:`。
- subject 用祈使句、不超过约 72 字符；细节放 body，每条一行、`-` 开头。
- 除非用户明确要求，不要自行 `git commit` / `git push`；需要时先问。

## 文档与文案语言

- `README.md`、`docs/banner.svg`、插件 `locale/en.json` 面向公众，用**英文**。
- `docs/*.md`（design / harness-api / wakatime-api / 实现笔记）与代码注释用**中文**。
- 代码标识符、命令、路径、日志、API 字段名保持原样，不翻译。

## 代码约定

- 纯 ESM，无构建步骤；`lib/*.js` 必须能脱离 DSH 运行时单独测试。
- 运行时依赖只有 `@deepseek-ai/schemastery`（DSH 投影 `Config` 用；**不能用 zod**，会被判成 `unsupported`）。
- 插件入口不抛异常：任何初始化失败都退化成「装了但不做事」，写日志即可。
- 心跳/账本/队列的写盘必须原子（tmp + rename），损坏文件要能自愈。

## 测试

提交前必须全绿：

```bash
pnpm install   # 首次，或依赖变化后
node --test    # 至少 72 个用例，不得访问外网
```

测试里不得出现真实 `api_key`；需要网络行为时用 `127.0.0.1` 假服务器或未监听端口。

## 安装 / 验证注意事项

- `plugin_manager install_bundle` 对本地目录是**软链安装**，不会代装插件依赖，所以先 `pnpm install`。
- linked 插件**没有热更新**：改 `index.js` / Host 侧代码后必须重启 DSH；新增 `dsh.client` 同样要重启（`ClientModuleRegistry` 会缓存「没有 client 半边」的判断）。
- 想在运行中的 DSH 里验证未发布的改动，做法是复制一份到 `.scratch/verify*`、改包名与 patch id、单独安装验证，验证完 `remove_bundle` 并删掉副本。`.scratch/` 已在 `.gitignore` 中。
- 状态目录（日志、离线队列、`usage.json`）在 `<DSH_HOME>/cache/wakatime-dsh`，不要提交。

## 敏感信息

- 不读取、不打印、不提交 `~/.wakatime.cfg` 里的 `api_key`，文档里只描述键名与格式。
- 本仓库任何文件都不得包含真实 key；提交前自查一遍。
