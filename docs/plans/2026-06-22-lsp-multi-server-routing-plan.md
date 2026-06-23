# LSP Multi-Server Routing Implementation Plan

**Goal:** Allow `pi-lsp` to support one file being served by one primary language server plus zero or more companion servers, while keeping LLM-facing LSP features focused on diagnostics and code navigation.

**Inputs:** Conversation requirements from 2026-06-22; existing `packages/pi-lsp/src/{config,manager,client,instance,tools,diagnostics,recipes,types}.ts`; tests in `packages/pi-lsp/tests/`; package instructions in `AGENTS.md`.

**Assumptions:**

- Primary language servers provide navigation and language understanding; companion servers provide additive diagnostics or contextual help such as lint and Tailwind CSS.
- This plan does not add new LLM tool operations like completion, formatting, or codeAction; it only makes current operations and diagnostics route correctly when multiple servers cover the same file.
- Existing user-configured primary replacements such as `vtsls` covering `.ts` should continue to suppress the built-in `typescript` recipe unless the user explicitly opts into another behavior.
- Companion servers may overlap extensions with primary servers without suppressing primary recipes.
- Every server, whether built-in or user-configured, has a unified `startupMode: 'auto' | 'manual'` setting. The default is `auto`; `manual` servers are configured and visible, but they do not participate in automatic file routing until explicitly started for the session.
- Broad companion servers such as Tailwind CSS should be configured with `startupMode: 'manual'` by default when shipped as recipes, so a globally installed executable does not affect every JS/TS project.

**Architecture:** Introduce server role metadata, startup mode, and routing policies. Recipe detection and user config both produce the same normalized server config shape; `startupMode` controls whether a server is automatically active for matching files or only becomes active after `/lsp start`. File lifecycle notifications fan out to all active servers that cover the file, while LLM-facing navigation requests remain primary-only for the current tool operations. Passive diagnostics are collected from every active server and tagged by source server so TypeScript, ESLint, Tailwind, and similar diagnostics can coexist without stale or accidental overwrites.

**Tech Stack:** TypeScript, Bun test runner, `vscode-jsonrpc`, `vscode-languageserver-protocol`, Pi extension API, existing `mise` tasks.

---

## File Map

- Modify: `packages/pi-lsp/src/types.ts` — add server role, conflict group, startup mode, and routing-oriented config fields.
- Modify: `packages/pi-lsp/src/config.ts` — normalize `startupMode` for user and recipe configs, preserve primary recipe replacement behavior, and allow active companion servers to overlap extensions.
- Modify: `packages/pi-lsp/src/recipes.ts` — mark existing recipes as primary and auto-starting; require broad companion recipes to be manual-starting by default before they are added later.
- Modify: `packages/pi-lsp/src/manager.ts` — replace single-server file routing with candidate, primary, and fan-out helpers; keep current tool requests primary-only.
- Modify: `packages/pi-lsp/src/diagnostics.ts` — key diagnostics by server and URI so multiple servers can publish diagnostics for the same file.
- Modify: `packages/pi-lsp/src/index.ts` — sync edited files to all candidate servers and notify missing-server cases using the primary/candidate model.
- Modify: `packages/pi-lsp/src/tools.ts` — use primary-only routing for existing navigation operations and improve missing-server messages when candidates exist but primary is absent or failed.
- Modify: `packages/pi-lsp/src/command.ts` — include role and conflict group in `/lsp status` details.
- Test: `packages/pi-lsp/tests/config.test.ts` — cover primary replacement, companion overlap behavior, and startup mode normalization.
- Test: `packages/pi-lsp/tests/manager.test.ts` — cover lifecycle fan-out, primary-only requests, and per-server open tracking.
- Test: `packages/pi-lsp/tests/diagnostics.test.ts` — cover multi-server diagnostics for the same URI.
- Modify: `packages/pi-lsp/README.md` — document server roles, replacement behavior, and companion server configuration.

