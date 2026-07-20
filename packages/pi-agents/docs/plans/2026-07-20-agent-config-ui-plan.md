# Agent Config UI Implementation Plan

**Goal:** Add TUI `/agent config` so users can inspect effective agent settings (with layer provenance), edit session-scoped overrides by default, and save dirty fields to user or project `config.json`.

**Inputs:** Product analysis of existing agent override stack; locked decisions (2026-07-20): (1) command `/agent config` only, (2) session persistence = in-memory + `appendEntry`, (3) disk save writes dirty fields only, (4) after save do not clear session overrides; current code in `packages/pi-agents/src/agents.ts`, `command.ts`, `index.ts`, `tool.ts`, `interactive-view.ts`; Pi 0.80.x extension/TUI APIs (`ctx.ui.custom`, `SettingsList`, `SelectList`, `matchesKey`, `pi.appendEntry`, `ctx.isProjectTrusted`); Pi example `examples/extensions/tools.ts` for session-branch restore.

**Assumptions:**

- Project config write path: if an ancestor `.pi` exists, write under that tree’s `@balaenis/pi-agents/config.json`; otherwise create `<ctx.cwd>/.pi/@balaenis/pi-agents/config.json`.
- Freeform string fields use an in-custom-UI submenu with `Input` from `@earendil-works/pi-tui` (not a second non-overlay `ctx.ui.custom` stack).
- `/agent config <name>` direct-open is in scope when `<name>` matches a discovered catalogue name; unknown name notifies and falls back to the list.
- Session entry schema version is `1`; unknown/newer versions are ignored (session overlay empty) rather than migrated.
- Description is overridable in session/disk (already allowed by `AgentOverride`); `systemPrompt` remains non-overridable and is shown read-only or omitted from the editor field list.
- Non-TUI modes: `/agent config` notifies that the editor is TUI-only (no JSON dump in V1).

