# Changelog

## [0.1.0](https://github.com/balaenis/pi-toolset/compare/pi-agents-v0.0.1...pi-agents-v0.1.0) (2026-07-01)


### ⚠ BREAKING CHANGES

* **pi-agents:** `completionGuard` field is replaced by `completionCheck: string[]`.

### Features

* **pi-agents:** add agent config overrides and remove confirmation prompt ([224a61f](https://github.com/balaenis/pi-toolset/commit/224a61fe142f25f48fce3d24320313b7e27e2203))
* **pi-agents:** add background agent execution with session-scoped job manager ([abac49b](https://github.com/balaenis/pi-toolset/commit/abac49b89ebe7108a00125a8079fac6ec273df98))
* **pi-agents:** add completion guard and worktree isolation for mutating agents ([c3765c0](https://github.com/balaenis/pi-toolset/commit/c3765c027a954353f7975f659d0a7f0411a5657d))
* **pi-agents:** add dynamic fanout and collect chain steps ([00ceab9](https://github.com/balaenis/pi-toolset/commit/00ceab9265ac2cddfae7e683f965230471354a39))
* **pi-agents:** add frontmatter extensions and security depth guard ([0b3f135](https://github.com/balaenis/pi-toolset/commit/0b3f13512de2d1a2fc319f9d5badfb4c8d9c73e7))
* **pi-agents:** add named chain outputs with {outputs.&lt;name&gt;} template syntax ([243010f](https://github.com/balaenis/pi-toolset/commit/243010f83e325ed8fac782df8978061460ed130f))
* **pi-agents:** add per-agent maxSubagentDepth and PI_AGENT_TOOL_AVAILABLE guard ([943ff8c](https://github.com/balaenis/pi-toolset/commit/943ff8c174c016631321bb679ecf3617099a00e4))
* **pi-agents:** add structured output extraction and schema subset validator ([a5ca754](https://github.com/balaenis/pi-toolset/commit/a5ca754553151dbd432aa1f6e7fa0a5b9bfcb522))
* **pi-agents:** add subagent package for delegating tasks to specialized agents ([2da9035](https://github.com/balaenis/pi-toolset/commit/2da9035ffb9eea4cc1e6980252eff8e814587cd8))
* **pi-agents:** add worktreeSetupHook and criticalSystemReminder ([986ec2c](https://github.com/balaenis/pi-toolset/commit/986ec2c069eb26b359f44aef1aacbdf3430b7b06))
* **pi-agents:** implement fork-context via prepareAgentContext and runStepWithContext ([a925f9b](https://github.com/balaenis/pi-toolset/commit/a925f9b21fd6a5d6106ec46ec8bae142aa9140e0))
* **pi-agents:** replace completionGuard boolean with configurable completionCheck ([3ed738f](https://github.com/balaenis/pi-toolset/commit/3ed738f568eb93225c2e45acf9d88fbbddd3079c))
* **pi-agents:** rework package agent discovery via settings.json packages[] ([f4ccb69](https://github.com/balaenis/pi-toolset/commit/f4ccb69a207f02506352dc17fa492290221eb53d))
* **pi-agents:** show thinking level in usage stats display ([082df64](https://github.com/balaenis/pi-toolset/commit/082df6418787391c4224fa385a8eed1c8bb65d25))
* **pi-agents:** support package-published agents under project scope ([c5a5149](https://github.com/balaenis/pi-toolset/commit/c5a5149b7775d5cd800b1abe0f36c477bc812b5c))
* **pi-agents:** validate structured chain outputs ([313de8c](https://github.com/balaenis/pi-toolset/commit/313de8c6fbe2e18ee9438381ff5477e10de12fd7))
* **pi-agents:** wire up maxTurns, systemPromptMode, noContextFiles, noSkills runtime behavior ([be6e668](https://github.com/balaenis/pi-toolset/commit/be6e668fb987f3d98ffcadaf61e434957233922f))