## Tasks

### Task 1: Add server role and startup mode metadata to config types

**Outcome:** Every server config has an explicit normalized role and startup mode, and existing configs continue to work as primary auto-starting servers by default.

**Files:**

- Modify: `packages/pi-lsp/src/types.ts`
- Modify: `packages/pi-lsp/src/config.ts`
- Test: `packages/pi-lsp/tests/config.test.ts`

**Steps:**

- [ ] Add `export type LspServerRole = 'primary' | 'companion';` to `types.ts`.
- [ ] Add `export type LspStartupMode = 'auto' | 'manual';` to `types.ts`.
- [ ] Add optional `role?: LspServerRole`, `startupMode?: LspStartupMode`, and `conflictGroup?: string` to `ScopedLspServerConfig`.
- [ ] Extend raw config normalization in `config.ts` to accept only `primary` or `companion` when `role` is present.
- [ ] Extend raw config normalization in `config.ts` to accept only `auto` or `manual` when `startupMode` is present.
- [ ] Default omitted `role` to `primary` for backward compatibility.
- [ ] Default omitted `startupMode` to `auto` for backward compatibility.
- [ ] Default omitted `conflictGroup` to the server name for primary servers and leave it undefined for companion servers.
- [ ] Add a config test that a user server without `role` or `startupMode` normalizes to `role: 'primary'` and `startupMode: 'auto'`.
- [ ] Add a config test that `role: 'companion'` and `startupMode: 'manual'` are accepted and preserved.
- [ ] Add a config test that an invalid role or startup mode logs/filters the invalid server and allows valid recipes to continue.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: all existing tests pass, and new config tests pass.

### Task 2: Update recipe merge rules for role and startup mode

**Outcome:** User-configured companion servers no longer suppress primary built-in recipes, and manual-starting servers do not accidentally disable auto-starting defaults.

**Files:**

- Modify: `packages/pi-lsp/src/config.ts`
- Modify: `packages/pi-lsp/src/recipes.ts`
- Test: `packages/pi-lsp/tests/config.test.ts`
- Test: `packages/pi-lsp/tests/recipes.test.ts`

**Steps:**

- [ ] Add `role: 'primary'` and `startupMode: 'auto'` to each existing built-in primary recipe-derived server config emitted by `getDetectedRecipeServers()`.
- [ ] Keep current name-collision behavior: any user server with the same name as a recipe suppresses that recipe because it is an explicit override.
- [ ] Change extension-overlap suppression to consider only user servers with `role: 'primary'` and `startupMode: 'auto'` when deciding whether to skip an auto primary recipe.
- [ ] Do not let user companion coverage add extensions to `userCoveredExtensions` for primary recipe suppression.
- [ ] Do not let user manual primary coverage suppress an auto primary recipe by extension overlap; users who want a full replacement can use the same server name or set the replacement to `startupMode: 'auto'`.
- [ ] Add a config test where a user `eslint` companion covers `.ts` and `typescript-language-server` is on PATH; expected servers are `eslint` and `typescript`.
- [ ] Add a config test where a user `tailwindcss` companion covers `.ts` with `startupMode: 'manual'` and `typescript-language-server` is on PATH; expected servers are `tailwindcss` and `typescript`, with Tailwind inactive until started.
- [ ] Keep the existing config test where user `my-ts` covers `.ts` as an auto primary server and suppresses the `typescript` recipe.
- [ ] Add a recipes test that detected existing primary recipe servers have `role: 'primary'` and `startupMode: 'auto'`.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: TypeScript recipe remains when only a companion or manual primary overlaps; TypeScript recipe is still skipped when an auto primary user server overlaps.

### Task 3: Add manual startup state and command integration

**Outcome:** Manual servers are available in status/start UI but do not participate in file routing until the user explicitly starts them for the current session.

**Files:**

