# Agent 通信机制对比分析：pi-agents / Claude Code / pi-subagents

> 三套同源思想（Markdown 定义代理 + 独立 context 子调用）的不同实现路线对比，重点找出可借鉴的优化点。

## 一、整体定位对比

| 维度        | pi-agents（本仓库）                   | Claude Code（Anthropic）                                                    | pi-subagents                                                           |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 调用入口    | `agent` 工具                          | `Agent` 工具（旧名 `Task`）                                                 | `subagent` 工具                                                        |
| 执行模型    | spawn 子 `pi` 进程 + JSON 事件流      | **进程内** AsyncGenerator + 同 API session                                  | spawn 子 `pi` 进程 + 事件流                                            |
| 调用模式    | single / parallel / chain             | 并行靠模型一次发多 tool_use；链式靠对话循环                                 | single / parallel / chain（且 chain 内可嵌套 parallel/dynamic fanout） |
| 上下文策略  | `fresh` / `fork`                      | 普通子 agent 完全独立；fork 实验继承父全量 + 共享 prompt cache              | `fresh` / `fork`                                                       |
| 隔离        | git worktree、嵌套深度、工具白/黑名单 | worktree、remote、permissionMode、工具白/黑名单                             | worktree（含 setup hook、diff 收集）、嵌套深度、context fork preamble  |
| 异步        | 无（同步阻塞 + onUpdate 增量）        | **支持后台运行**：`run_in_background` + `<task-notification>` user 消息回灌 | **支持** `async: true` + 后台执行器、事件路由                          |
| 双向通信    | 无（单向：父→子→父）                  | **SendMessage**：父向已运行的命名 agent 推消息（mailbox）                   | **Intercom 桥接**（orchestrator ↔ 子代理双向）                         |
| 结构化输出  | 文本（最后一条 assistant text）       | 文本                                                                        | **`outputSchema`** + `structuredOutput`，命名为 `as` 后续可引用        |
| 动态扇出    | 无                                    | 无（要靠模型自己再发 N 个 tool_use）                                        | **`expand`/`collect`** 从上一步 JSON 数组里展开 N 个并行任务           |
| 完成校验    | `completionCheck` 标题白名单          | `criticalSystemReminder_EXPERIMENTAL` 每轮注入                              | `completionGuard` + `acceptance ledger`                                |
| 远程/分布式 | 无                                    | `isolation: "remote"`（CCR）                                                | 嵌套事件路由（文件系统事件）                                           |
| Agent 来源  | builtin / user / project（三层）      | built-in / userSettings / projectSettings / policy / plugin                 | builtin / user / project / **package**（npm 包贡献）                   |

## 二、关键差异详解

### 2.1 子代理执行模型

- **pi-agents**：`spawn` 子 `pi` 进程，stdout 解析 JSON 事件（`message_end`, `tool_result_end`）。优点是真正的进程隔离；代价是冷启动和上下文重建。
- **Claude Code**：`runAgent()` 是个 **AsyncGenerator**，在同一进程同一 API 循环内运行，仅 context window 隔离。Fork 实验更激进——和父 agent 共享 prompt cache（字节相同的请求前缀）。
- **pi-subagents**：和 pi-agents 一样 spawn 子进程，但事件流更细（含 progress/intercom/嵌套事件路由），并加入了 `PI_SUBAGENT_PARENT_ROOT_RUN_ID` 等环境变量串起跨进程的事件树。

**对 pi-agents 的启示**：子进程是个稳健选择，但 _可以借鉴 Claude Code 的 fork-and-cache_ 思路，对 `defaultContext: 'fork'` 路径复用父会话的 prompt cache key，降低首 token 成本。

### 2.2 双向通信能力

这是当前 pi-agents 最大的空白。

- **Claude Code**：`name` 字段让 agent 可被寻址，`SendMessageTool` 把消息投到该 agent 的 mailbox，下一轮 API 调用时以 user 消息注入。这让多 agent 协作不必"全跑完再汇总"。
- **pi-subagents**：`intercom-bridge.ts` 提供 orchestrator ↔ 子代理双向通信，配合 `async: true` 可以做长跑后台 agent。

**借鉴价值**：高。如果 pi-agents 想支持 verification / watch 类长跑代理（如 Claude Code 的 `verification` agent，`background: true`），需要一套类似的 mailbox 或 intercom 机制。