**Architecture:** Introduce a session-scoped override store (memory + branch custom entry) and a pure config layer API that merges `frontmatter < user < project < session`, exposes per-field provenance for the UI, and can write field-level patches to user/project `config.json`. Wire the store through discovery so tool, slash, and catalogue paths all see session overrides. The TUI is a two-level `ctx.ui.custom` surface: agent `SelectList` then field `SettingsList`, with `Ctrl+S` / `Ctrl+Shift+S` saving only dirty keys for the current agent.

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-coding-agent` Extension API, `@earendil-works/pi-tui` (`SelectList`, `SettingsList`, `Input`, `Container`, `Text`, `matchesKey`), existing `discoverAgents` / `AgentConfig` pipeline, Mise (`mise run test|typecheck --package packages/pi-agents`).

---

## Locked Product Decisions

| Decision        | Value                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| Command         | `/agent config` (no `/agents` alias)                                           |
| Session storage | In-memory map + `pi.appendEntry` on the host session branch                    |
| Disk save scope | Dirty fields of the **current agent only**                                     |
| After disk save | Keep session overrides; only clear dirty marks for saved keys                  |
| Agent list      | Same set as `/agent list` → `discoverAgents(cwd, 'both')` (plus session merge) |
| Display         | Effective values after full merge, with winning-layer badge                    |

## Out of Scope

- Editing `systemPrompt` body or creating/deleting agent `.md` files
- Pi core changes
- `/agents` command alias
- RPC/print interactive editor or `--json` dump
- Batch “reset all agents” or “pin effective value without edit”
- Automatic migration of older session entries beyond ignore-unknown
- Changing fingerprint fail-closed behavior for in-flight/resumable units
- Multi-process locked config writes (last-writer-wins with atomic rename is enough)

## File Map

- Create: `packages/pi-agents/src/agent-config.ts` — override types, layer merge/inspect, config path resolution, atomic read-merge-write for `config.json`
- Create: `packages/pi-agents/src/session-agent-config.ts` — session store (memory + entry serialize/restore), dirty tracking helpers, custom entry type constant
- Create: `packages/pi-agents/src/agent-config-ui.ts` — TUI list + field editor, save keybindings, open API used by command
- Modify: `packages/pi-agents/src/agents.ts` — export `AgentOverride` / parsers needed by writers; add optional session overrides to `discoverAgents`; export project-config-dir helper used by writers; keep existing disk merge order
- Modify: `packages/pi-agents/src/command.ts` — `config` subcommand + completions; pass session store into discovery/UI
- Modify: `packages/pi-agents/src/index.ts` — create/restore store on `session_start` / `session_tree`; inject store into command + tool discovery paths; clear/replace store on session replacement
- Modify: `packages/pi-agents/src/tool.ts` — when resolving agents, merge session overrides from injected getter/store
- Modify: `packages/pi-agents/src/interactive-agent.ts` — discovery used for fingerprint/restore must include session overrides via the same options path (pass through existing `discoverAgentsFn` or options)
- Modify: `packages/pi-agents/README.md` — mention `/agent config` and session/save keys
- Modify: `packages/pi-agents/docs/how-to.md` — guide for interactive config + save
- Modify: `packages/pi-agents/docs/reference.md` — command table, session layer, dirty-save semantics, entry type
- Modify: `packages/pi-agents/docs/explanation.md` — override stack including session
- Test: `packages/pi-agents/tests/agent-config.test.ts` — layer inspect, merge order, dirty patch write, atomic merge preserves siblings
- Test: `packages/pi-agents/tests/session-agent-config.test.ts` — entry round-trip, restore last branch entry, ignore bad versions
- Test: `packages/pi-agents/tests/agents.test.ts` — session overrides beat project/user; discoverAgents options wiring
- Test: `packages/pi-agents/tests/command.test.ts` — `config` completion/dispatch; non-TUI warning; optional name arg routing (UI factory stubbed)

## Tasks

### Task 1: Config layer API and disk write

**Outcome:** Pure functions can load layered overrides, compute effective configs with provenance, and merge-write dirty field patches to user/project `config.json` without clobbering other agents or fields.

**Files:**

- Create: `packages/pi-agents/src/agent-config.ts`
- Modify: `packages/pi-agents/src/agents.ts`
- Test: `packages/pi-agents/tests/agent-config.test.ts`
- Test: `packages/pi-agents/tests/agents.test.ts`

**Steps:**

- [ ] Export `AgentOverride` from `agents.ts` (currently file-private). Reuse `parseAgentOverride` logic by exporting a single public `parseAgentOverride(raw: unknown): AgentOverride` (or re-home it in `agent-config.ts` and have `agents.ts` import it — prefer **one** implementation in `agent-config.ts`, imported by `agents.ts`, to avoid drift).
- [ ] Move or dual-export constants: package dir `@balaenis/pi-agents`, file `config.json`. Keep `CONFIG_DIR_NAME` via Pi.
- [ ] Export path helpers:
  - `userAgentConfigPath(): string` → `path.join(getAgentDir(), '@balaenis', 'pi-agents', 'config.json')`
  - `resolveProjectConfigDir(cwd: string): string | null` — existing nearest-`.pi` walk
  - `projectAgentConfigPath(cwd: string): string` — if nearest `.pi` exists, join package dir + `config.json`; else `path.join(cwd, '.pi', '@balaenis', 'pi-agents', 'config.json')`
- [ ] Define:

```ts
export type OverrideLayer = 'frontmatter' | 'user' | 'project' | 'session';

export type OverridableAgentField =
  | 'description'
  | 'model'
  | 'thinking'
  | 'tools'
  | 'excludeTools'
  | 'systemPromptMode'
  | 'maxTurns'
  | 'noContextFiles'
  | 'noSkills'
  | 'skills'
  | 'defaultContext'
  | 'isolation'
  | 'completionCheck'
  | 'maxSubagentDepth'
  | 'worktreeSetupHook'
  | 'runtime';

export interface FieldResolution {
  effective: unknown;
  source: OverrideLayer;
  layers: Partial<Record<OverrideLayer, unknown>>;
}