- Modify: `packages/pi-lsp/src/manager.ts`
- Modify: `packages/pi-lsp/src/command.ts`
- Modify: `packages/pi-lsp/src/types.ts`
- Test: `packages/pi-lsp/tests/manager.test.ts`
- Test: `packages/pi-lsp/tests/command.test.ts`

**Steps:**

- [ ] Add a manager-level `manualEnabledServers: Set<string>` that is empty at session start and cleared on shutdown.
- [ ] Add `isServerAutoActive(server)` returning true when `server.config.startupMode !== 'manual'`.
- [ ] Add `isServerManuallyActive(server)` returning true when `manualEnabledServers` contains the server name.
- [ ] Add `isServerActive(server)` returning true for auto-active servers or manually active servers.
- [ ] Update `/lsp start` so starting a manual server adds its name to `manualEnabledServers` only after `server.start()` succeeds.
- [ ] Update `/lsp start` so stopping a manual server removes its name from `manualEnabledServers`.
- [ ] Keep auto servers compatible with the existing `/lsp start` behavior; stopping an auto server does not permanently disable it, so a later matching file operation may start it again.
- [ ] Update status details and picker rows to show `startup: auto` or `startup: manual`, and for manual servers show whether they are active in the current session.
- [ ] Add a manager test where a manual Tailwind companion covers `.ts`; before manual enable it is not returned by active server routing, after manual enable it is returned.
- [ ] Add a command formatting test that manual servers show their startup mode and active/inactive session status.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: manual servers remain visible but inactive until started, then participate in active routing for the current session.

### Task 4: Introduce multi-server file routing in the manager

**Outcome:** The manager can distinguish configured servers from active servers, return the active primary server for a file, and track that one URI is open in multiple server instances.

**Files:**

- Modify: `packages/pi-lsp/src/manager.ts`
- Modify: `packages/pi-lsp/src/types.ts`
- Test: `packages/pi-lsp/tests/manager.test.ts`

**Steps:**

- [ ] Add `getConfiguredServersForFile(filePath): LSPServerInstance[]` to return every configured server whose `extensionToLanguage` covers the file extension, including inactive manual servers.
- [ ] Add `getServersForFile(filePath): LSPServerInstance[]` to return only active servers: auto servers plus manual servers enabled by `/lsp start`.
- [ ] Keep `getServerForFile(filePath)` as a backward-compatible alias for `getPrimaryServerForFile(filePath)`.
- [ ] Add `getPrimaryServerForFile(filePath): LSPServerInstance | undefined` that returns the first active primary server covering the extension, falling back to the first active candidate only when no active candidate has a role.
- [ ] Change `openedFiles` from `Map<string, string>` to `Map<string, Set<string>>` so a URI can be open in multiple servers.
- [ ] Add helper `isFileOpenInServer(fileUri, serverName)` and update `isFileOpen(filePath)` to return true when the active primary server has the file open.
- [ ] Add unit tests using fake `LSPServerInstance` objects or a test-only client factory to prove `.js` can map to configured `typescript`, `eslint`, and manual `tailwindcss` candidates, while active routing excludes Tailwind before it is enabled.
- [ ] Add a unit test that `getServerForFile()` returns the active primary server even when active companions are registered before or after it.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: manager routing tests pass, inactive manual servers are excluded from automatic routing, and existing tool behavior still targets one active primary server for requests.

### Task 5: Fan out document lifecycle notifications

**Outcome:** Any active server that covers a file receives document open/change/save/close notifications, allowing active companion servers to publish diagnostics for the same file.

**Files:**

- Modify: `packages/pi-lsp/src/manager.ts`
- Modify: `packages/pi-lsp/src/index.ts`
- Test: `packages/pi-lsp/tests/manager.test.ts`

**Steps:**