### 2.3 结构化输出与链式数据流

- **pi-agents**：`{previous}` 和 `{outputs.<name>}` 都是字符串模板，把上一步的最终文本塞进去。
- **Claude Code**：没有命名链路；靠模型自己在对话里读上一步的 tool_result 文本。
- **pi-subagents**：步骤可声明 `outputSchema`（JSON Schema），子代理返回结构化 JSON；后续步骤通过 `{outputs.<name>}` 引用文本，也可在 `expand.from.path` 中按 JSON Pointer 路径访问结构化字段。

**借鉴价值**：极高。给 pi-agents 的 chain step 增加可选的 `outputSchema` + `structuredOutput`，可以把"plan → review → patch"这类管线从"文本拼接"升级为"对象传递"，配合 dynamic fanout 还能做"先列任务，再并行处理"。

### 2.4 动态扇出（Expand/Collect）

pi-subagents 独有，且非常实用：

```yaml
chain:
  - { agent: scout, as: files, outputSchema: { type: object, properties: { items: ... } } }
  - expand: { from: { output: files, path: '/items' }, maxItems: 10 }
    parallel: { agent: worker, task: 'Process {item}' }
    collect: { as: results }
```

**借鉴价值**：高。pi-agents 当前要做"一拆 N"只能让主代理在一轮里发 N 个 tool_use（受模型一次决策能力限制）。引入 expand/collect 后，工作流的"广度"可以由前序步骤的输出决定。

### 2.5 异步 / 后台执行

- **pi-agents**：纯同步，`executeAgentTool` 返回前父代理是阻塞的。`onUpdate` 仅给 UI 用。
- **Claude Code**：`run_in_background: true` + `runAsyncAgentLifecycle()`，结束时把 `<task-notification>` 注入下一轮父对话。同步路径用 AsyncGenerator，异步路径用 mailbox。
- **pi-subagents**：`async: true` + `async-execution.ts`，配合 intercom 实现父子异步通信。

**借鉴价值**：高，但成本不低——需要引入持久化运行目录、状态机、通知回灌机制。优先级建议排在 mailbox / structured output 之后。

### 2.6 Agent 来源与可分发性

- **pi-agents**：三层（builtin/user/project），无 npm 包贡献。
- **pi-subagents**：**支持 package agents**，通过 npm 包的 `pi.subagents.agents` 字段贡献一组代理；`runtimeName = "packageName.localName"` 做命名空间隔离；settings.json 中可 override。

**借鉴价值**：高。这是 pi-toolset 这种"monorepo of pi extensions"最自然的扩展点——既然有 `@balaenis/pi-lsp`、`@balaenis/pi-format`，agents 也应该能通过 npm 包形式分发，比如 `@some-org/pi-agents-frontend` 提供一组前端专用 agent。

### 2.7 完成校验

- **pi-agents**：`completionCheck: ['## Completed', '## Files Changed', '## Validation']` 要求最终文本包含这些标题。机制朴素但能用。
- **Claude Code**：`criticalSystemReminder_EXPERIMENTAL` 每轮注入系统提醒（如 VERIFICATION agent 强调只读）。
- **pi-subagents**：`completionGuard` + `AcceptanceLedger`（acceptance criteria 验收账本）。

**借鉴价值**：中。pi-agents 可以保留 completionCheck 的极简性，但补一个"每轮 reminder"能力（Claude Code 的 `criticalSystemReminder`）——对 reviewer / verifier 这种容易跑偏的角色很有用。

## 三、可借鉴优化清单（按 ROI 排序）

