# Spence 启发的 LSP 工程化增强规格书

> 背景分析: [../analysis/pi-lsp-comparison.md](../analysis/pi-lsp-comparison.md)
> 当前规格: [./lsp-extension-spec.md](./lsp-extension-spec.md)

本文定义从 `@spences10/pi-lsp` 借鉴的三项工程化增强:

1. 子进程环境清理 + 项目本地二进制信任
2. `create_client` 依赖注入 seam + `LspClientLike` 接口
3. `(serverName, workspaceRoot)` 多 workspace client 池

目标是在保留本仓库 Claude Code 风格核心能力（被动诊断、9 种 LSP 操作、自愈生命周期）的前提下，补齐安全、可测试性和 monorepo 支持。

## 1. 范围

### 1.1 目标（In Scope）

- 默认以受限 env 启动 LSP server 子进程，避免把 secrets 和无关运行时变量传入 language server
- 对项目目录内的可执行文件，尤其是 `node_modules/.bin` 下的 server binary，执行前做 trust 决策
- 将 trust 决策持久化到 agent 配置目录，并在 binary 内容变化后重新确认
- 暴露 `createLspExtension(options)`，允许 harness 或测试注入 `createClient`、`readFile`、`workspaceRootResolver`
- 保持 default export 的现有 Pi package 行为不变
- 将 manager 从“每个 server name 一个 instance”升级为“每个 `(serverName, workspaceRoot)` 一个 instance”
- 为 workspace root 解析引入 marker 规则，支持 monorepo 中多个子项目
- 更新 README 中新增的配置项、环境变量和验证步骤

### 1.2 非目标（Out of Scope）

- 不改变现有单 `lsp` 工具 + `operation` 参数的工具形态
- 不在本规格中实现 `/lsp status` / `/lsp restart` / TUI modal
- 不引入 socket transport；仍只实现 stdio
- 不引入 mock mode 或 fake data path；DI 只作为真实 client / harness 集成 seam
- 不默认依赖 `@spences10/*` 包；本仓库先实现本地等价能力，避免发布包与第三方命名空间强耦合
- 不重新设计被动诊断 registry

## 2. 设计原则

- **兼容优先**：现有 `config.json`、zero-config recipe、`lsp` 工具输入输出不破坏。
- **安全默认**：默认不把完整 `process.env` 传给 server；项目本地 binary 必须经过明确策略处理。
- **可插拔但不虚假**：`createClient` seam 用于真实替换客户端实现或测试协议边界，不添加 mock 开关。
- **最小改动**：保留现有 `client.ts`、`instance.ts`、`manager.ts` 分层，只给 factory 和 routing 加依赖参数。
- **可观察**：安全拒绝、trust 失效、workspace root 选择都写 debug log，并在工具失败时给用户可执行提示。

## 3. 子进程环境清理

### 3.1 新模块

新增 `src/child-env.ts`:

```ts
export interface ChildEnvOptions {
  extraEnv?: Record<string, string>;
  allowlist?: string[];
  baseEnv?: NodeJS.ProcessEnv;
}

export function createLspChildEnv(options?: ChildEnvOptions): Record<string, string>;
```

`createLspChildEnv` 负责构造传给 `spawn` 的 env。它不是简单拷贝 `process.env`，而是从固定 allowlist 开始，再合并用户配置的 server `env`。

### 3.2 默认 allowlist

默认保留运行 language server 通常需要的变量:

- `PATH`
- `HOME`
- `USER`
- `LOGNAME`
- `SHELL`
- `TMPDIR`
- `TEMP`
- `TMP`
- `LANG`
- `LC_ALL`
- `XDG_CACHE_HOME`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`
- `PYTHONPATH`
- `GOMODCACHE`
- `GOPATH`
- `CARGO_HOME`
- `RUSTUP_HOME`
- `JAVA_HOME`

默认不传入常见 secret 变量，例如 `*_TOKEN`、`*_KEY`、`*_SECRET`、`AWS_*`、`GITHUB_TOKEN`、`NPM_TOKEN`。如果用户确实需要传入某个变量，必须通过 server `env` 或 allowlist 显式配置。

### 3.3 配置与环境变量

在现有 `@balaenis/pi-lsp/config.json` 顶层增加可选 `security` 配置:

```jsonc
{
  "security": {
    "childEnv": {
      "mode": "restricted",
      "allow": ["NODE_OPTIONS"],
    },
  },
  "servers": {},
}
```

字段:

| 字段                      | 类型                        | 默认值         | 说明                                                                              |
| ------------------------- | --------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `security.childEnv.mode`  | `'restricted' \| 'inherit'` | `'restricted'` | `restricted` 使用 allowlist；`inherit` 继承完整 `process.env`，仅用于兼容问题排查 |
| `security.childEnv.allow` | `string[]`                  | `[]`           | 额外允许从 `process.env` 继承的变量名                                             |

环境变量覆盖:

- `PI_LSP_CHILD_ENV=restricted|inherit`
- `PI_LSP_ENV_ALLOWLIST=VAR1,VAR2`

优先级: server `env` > config `security.childEnv.allow` / env allowlist > 默认 allowlist。

### 3.4 集成点

`src/client.ts` 的 `client.start(command, args, { env, cwd })` 继续接受 `env`。`src/instance.ts` 在调用 `client.start` 前构造:

```ts
const env = createLspChildEnv({
  extraEnv: config.env,
  allowlist: security.childEnv.allow,
});
```

这样 `ScopedLspServerConfig.env` 仍是用户显式传入变量，不会被默认过滤掉。

## 4. 项目本地二进制信任

### 4.1 目标威胁模型

LSP server 可能来自项目依赖，例如 `node_modules/.bin/typescript-language-server`。在未信任仓库里自动执行项目本地 binary，等价于运行项目代码。增强目标是：

- 系统 PATH 中的全局 binary 默认不提示
- 位于当前 workspace / repository 内的 binary 需要经过策略处理
- binary 内容变化后，之前的 trust 不再自动生效

### 4.2 新模块

新增 `src/trust.ts`:

```ts
export type ProjectBinaryPolicy = 'prompt' | 'deny' | 'allow' | 'trust';

export interface ProjectBinarySubject {
  command: string;
  resolvedPath: string;
  realPath: string;
  workspaceRoot: string;
  sha256: string;
}

export interface TrustDecision {
  allowed: boolean;
  reason:
    'trusted' | 'allowed-by-policy' | 'denied-by-policy' | 'user-denied' | 'prompt-unavailable';
}

export async function resolveProjectBinaryTrust(
  subject: ProjectBinarySubject,
  policy: ProjectBinaryPolicy
): Promise<TrustDecision>;
```

### 4.3 Binary 判定规则

一个 command 需要 trust 的条件:

1. command 解析为绝对路径后位于 session `cwd` 或 workspace root 内；并且
2. command 不是用户显式配置的外部绝对路径；或
3. command 来自项目局部 PATH，例如 `<workspace>/node_modules/.bin`。

实现细节:

- 用 `fs.realpath` 解析 symlink，避免只信任 `node_modules/.bin` 的 shim 而忽略真实 target
- 对 `realPath` 文件内容计算 `sha256`
- trust key 至少包含 `workspaceRoot`、`realPath`、`sha256`
- hash 变化后视为新 subject，需要重新 trust

### 4.4 Trust store

持久化文件:

```text
~/.pi/agent/@balaenis/pi-lsp/trusted-binaries.json
```

格式:

```json
{
  "version": 1,
  "subjects": [
    {
      "workspaceRoot": "/repo",
      "realPath": "/repo/node_modules/typescript-language-server/lib/cli.mjs",
      "sha256": "...",
      "trustedAt": "2026-06-19T00:00:00.000Z"
    }
  ]
}
```

### 4.5 Policy

配置:

```jsonc
{
  "security": {
    "projectBinaries": {
      "policy": "prompt",
    },
  },
}
```

环境变量覆盖:

- `PI_LSP_PROJECT_BINARY=prompt|deny|allow|trust`

策略语义:

| Policy   | 语义                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `prompt` | 默认策略。若已有 trust store 命中则允许；否则尝试询问用户。若当前 UI 无法 prompt，则拒绝并给出配置提示 |
| `deny`   | 所有项目本地 binary 都拒绝启动                                                                         |
| `allow`  | 本次允许执行，但不写入 trust store                                                                     |
| `trust`  | 允许执行，并将当前 subject 写入 trust store                                                            |

### 4.6 Prompt 行为

如果 Pi extension API 当前没有稳定的交互 prompt 能力，第一版不做 TUI prompt，而是:

- `prompt` 且未命中 trust store 时拒绝启动
- 工具返回明确提示：binary 路径、workspace root、hash、可用配置方式
- 用户可通过 `PI_LSP_PROJECT_BINARY=trust` 或 config policy 明确授权

后续若加入 `/lsp trust` 或 TUI modal，再把 `prompt` 从“拒绝并提示”升级为“交互确认”。

## 5. `create_client` DI seam

### 5.1 导出 API

调整 `src/index.ts`，新增命名导出:

```ts
export interface LspClientLike extends LSPClient {}