- [ ] Change `openFile(filePath, content)` to start all active candidate servers for the file and send `textDocument/didOpen` to each active candidate not already opened for that URI.
- [ ] Use each server's own `extensionToLanguage[ext]` mapping when sending `languageId`.
- [ ] Change `changeFile(filePath, content)` to send `textDocument/didChange` to every running active candidate that has the file open; if an active candidate is not open, call the shared open helper for that candidate.
- [ ] Change `saveFile(filePath)` to send `textDocument/didSave` to every running active candidate with the file open.
- [ ] Change `closeFile(filePath)` to send `textDocument/didClose` to every running active candidate with the file open and remove each server from the URI's opened set.
- [ ] Change `syncFileChange(filePath)` to read once and fan out change/save to all active candidates.
- [ ] Update `index.ts` edit/write hook to call active-candidate-aware sync and only surface a missing-server notification when no configured server covers the file, all active candidates fail to start, or only inactive manual servers cover the file.
- [ ] Add manager tests that `didOpen`, `didChange`, `didSave`, and `didClose` are sent to both primary and active companion servers for the same extension.
- [ ] Add a regression test that inactive manual companions receive no lifecycle notifications until `/lsp start` enables them.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: lifecycle fan-out tests pass; inactive manual servers are not started by file events; no test observes duplicate `didOpen` for a server that already has the URI open.

### Task 6: Keep current LLM tool requests primary-only

**Outcome:** Existing `lsp` tool operations continue to produce one clear result from the primary language server, avoiding merged navigation ambiguity.

**Files:**

- Modify: `packages/pi-lsp/src/manager.ts`
- Modify: `packages/pi-lsp/src/tools.ts`
- Test: `packages/pi-lsp/tests/manager.test.ts`

**Steps:**

