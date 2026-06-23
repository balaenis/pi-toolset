# `pi-lsp` 模块功能对比分析

> 对比对象:
>
> - 当前实现: `/home/julian/workspace/my/pi-lsp`
> - 当前使用: `/home/julian/.pi/agent/npm/node_modules/@spences10/pi-lsp`

本文对比本仓库正在实现的 `pi-lsp` 与 `@spences10/pi-lsp` v0.0.35 的功能、架构侧重点和差异化价值。

## 1. 总览

| 维度         | 本仓库 `pi-lsp`                                          | `@spences10/pi-lsp`                                                       |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| 版本状态     | v0.0.1，独立仓库，含 specs / analysis / fixtures / tests | v0.0.35，已发布 npm，作为 `my-pi` 内置包使用                              |
| 核心来源     | 移植 Claude Code 的 LSP 模块                             | Pi 原生实现                                                               |
| 工具形态     | 单个 `lsp` 工具，通过 `operation` 参数选择 9 种操作      | 7 个独立工具，每个 LSP 操作一个工具                                       |
| 诊断模式     | 被动注入：`publishDiagnostics` 自动进入模型上下文        | 主动拉取：模型调用 `lsp_diagnostics` / `lsp_diagnostics_many`             |
| 生命周期策略 | 自动崩溃恢复、启动/关闭超时、瞬态错误重试                | idle timeout 自动停闲置 server，失败后等待手动 restart                    |
| 安全策略     | 有 UNC 路径防护，但缺少项目二进制信任和子进程环境清理    | 项目本地二进制信任 + 受限 child env                                       |
| 多 workspace | 以 session `cwd` 作为 workspace，偏单 root               | 按 `(language, workspace_root)` 池化 client，支持多 root                  |
| UX           | 无 slash command，偏工具和日志                           | `/lsp status/list/restart`、TUI modal、tab completion                     |
| 扩展点       | 内部闭包工厂，未暴露正式 client 注入接口                 | `create_lsp_extension({ create_client })`、`LspClientLike`、prompt gating |

## 2. 工具面差异

### 2.1 本仓库：单工具 9 操作

`src/tools.ts` 注册单个 `lsp` 工具，`operation` 支持:

- `goToDefinition`
- `findReferences`
- `hover`
- `documentSymbol`
- `workspaceSymbol`
- `goToImplementation`
- `prepareCallHierarchy`
- `incomingCalls`
- `outgoingCalls`

其中 `incomingCalls` / `outgoingCalls` 会先调用 `textDocument/prepareCallHierarchy`，再调用 `callHierarchy/incomingCalls` 或 `callHierarchy/outgoingCalls`。这种设计接近 Claude Code 的 `LSPTool.call` 流程，工具列表更少，语义能力更完整。

### 2.2 Spence：7 个独立工具

`@spences10/pi-lsp` 在 `dist/tools.js` 注册 7 个工具:

- `lsp_diagnostics`
- `lsp_diagnostics_many`
- `lsp_find_symbol`
- `lsp_hover`
- `lsp_definition`
- `lsp_references`
- `lsp_document_symbols`

它没有 `callHierarchy`、`goToImplementation`、`workspaceSymbol`。但 `lsp_find_symbol` 支持 `query`、`max_results`、`top_level_only`、`exact_match`、`kinds`，符号搜索参数比本仓库当前的 `workspaceSymbol` 更细。

### 2.3 判断

本仓库的工具面更偏“IDE 级语义导航”，Spence 的工具面更偏“Pi 工具列表可发现性”。如果目标是最大化模型能调用的 LSP 语义操作，本仓库更强；如果目标是让模型从工具名直接理解用途，Spence 更直观。

## 3. 诊断机制差异

### 3.1 本仓库：被动诊断注入

本仓库在 `src/index.ts` 的 `context` hook 中调用 `diagnostics.drain(ctx.cwd)`，把 LSP 诊断作为 `customType: 'lsp-diagnostics'` 的隐藏上下文块注入给模型。`src/diagnostics.ts` 负责:

- 同批次去重：基于 `message`、`severity`、`range`、`source`、`code` 生成 key
- 跨轮次去重：用 per-file delivered set 避免重复注入同一问题
- 限流：每个文件最多 10 条，总数最多 30 条
- severity 排序：优先注入 error / warning
- 编辑感知清理：编辑或写文件后 `clearForFile(uri)`，允许相同位置的新诊断重新出现

效果是：模型不需要显式调用诊断工具，也会在下一次推理前看到 LSP 发布的新问题。

### 3.2 Spence：主动诊断工具

Spence 在 `dist/client.js` 缓存 `textDocument/publishDiagnostics`，由 `lsp_diagnostics` 或 `lsp_diagnostics_many` 显式拉取。`lsp_diagnostics_many` 支持最多 100 个文件，内部并发上限为 8，并返回 clean / error summary。

效果是：上下文更干净，但模型必须记得主动调用诊断工具。

### 3.3 判断

这是两者最关键的产品哲学差异。本仓库的被动诊断是更有差异化的“环境感知”能力；Spence 的主动诊断更可控、更节省上下文。