export interface AgentConfigInspection {
  name: string;
  source: AgentSource;
  filePath: string;
  systemPrompt: string; // always from definition; not overridable
  effective: AgentConfig;
  fields: Record<OverridableAgentField, FieldResolution>;
}
```

- [ ] Implement `loadDiskOverrideMaps(cwd, scope)` returning `{ user: Map<string, AgentOverride>; project: Map<string, AgentOverride> }` using the same JSON shape `{ agents: { [name]: override } }` as today.
- [ ] Implement `mergeAgentOverride(...parts: Array<AgentOverride | undefined>): AgentOverride` as shallow field merge (later maps win). Arrays replace, not concat.
- [ ] Implement `inspectAgentConfig(base: AgentConfig, layers: { user?: AgentOverride; project?: AgentOverride; session?: AgentOverride }): AgentConfigInspection`:
  - Start each field from frontmatter-derived base (the pre-disk-merge agent from file load).
  - Apply user → project → session.
  - Record which layer last set each field.
  - `effective` is full `AgentConfig` after merge (same result as today’s disk merge + session).
- [ ] Change discovery load path so base agent is file definition **without** disk overrides, then apply user/project/session in one place. Concrete approach:
  1. Keep file loading as today into `agentMap`.
  2. Load user/project maps as today.
  3. Accept optional `sessionOverrides?: ReadonlyMap<string, AgentOverride>`.
  4. For each agent: `effective = { ...fileAgent, ...merge(user, project, session) }` with only defined keys from overrides (same as current `{ ...agent, ...override }`).
- [ ] Extend signature:

```ts
export interface DiscoverAgentsOptions {
  sessionOverrides?: ReadonlyMap<string, AgentOverride>;
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  options?: DiscoverAgentsOptions
): AgentDiscoveryResult;
```

All existing callers remain valid (`options` optional). Session map keys are full catalogue names.

- [ ] Implement `writeAgentConfigPatch(configPath: string, agentName: string, patch: AgentOverride): void`:
  - `parseAgentOverride(patch)`; if empty after parse, no-op (or still ensure file exists only when non-empty — prefer no-op).
  - Read existing JSON if present; on missing/malformed start from `{ agents: {} }`.
  - Merge `agents[agentName] = { ...existingAgentOverride, ...patch }` field-level.
  - Do not write keys outside `AgentOverride`.
  - Atomic write: write temp file in same directory then `rename`. Create parent dirs with `mkdirSync(..., { recursive: true })`.
  - Preserve unknown top-level keys in the JSON object if present (only require `agents` object).
- [ ] Add `formatOverrideValue` / equality helper for dirty diffs (normalize arrays by value equality; booleans/numbers/strings strict).

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/agent-config.test.ts tests/agents.test.ts`
- Expected: existing override tests pass; new tests prove project > user > frontmatter, session > project, write patch merges without deleting sibling agents/fields, malformed existing file replaced safely with valid structure after write of one agent patch, `discoverAgents(cwd,'both',{sessionOverrides})` applies session model over project model.

### Task 2: Session store (memory + appendEntry)

**Outcome:** A session-scoped store holds per-agent overrides, persists full overlay snapshots to the host session branch, restores from the latest branch entry on `session_start` / `session_tree`, and tracks dirty keys for disk save without clearing session values after save.

**Files:**

- Create: `packages/pi-agents/src/session-agent-config.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/session-agent-config.test.ts`

**Steps:**

- [ ] Define custom entry type constant: `PI_AGENTS_AGENT_CONFIG_ENTRY = 'pi-agents-agent-config'`.
- [ ] Define entry payload:

```ts
interface SessionAgentConfigEntryV1 {
  version: 1;
  agents: Record<string, AgentOverride>;
}
```

- [ ] Implement `SessionAgentConfigStore`:
  - Private `overrides: Map<string, AgentOverride>`
  - Private `dirty: Map<string, Set<OverridableAgentField>>` keyed by agent name
  - `getOverrides(): ReadonlyMap<string, AgentOverride>`
  - `getAgentOverride(name: string): AgentOverride`
  - `setField(agentName: string, field: OverridableAgentField, value: unknown): void` — parse/validate via shared parsers; update override; add field to dirty set; if value equals “cleared” policy (see below), delete field from override
  - `clearField(agentName: string, field: OverridableAgentField): void` — remove key from session override (inherit lower layers); mark dirty so a later save can remove disk key **only if we support disk delete** — **V1: session clear does not delete disk keys**; dirty means “session value changed since last save mark”, and disk save writes current session values for dirty keys only (presence). Clearing a session field removes it from dirty write set if the field is no longer in session (do not write `null` tombstones in V1).
  - `getDirtyFields(agentName: string): OverridableAgentField[]`
  - `markSaved(agentName: string, fields: OverridableAgentField[]): void` — drop those fields from dirty set only
  - `replaceAll(agents: Record<string, AgentOverride>): void` — used on restore; **clears dirty**
  - `snapshot(): SessionAgentConfigEntryV1`
  - `toMap(): Map<string, AgentOverride>`