export interface CreateLspExtensionOptions {
  createClient?: (serverName: string, onCrash?: (error: Error) => void) => LspClientLike;
  readFile?: (filePath: string) => Promise<string>;
  resolveWorkspaceRoot?: (filePath: string, cwd: string) => Promise<string>;
}

export function createLspExtension(options?: CreateLspExtensionOptions): (pi: ExtensionAPI) => void;

export default createLspExtension();
```

兼容要求:

- `pi.extensions` 继续加载 default export
- 现有用户无需改配置
- 自定义 harness 可以 `import { createLspExtension } from 'pi-lsp'`

### 5.2 依赖传递

新增 `src/dependencies.ts`:

```ts
export interface LspDependencies {
  createClient: (serverName: string, onCrash?: (error: Error) => void) => LSPClient;
  readFile: (filePath: string) => Promise<string>;
  resolveWorkspaceRoot: (filePath: string, cwd: string) => Promise<string>;
}

export function createDefaultDependencies(): LspDependencies;
```

传递路径:

```text
createLspExtension(options)
  → initializeManager(ctx.cwd, dependencies)
  → createLSPServerManager(dependencies)
  → createLSPServerInstance(name, config, dependencies)
  → dependencies.createClient(...)
```

### 5.3 约束

- DI seam 不改变生产默认路径
- `LspClientLike` 必须覆盖真实 LSP client 所需的全部方法，不接受部分实现
- 测试可以注入 fake client，但生产代码不得根据 “mock mode” 分支执行

## 6. 多 workspace client 池

### 6.1 当前问题

当前 `src/manager.ts` 在初始化时为每个 configured server 创建一个 `LSPServerInstance`，并把 `workspaceFolder` 默认设为 session `cwd`。在 monorepo 中，多个子项目可能有不同 `tsconfig.json`、`pyproject.toml` 或 `Cargo.toml`，单一 workspace 会让 language server 索引范围和配置解析不准确。

### 6.2 新数据结构

将 manager 内部状态调整为:

```ts
serverConfigs: Map<string, ScopedLspServerConfig>;
extensionMap: Map<string, string[]>; // ".ts" → ["typescript"]
instances: Map<string, LSPServerInstance>; // `${serverName}\0${workspaceRoot}`
openedFiles: Map<string, string>; // uri → serverKey
```

server key:

```ts
function createServerKey(serverName: string, workspaceRoot: string): string {
  return `${serverName}\0${workspaceRoot}`;
}
```

### 6.3 Workspace root 解析

新增 `src/workspace.ts`:

```ts
export interface WorkspaceRootOptions {
  cwd: string;
  explicitWorkspaceFolder?: string;
}