## 4. Server 生命周期与恢复策略

### 4.1 本仓库：自愈优先

`src/instance.ts` 的 `createLSPServerInstance` 支持:

- `restartOnCrash`
- `maxRestarts ?? 3`
- `crashRecoveryCount`
- `startingPromise` 防并发启动竞争
- `startupTimeout` / `shutdownTimeout`
- 瞬态错误重试与退避

这让 LSP server 崩溃后可以在上限内自动恢复。

### 4.2 Spence：资源控制优先

Spence 的 `dist/server-manager.js` 维护 `failed_servers`，启动失败后不会持续重试，直到用户通过 `/lsp restart` 清理状态。它还支持 `MY_PI_LSP_IDLE_TIMEOUT_MS` 或 `idle_timeout_ms`，在 server 闲置后自动停止进程。

### 4.3 判断

本仓库更适合长会话中自动恢复；Spence 更适合降低后台进程占用，并避免失败 server 反复重启。

## 5. 安全与运行环境

### 5.1 本仓库现状

本仓库已有一些基础防护:

- `src/tools.ts` 对 UNC 路径跳过 `stat`，避免 Windows / SMB 场景的 NTLM 凭据泄漏风险
- `src/config.ts` 支持 env 变量替换，便于配置路径和参数

但当前没有:

- 项目本地二进制执行前的信任确认
- 子进程环境变量清理或 allowlist

### 5.2 Spence 的安全设计

Spence 依赖:

- `@spences10/pi-project-trust`：对项目本地 binary 进行 trust 决策，并写入 `<agentDir>/trusted-lsp-binaries.json`
- `@spences10/pi-child-env`：用 `profile: 'lsp'` 构造受限子进程环境，避免把 secrets 和无关运行时变量传给 language server

同时支持环境变量:

- `MY_PI_LSP_PROJECT_BINARY=allow|trust`
- `MY_PI_LSP_ENV_ALLOWLIST` 或 `MY_PI_CHILD_ENV_ALLOWLIST`

### 5.3 判断

Spence 在安全工程上明显更成熟。LSP server 经常来自项目依赖或用户 PATH，执行前信任和环境清理都是真实需求。

## 6. 配置与 workspace 模型

### 6.1 本仓库：配置能力强

`src/config.ts` 支持:

- 全局配置：`~/.pi/agent/@balaenis/pi-lsp/config.json`
- 项目配置：`<cwd>/.pi/@balaenis/pi-lsp/config.json`
- JSONC 注释剥离
- env 变量替换
- `extensions` 简写到 `extensionToLanguage`
- 用户配置优先，内置 recipe 只补充未覆盖扩展

`src/recipes.ts` 提供 PATH 检测的 zero-config recipe。

### 6.2 Spence：workspace root 池化强

Spence 通过 `find_workspace_root()` 从文件路径向上查找 `tsconfig.json`、`package.json`、`Cargo.toml`、`go.mod` 等 marker，并以 `${language}\0${workspace_root}` 作为 client key。也就是说，同一 Pi session 中不同 workspace root 可以有独立 language server。

### 6.3 判断

本仓库配置表达力更强；Spence 的 multi-root 模型更适合 monorepo 和嵌套项目。

## 7. UX 与可插拔性

### 7.1 Spence 的 UX

Spence 提供 `/lsp` 命令:

- `/lsp status`
- `/lsp list`
- `/lsp restart all`
- `/lsp restart <language>`

在 TUI mode 下，`/lsp` 无参数会打开 modal picker，展示 status、running servers、failed servers 和 restart 入口。

### 7.2 Spence 的扩展 seam

Spence 导出:

- `create_lsp_extension(options)`
- `LspClientLike`
- `CreateLspExtensionOptions`
- `should_inject_lsp_prompt`

其中 `create_client` 可以注入自定义 client，`read_file` 和 `cwd` 也可覆盖。这让自定义 harness、测试和不同 transport 更容易接入。

### 7.3 本仓库现状

本仓库目前主要通过内部 factory 函数组织代码，没有面向 harness 的正式注入接口，也没有 `/lsp` 命令层。

## 8. 哪个更有特点

如果“更有特点”指核心智能能力，本仓库更突出：

- 被动诊断注入让模型获得 ambient LSP feedback
- 9 种 LSP 操作覆盖 call hierarchy、implementation、workspace symbol
- 自动崩溃恢复和瞬态错误重试适合长会话

如果“更有特点”指产品化工程能力，Spence 更突出：

- 项目 binary trust 和 child env hardening 是真实安全能力
- multi-workspace client pooling 更适合 monorepo
- `/lsp` 命令、TUI modal、tab completion 提升可观察性和可操作性
- `create_client` seam 让扩展更可测试、更易嵌入自定义 harness

综合判断：本仓库的差异化在“模型效果”，Spence 的差异化在“安全、UX 和可插拔工程”。下一阶段最值得从 Spence 借鉴的是:

1. 子进程环境清理 + 项目本地二进制信任
2. `create_client` 依赖注入 seam + `LspClientLike` 接口
3. `(language, workspace_root)` 多 workspace client 池