- [ ] Field set validation: reject invalid enum/number/bool the same way frontmatter/config parsing does (ignore invalid → no state change + optional throw for UI to notify).
- [ ] Persist helper `persistToSession(pi: ExtensionAPI, store: SessionAgentConfigStore): void` → `pi.appendEntry(PI_AGENTS_AGENT_CONFIG_ENTRY, store.snapshot())`.
- [ ] Restore helper `restoreFromBranch(ctx: ExtensionContext): Map<string, AgentOverride>`:
  - Walk `ctx.sessionManager.getBranch()` in order
  - Take the **last** `entry.type === 'custom' && entry.customType === PI_AGENTS_AGENT_CONFIG_ENTRY`
  - Require `data.version === 1` and object `agents`; parse each override; skip invalid agent keys
  - If none/invalid → empty map
- [ ] In `index.ts`:
  - `let sessionAgentConfig = createSessionAgentConfigStore()`
  - On `session_start` and `session_tree`: `sessionAgentConfig.replaceAll(Object.fromEntries(restoreFromBranch(ctx)))` (or accept map)
  - On session replacement paths already re-fire `session_start` — rely on that; do not leak previous session map
  - Pass store into `registerAgentCommand` and into `executeAgentTool` options as `getSessionOverrides: () => sessionAgentConfig.getOverrides()`
  - Catalogue injection in `before_agent_start` must call `discoverAgents(ctx.cwd, 'both', { sessionOverrides: sessionAgentConfig.getOverrides() })`
- [ ] Call `persistToSession` after every successful field mutation from the UI (same cadence as Pi `tools.ts`).

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/session-agent-config.test.ts`
- Expected: snapshot round-trip; last branch entry wins; v2/malformed ignored; dirty set updates on setField; markSaved clears only listed fields; replaceAll clears dirty; cleared field removed from override map.

### Task 3: Wire session overrides through discovery consumers

**Outcome:** Tool execution, slash invocation, list rendering, interactive fingerprint rediscovery, and catalogue injection all observe session overrides.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/command.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts` (only if it calls `discoverAgents` without options — thread options/`discoverAgentsFn` defaults)
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/agents.test.ts` (options)
- Test: `packages/pi-agents/tests/tool.test.ts` or a focused unit test with injected getSessionOverrides if cheaper

**Steps:**

- [ ] Add optional `getSessionOverrides?: () => ReadonlyMap<string, AgentOverride>` to `executeAgentTool` options; when present, pass into every `discoverAgents(..., { sessionOverrides })` in that function.
- [ ] Update `registerAgentCommand` options with `getSessionOverrides` and `sessionAgentConfig` (store reference for UI mutations).
- [ ] `/agent list` and named agent resolve use session-aware discovery.
- [ ] Ensure interactive registry construction in `index.ts` passes a `discoverAgentsFn` wrapper that injects current session overrides (so restore fingerprint checks match what new launches use). Pattern:

```ts
discoverAgentsFn: (cwd, scope) =>
  discoverAgents(cwd, scope, { sessionOverrides: sessionAgentConfig.getOverrides() });
```

- [ ] Document in code comment near fingerprint checks is unnecessary if behavior unchanged: changing session config can make existing units `fingerprint_mismatch` — UI will warn (Task 4).

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/agents.test.ts tests/command.test.ts tests/tool.test.ts`
- Expected: existing tests pass; add/adjust one test that execute path or discover wrapper sees session model override when getter returns a map.

### Task 4: TUI `/agent config`

**Outcome:** In TUI, `/agent config` opens a two-level editor: agent list (list parity) → field editor showing effective values + layer badges; edits update session store immediately; `Ctrl+S` / `Ctrl+Shift+S` write dirty fields to user/project config.

**Files:**

- Create: `packages/pi-agents/src/agent-config-ui.ts`
- Modify: `packages/pi-agents/src/command.ts`
- Test: `packages/pi-agents/tests/command.test.ts`
- Test: `packages/pi-agents/tests/agent-config-ui.test.ts` (pure helpers: dirty patch build, label formatting; avoid full TUI harness if heavy)

**Steps:**

- [ ] Add `CONFIG_KEYWORD = 'config'` alongside `list` / `view`.
- [ ] Completions: `{ value: 'config', description: 'Edit agent config (session; Ctrl+S user, Ctrl+Shift+S project)' }`.
- [ ] Handler branch **before** `waitForIdle` (same as `view`) so config can open while host is busy:

```ts
if (lower === CONFIG_KEYWORD || lower.startsWith('config ')) { ... }
```

- [ ] Non-TUI: `ctx.ui.notify('/agent config requires TUI mode', 'warning'); return;`
- [ ] Parse optional name: args after `config` trimmed; if non-empty and not found in discovered list, notify error and show list.
- [ ] Implement `openAgentConfigUi(ctx, deps)`:
  - deps: `{ store: SessionAgentConfigStore; persist: () => void; cwd: string; isProjectTrusted: () => boolean }`
  - Discover agents with session overrides, scope `'both'`
  - Level 1: `SelectList` of agents — label `name [source]`, description truncated; Enter/Right → level 2; Esc → `done`
  - Level 2: build `SettingItem[]` from `inspectAgentConfig` for overridable fields only
    - `label`: field name
    - `currentValue`: stringified effective value (arrays joined by `, `; undefined → `default`/`inherit` display token e.g. `(unset)`)
    - `description`: `source: ${field.source}` plus short help
    - enums: `values: [...]` cycle
    - booleans: `values: ['true','false']`
    - freeform/number/csv: `submenu` with Input; on submit parse and `store.setField`
  - On enum/bool change: `store.setField` + `persist()` + refresh item display via `settingsList.updateValue` + re-inspect for badge text in description
  - Footer/header help line: `Esc back · Ctrl+S save user · Ctrl+Shift+S save project · * dirty`
  - Mark dirty fields visually in label prefix `*` when `store.getDirtyFields(name)` contains field
- [ ] Input handling in outer component (not only SettingsList):
  - `matchesKey(data, 'ctrl+s')` → save user
  - `matchesKey(data, 'ctrl+shift+s')` → save project
  - Let SettingsList handle other keys when on level 2; on level 1 SelectList handles navigation
- [ ] Save algorithm for target `'user' | 'project'`:

```
fields = store.getDirtyFields(agentName)
if empty → notify "No dirty fields" and return
patch = {}
for field of fields:
  value = store.getAgentOverride(agentName)[field]
  if value !== undefined: patch[field] = value
  // session-cleared fields: skip (V1 no disk tombstones)
if patch empty → notify and markSaved anyway if only clears happened
path = userAgentConfigPath() | projectAgentConfigPath(ctx.cwd)
if target project && !ctx.isProjectTrusted(): notify error; return
try writeAgentConfigPatch(path, agentName, patch)
  store.markSaved(agentName, fields)
  notify success with path + field list
catch → notify error message
```

- [ ] After successful save: **do not** remove session override keys (locked decision).
- [ ] On first edit in a session, once per UI open, soft-notify (or header hint): changes apply to new agent launches; in-flight/resumable units may fail fingerprint checks.
- [ ] Style: non-overlay `ctx.ui.custom` (same surface as `/agent view` / `/settings`); use `getSelectListTheme` / `getSettingsListTheme` from pi-coding-agent.
- [ ] Read-only display of `source` and `filePath` in header of level 2 (not SettingsList fields).
- [ ] Do not include `systemPrompt` in editable fields; optional one-line header `prompt: N chars from file`.

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/command.test.ts tests/agent-config-ui.test.ts`
- Expected: completion includes `config`; non-TUI path notifies; handler invokes UI open stub; pure tests cover patch built only from dirty keys and project-untrusted refusal helper.

### Task 5: Documentation

**Outcome:** README / how-to / reference / explanation document the command, layer stack, session entry, dirty save keys, and fingerprint caveat.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`

**Steps:**

- [ ] README Features: bullet for `/agent config` session edit + Ctrl+S / Ctrl+Shift+S.
- [ ] how-to: new section after “Override an agent's config without editing source” — interactive editor steps; note session survives `/tree` via custom entry; disk files still manual-editable.
- [ ] reference: slash table row `/agent config [name]`; Config overrides section adds session layer and dirty-save rules; document entry type `pi-agents-agent-config` version 1; list overridable fields; state systemPrompt not editable here.
- [ ] explanation: override stack diagram/paragraph `frontmatter < user < project < session`; note save does not clear session; fingerprint impact one sentence.

**Validation:**