| #   | 优化项                                              | 借鉴自                              | 价值                                                                  | 实现成本                                    | 优先级 |
| --- | --------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- | ------ |
| 1   | Chain step 增加 `outputSchema` + `structuredOutput` | pi-subagents                        | 链路从"文本拼接"升级到"对象传递"；解锁动态扇出                        | 中（需在子进程协议里塞 JSON 输出契约）      | **P0** |
| 2   | 动态扇出 `expand`/`collect`                         | pi-subagents                        | 主代理一轮里手发 N 个 tool_use 的局限消失                             | 中（依赖 #1）                               | **P0** |
| 3   | Package agents（npm 包贡献代理）                    | pi-subagents                        | 与 pi-toolset 现有 monorepo 模型完美契合                              | 低-中（主要是 discovery + 命名空间）        | **P0** |
| 4   | 每轮 system reminder（`criticalSystemReminder`）    | Claude Code                         | 约束易跑偏的 verifier/reviewer 类代理                                 | 低                                          | **P1** |
| 5   | Agent mailbox / SendMessage 工具                    | Claude Code / pi-subagents intercom | 多 agent 协作的最小可用形态                                           | 高（需要可寻址 agent + 消息队列）           | **P1** |
| 6   | 异步 / 后台 agent（`async: true`）                  | Claude Code / pi-subagents          | 长跑验证、监控类场景                                                  | 高（持久化 + 通知回灌）                     | **P2** |
| 7   | Fork 路径共享 prompt cache                          | Claude Code                         | 降低 `defaultContext: 'fork'` 首 token 成本                           | 中（要让子进程的 system prompt 字节级稳定） | **P2** |
| 8   | Worktree setup hook + diff 收集                     | pi-subagents                        | 子代理在干净 worktree 里 `bun install` 后再工作；完成时回收 diff 摘要 | 低                                          | **P1** |
| 9   | 嵌套事件路由（父子事件树聚合到顶层 UI）             | pi-subagents                        | 现在 chain 内 chain 的可观测性会断                                    | 中                                          | **P2** |
| 10  | 工具白名单支持 MCP 直工具（`mcp:filesystem`）       | pi-subagents                        | 让 agent 显式声明依赖的 MCP 资源                                      | 低                                          | **P1** |

## 四、不推荐借鉴的部分

- **Claude Code 的进程内 AsyncGenerator 模型**：pi-agents 走子进程方向是对的，避免了上下文窗口在父子间的耦合污染，也方便用 `pi` 命令本身做 dogfooding。
- **pi-subagents 的 intercom + 嵌套事件路由全栈**：复杂度高且和 pi-agents 现有 stop-reason / completion-check 设计正交，建议先做轻量 mailbox（#5），等真正有需求再升级到 intercom 级别。
- **Claude Code 的 `isolation: "remote"`（CCR）**：当前没有远程执行场景。

## 五、近期推荐落地顺序

1. **P0 三件套（结构化输出 + 动态扇出 + package agents）**：这套组合让 pi-agents 从"调度器"进化为"可被生态扩展的工作流引擎"，且 ROI 最直接。
2. **P1 四件套（system reminder、mailbox 雏形、worktree hook、MCP 工具声明）**：补齐边角，提升可用性。
3. **P2 三件套（async、prompt cache、嵌套事件路由）**：等 P0/P1 落地后再评估，多数依赖前面打的基础。

## 六、关键代码引用速查

### pi-agents

- 工具注册：`packages/pi-agents/src/index.ts:27-34`
- 模式分发：`packages/pi-agents/src/tool.ts`（single/parallel/chain）
- 子进程执行：`packages/pi-agents/src/execution.ts`（`runSingleAgent`、JSON 事件流）
- 模板替换：`packages/pi-agents/src/template.ts`（`{previous}`, `{outputs.<name>}`）
- 完成校验：`packages/pi-agents/src/completion-check.ts`
- 常量：`packages/pi-agents/src/constants.ts`（`MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `DEFAULT_AGENT_MAX_DEPTH=2`）

### Claude Code（`/home/julian/workspace/source/claude-code-2.1.88/package-src/src`）

- 工具入口：`tools/AgentTool/AgentTool.tsx`
- 子代理运行：`tools/AgentTool/runAgent.ts`
- Fork 实验：`tools/AgentTool/forkSubagent.ts` + `utils/forkedAgent.ts`
- 异步生命周期：`tools/AgentTool/agentToolUtils.ts:runAsyncAgentLifecycle`
- SendMessage：`tools/SendMessageTool/SendMessageTool.ts`
- 工具过滤名单：`constants/tools.ts`（`ALL_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS`）

### pi-subagents（`/home/julian/workspace/source/pi-subagents`）

- 入口：`src/extension/index.ts`
- 参数 schema：`src/extension/schemas.ts`
- 主调度：`src/runs/foreground/subagent-executor.ts`
- 动态扇出：`src/runs/shared/dynamic-fanout.ts`
- 输出契约：`src/runs/shared/chain-outputs.ts`
- 异步执行：`src/runs/background/async-execution.ts`
- Intercom 桥：`src/intercom/intercom-bridge.ts`
- Worktree：`src/runs/shared/worktree.ts`