- [ ] Change `sendRequest(filePath, method, params)` to use `getPrimaryServerForFile(filePath)` rather than the first extension candidate.
- [ ] Keep these existing operations primary-only: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`.
- [ ] Update missing-server error text in `tools.ts` to distinguish no configured server, only inactive manual servers, no active primary server, and active primary server failed to start.
- [ ] Add a manager test where `.js` has one active primary, one active companion, and one inactive manual companion, then assert `sendRequest('textDocument/definition')` is sent only to the active primary.
- [ ] Add a regression test that lifecycle fan-out still opens the file in active companions before the primary-only request is made.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: current tool operations remain single-result operations, do not call companion servers for navigation requests, and do not auto-start inactive manual servers.

### Task 7: Store diagnostics per server and URI

**Outcome:** Diagnostics from multiple servers for the same file are preserved and delivered to the LLM without overwriting each other.

**Files:**

- Modify: `packages/pi-lsp/src/diagnostics.ts`
- Modify: `packages/pi-lsp/src/manager.ts`
- Test: `packages/pi-lsp/tests/diagnostics.test.ts`

**Steps:**

- [ ] Change `diagnostics.register(uri, diagnostics)` to `diagnostics.register(serverName, uri, diagnostics)`.
- [ ] Key pending diagnostics by `${serverName}\0${uri}` internally while preserving file-grouped output in `drain()`.
- [ ] Include `serverName` in the stored diagnostic key so identical messages from TypeScript and ESLint are not deduplicated as one issue.
- [ ] Include the server name in formatted diagnostic output when `diag.source` is absent or different enough to be useful, using a stable suffix like `(server: typescript)`.
- [ ] Update `manager.ts` publishDiagnostics handler to pass `serverName` into `diagnostics.register()`.
- [ ] Update `clearForFile(uri)` to clear all pending and delivered entries for that URI across all servers.
- [ ] Add tests where `typescript` and `eslint` publish diagnostics for the same URI and both appear in one drained block.
- [ ] Add a test where an empty publish from `eslint` clears only ESLint diagnostics and does not clear pending TypeScript diagnostics for the same URI.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: same-file diagnostics from multiple servers are delivered and per-server clearing works.

### Task 8: Surface roles, startup mode, and active state in status output and documentation

**Outcome:** Users can understand why overlapping servers coexist, which servers are automatic or manual, and how to enable manual companion servers only when needed.

**Files:**

- Modify: `packages/pi-lsp/src/command.ts`
- Modify: `packages/pi-lsp/README.md`
- Test: `packages/pi-lsp/tests/command.test.ts`

**Steps:**

- [ ] Update `/lsp status` server details to include `role: primary` or `role: companion`.
- [ ] Update `/lsp status` server details to include `startup: auto` or `startup: manual`.
- [ ] Include `manual active: yes/no` for manual servers.
- [ ] Include `conflictGroup` only when present.
- [ ] Update command tests to assert role, startup mode, and manual active state appear for formatted server details.
- [ ] Add README configuration examples for a primary replacement server such as `vtsls`.
- [ ] Add README configuration examples for a companion server such as ESLint covering `.js`, `.jsx`, `.ts`, and `.tsx` without suppressing TypeScript.
- [ ] Add README configuration examples for a manual companion server such as Tailwind CSS covering `.js`, `.jsx`, `.ts`, and `.tsx` but only participating after `/lsp start`.
- [ ] Document that current LLM tool navigation operations target the active primary server and passive diagnostics are collected from all active candidate servers.

**Validation:**

- Run: `mise run test --package packages/pi-lsp`
- Expected: command formatting tests pass and README examples match the normalized `role`, `startupMode`, and `extensionToLanguage` fields.

## Final Validation

- Run: `mise run test --package packages/pi-lsp`
- Expected: all package tests pass.
- Run: `mise run typecheck --package packages/pi-lsp`
- Expected: TypeScript completes without errors.
- Run: `mise run build --package packages/pi-lsp`
- Expected: package builds successfully.
- Run: `hk check`
- Expected: repo-wide eslint and prettier checks pass.

## Rollout Notes

- This change is backward compatible for existing user configs because omitted `role` defaults to `primary`, omitted `startupMode` defaults to `auto`, and existing auto primary-overlap recipe suppression remains.
- Companion server configs are newly meaningful only after lifecycle fan-out lands; before that, they may be configured but will not receive document synchronization for overlapping extensions.
- Do not add ESLint, Tailwind CSS, Biome, Ruff, or Stylelint recipes in the same implementation unless the routing, startup mode, and diagnostics tasks above are complete and validated.
- If a future task adds broad companion recipes, they should set `role: 'companion'` and `startupMode: 'manual'` by default unless there is a separate, explicit decision to auto-start them.
- For Tailwind CSS specifically, do not auto-start the recipe just because `tailwindcss-language-server` is on PATH; configure it as `startupMode: 'manual'` so users enable it with `/lsp start` only in projects that need it.

## Risks and Mitigations

- Risk: Multiple servers for one file increase startup cost. — Mitigation: keep lazy startup behavior and only start active candidates when the file is opened, synced after edit, or queried.
- Risk: Broad companion servers activate in unrelated projects. — Mitigation: set broad companion recipes to `startupMode: 'manual'` by default and let users enable them per session with `/lsp start`.
- Risk: Users expect stopping an auto server to disable it permanently. — Mitigation: document that `startupMode: 'auto'` servers may restart on later matching file operations; use `startupMode: 'manual'` for opt-in behavior.
- Risk: Duplicate diagnostics may overwhelm the LLM. — Mitigation: retain existing per-file and total diagnostic caps, but key by server to avoid accidental data loss.
- Risk: Companion servers may require workspace configuration. — Mitigation: keep current `settings` and `initializationOptions` paths; document server-specific configuration rather than hardcoding ESLint or Tailwind behavior.
- Risk: Primary server selection can be surprising if two primary user servers cover the same extension. — Mitigation: preserve insertion order for now, document that overlapping primary servers are replacement/conflict scenarios, and add a debug/status surface showing selected roles.
- Risk: Formatting/codeAction/completion routing is more complex than diagnostics/navigation. — Mitigation: keep them out of this plan and require a separate method-policy implementation before exposing those operations to the LLM.