- Run: manual doc skim + `rg -n "agent config|pi-agents-agent-config|Ctrl\\+S" packages/pi-agents/README.md packages/pi-agents/docs`
- Expected: all four files mention the feature; no `/agents config` alias documented.

### Task 6: Package validation gate

**Outcome:** Typecheck and targeted tests pass for the package.

**Files:**

- (none new)

**Steps:**

- [ ] Run typecheck and the new/updated tests together.
- [ ] Fix any exported type breaks if `DiscoverAgentsOptions` needs re-export from package entry (package exports only `dist/index.js` extension — no public API surface change required unless something re-exports agents helpers; keep new modules internal to the extension).

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: exit 0
- Run: `mise run test --package packages/pi-agents -- tests/agent-config.test.ts tests/session-agent-config.test.ts tests/agent-config-ui.test.ts tests/agents.test.ts tests/command.test.ts`
- Expected: all pass
- Run (optional full package): `mise run test --package packages/pi-agents`
- Expected: no regressions in unrelated suites

## Final Validation

- Run: `mise run typecheck --package packages/pi-agents && mise run test --package packages/pi-agents -- tests/agent-config.test.ts tests/session-agent-config.test.ts tests/agent-config-ui.test.ts tests/agents.test.ts tests/command.test.ts`
- Expected: typecheck exit 0; listed tests green
- Manual TUI smoke (engineer):
  1. Start pi in this repo with the local package linked/built
  2. `/agent config` → list includes builtin agents
  3. Open `explore`, change `thinking`, confirm badge `session` and dirty `*`
  4. New `/agent:explore …` or tool call uses new thinking (observe spawn args or behavior)
  5. `Ctrl+S` creates/updates `~/.pi/agent/@balaenis/pi-agents/config.json` with only dirty fields; session badge remains `session`
  6. `Ctrl+Shift+S` with project trust writes `.pi/@balaenis/pi-agents/config.json`
  7. `/tree` or reload session branch still has session overlay from custom entry
  8. Escape returns to host editor

## Failure Behavior

- Malformed user/project `config.json` on read: treat as empty overrides (existing behavior); on write after malformed read, rewrite a valid `{ agents: {...} }` containing the merged patch (may drop prior unreadable content — document as fail-open repair)
- Invalid field input in UI: reject change, notify, leave previous session value
- Project save without trust: refuse with notify; session state unchanged; dirty retained
- Project/user write I/O error: notify; dirty retained; session retained
- Unknown agent name arg: notify; show list
- Missing agent after discovery race: close level 2 with warning
- Session entry version mismatch: ignore entry, empty session overlay
- Empty dirty set on save: notify `No dirty fields to save`

## Privacy and Security

- Session entries store override values (models, tool lists, hooks) in the host session JSONL — same sensitivity class as other session custom state; no secrets should be placed in agent config fields
- Project write creates `.pi/` artifacts; require `ctx.isProjectTrusted()` before project save
- Do not log full config payloads in failure logging beyond existing agent tool failure patterns
- `worktreeSetupHook` remains a shell command string; UI edit does not add new execution paths beyond existing override application

## Rollout Notes

- No migration of existing sessions (no entry → empty session overlay)
- Existing user/project `config.json` files remain compatible
- Extension reload picks up code; no settings schema change in Pi `settings.json`
- Build `packages/pi-agents` dist before running against a pi that loads the package entry from `dist/`

## Risks and Mitigations

- **Fingerprint mismatches after config edit** — Mitigate with UI hint; do not auto-rewrite durable unit fingerprints
- **Dirty ≠ full session delta** — Re-opened UI does not re-dirty restored session fields; user must re-edit to save to disk. Document clearly; optional future “Save all session fields”
- **SettingsList freeform UX friction** — Use submenu Input; keep enum/bool as cycles
- **Ctrl+Shift+S terminal encoding** — Use `matchesKey` / kitty protocol support already used by `interactive-view`; document if some terminals cannot emit ctrl+shift+s
- **discoverAgents call-site miss** — Task 3 audit all `discoverAgents(` usages under `packages/pi-agents/src` and inject session map
- **Concurrent multi-process config writes** — Atomic rename per process; accept last-writer-wins
- **Large dirty/session maps in session JSONL** — Snapshots are small field maps; acceptable

## Open Questions

None that block implementation. Follow-ups (not V1): save-all-session-fields action; disk tombstones for cleared keys; `/agent config --json` for non-TUI.