export async function resolveWorkspaceRoot(
  filePath: string,
  options: WorkspaceRootOptions
): Promise<string>;
```

规则:

1. 如果 server config 指定 `workspaceFolder`，直接使用它。
2. 否则从文件所在目录向上查找 marker。
3. 对相对 `filePath`，最多向上查到 session `cwd`，不越界。
4. 若未找到 marker，回退到 session `cwd`。

第一版 marker:

| 生态             | Marker                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| JS / TS / Svelte | `tsconfig.json`、`jsconfig.json`、`package.json`、`svelte.config.js`、`svelte.config.ts` |
| Python           | `pyproject.toml`、`setup.py`、`requirements.txt`                                         |
| Rust             | `Cargo.toml`                                                                             |
| Go               | `go.mod`                                                                                 |
| Java             | `pom.xml`、`build.gradle`、`build.gradle.kts`                                            |
| Ruby             | `Gemfile`                                                                                |
| Repo fallback    | `.git`、`pnpm-lock.yaml`、`bun.lock`、`package-lock.json`、`yarn.lock`                   |

### 6.4 Request 路由

`sendRequest(filePath, method, params)` 新流程:

1. 根据文件扩展名从 `extensionMap` 选择 `serverName`
2. 调用 `resolveWorkspaceRoot(filePath, cwd)`
3. 生成 `serverKey = createServerKey(serverName, workspaceRoot)`
4. 若 `instances` 没有该 key，则基于原 server config 派生 `workspaceFolder: workspaceRoot` 并创建 instance
5. 打开或同步文件，记录 `openedFiles.set(uri, serverKey)`
6. 向对应 instance 发送 request

### 6.5 生命周期

- `shutdownManager()` 停止所有 `instances`
- 单个 workspace instance 崩溃只影响同一 `serverKey`
- `restartOnCrash` 和 `maxRestarts` 计数按 instance 独立计算
- 被动诊断仍按 URI 注册，不需要按 workspace 拆分

### 6.6 配置兼容

`ScopedLspServerConfig.workspaceFolder` 语义保持不变：如果用户明确配置，它优先于自动 root 解析。未配置时才启用 multi-root。

## 7. 实施顺序

### Phase 1：DI seam

- 新增 `CreateLspExtensionOptions`、`LspClientLike`、`createLspExtension`
- 保持 default export 兼容
- 给 manager / instance 增加 dependency 参数
- 增加单元测试验证 custom `createClient` 被调用

### Phase 2：安全层

- 新增 `child-env.ts`
- 新增 `trust.ts`
- 扩展 config schema，读取 `security.childEnv` 和 `security.projectBinaries`
- 在 server start 前解析 command、做 trust 决策、构造 restricted env
- README 记录新增配置和环境变量

### Phase 3：多 workspace 池

- 新增 `workspace.ts`
- manager 改为按 `serverKey` lazy 创建 instance
- 添加 nested fixture，验证同一语言不同 root 启动不同 server instance
- 确认被动诊断、文件同步、shutdown 对多 instance 正常工作

## 8. 验收标准

### 8.1 兼容性

- 未配置 security 时，现有 zero-config LSP 仍可工作，除非 binary 被判定为未信任项目本地 binary；此时返回明确授权提示
- 现有 `lsp` 工具 schema 不变化
- default export 仍可被 `pi.extensions` 加载

### 8.2 安全

- 默认 child env 不包含明显 secret 变量
- server `env` 中显式配置的变量会传入子进程
- 项目本地 binary 首次执行在 `prompt` policy 下不会静默运行
- `trust` policy 写入 trust store；binary hash 变化后 trust 失效
- `allow` policy 只允许本次执行，不写 trust store

### 8.3 DI

- 自定义 `createClient` 能完整替换默认 `createLSPClient`
- 自定义 `readFile` 被文件同步路径使用
- 生产默认路径不依赖测试 fake 或 mock 开关

### 8.4 多 workspace

- 同一 session 内，两个 nested package 的 `.ts` 文件可以解析到不同 workspace root
- manager 为不同 workspace root 创建不同 instance
- `shutdownManager()` 能关闭全部 instance
- `restartOnCrash` 计数按 instance 隔离

## 9. 测试计划

新增或扩展测试:

- `tests/child-env.test.ts`
  - 默认 allowlist
  - secret 变量默认过滤
  - server `env` 覆盖
  - `PI_LSP_ENV_ALLOWLIST`
- `tests/trust.test.ts`
  - project-local binary 判定
  - trust store 命中
  - hash 变化失效
  - `deny` / `allow` / `trust` policy
- `tests/dependencies.test.ts`
  - custom `createClient`
  - custom `readFile`
- `tests/workspace.test.ts`
  - marker 解析
  - session `cwd` 边界
  - explicit `workspaceFolder` 优先
- `fixtures/multi-workspace-smoke/`
  - 根目录 + nested package
  - 验证同一语言不同 root 的 server instance 路由

验证命令:

```bash
mise run typecheck
mise run test
mise run build
hk check
```

## 10. README 更新要求

实现本规格时同步更新 README:

- 新增 `security.childEnv` 和 `security.projectBinaries` 配置说明
- 新增 `PI_LSP_CHILD_ENV`、`PI_LSP_ENV_ALLOWLIST`、`PI_LSP_PROJECT_BINARY` 环境变量说明
- 解释项目本地 binary 首次被拒绝时如何授权
- 解释 multi-workspace root marker 规则
- 说明 custom harness 如何使用 `createLspExtension({ createClient })`
