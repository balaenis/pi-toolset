# Phase 3: Artifact Store IO and Errors

**Goal:** Move `artifact-store` write/read paths onto Effect with tagged failures that preserve existing `ArtifactStoreError` codes and Promise store methods.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md); `packages/pi-agents/src/artifact-store.ts`; `packages/pi-agents/tests/artifact-store.test.ts`; consumer `run-store.ts` (Promise API only).

**Assumptions:**

- Phase 0 complete.
- `ArtifactStore` interface methods remain `Promise`-returning.
- `ArtifactStoreError` class remains the thrown/rejected wire error (codes unchanged).
- Sync helpers (`serializeJsonArtifact`, `measure*`, `isRunArtifactRef`, path builders) may stay sync.
- No `@effect/platform` FileSystem; keep Node `fs` and injectable `fileFsync` / `directorySync` seams.

**Architecture:** Implement internal `Effect` programs for writeBytes / read / resolve. Map failures to `ArtifactStoreError` before crossing the Promise boundary via `runEffectPromise`. Preserve exclusive create + fsync + rename publication algorithm and directoryFsync capability gate.

**Tech Stack:** `effect` (`Effect`, `Data` optional), Node `fs`, existing artifact tests.

---

## File Map

- Modify: `packages/pi-agents/src/artifact-store.ts` — Effect internals; stable exports
- Test: `packages/pi-agents/tests/artifact-store.test.ts` — oracle
- Touch only if needed: `packages/pi-agents/src/run-store.ts` — should require **zero** changes if interface holds

## Error Code Invariants

Keep exactly:

| code                   | when                                             |
| ---------------------- | ------------------------------------------------ |
| `artifact_too_large`   | payload exceeds `RUN_ARTIFACT_MAX_BYTES`         |
| `artifact_write_error` | fsync/rename/IO publication failures             |
| `artifact_missing`     | expected artifact file absent                    |
| `artifact_corrupt`     | hash/size/content mismatch on trusted read       |
| `artifact_invalid`     | bad ref shape, non-JSON value, unsupported types |

`ArtifactStoreError` remains `instanceof Error` with `.code` and optional `.cause`.

## Behavioral Invariants

1. Content-addressed path: `artifacts/sha256/<2hex>/<sha>.{txt,json}`.
2. Publication: write staging → fsync file → rename into place; directory sync only when `directoryFsync === true`.
3. Trusted read verifies sha256 and bytes.
4. Cross-run / path escape rejected as invalid/corrupt per current tests.
5. `directoryFsync: false` never calls `directorySync` seam.
6. JSON artifacts reject `undefined`, non-finite numbers, bigint/function/symbol.

## Tasks

### Task 1: Tagged error adapter (optional but recommended)

**Outcome:** Internal Effect failures convert 1:1 to `ArtifactStoreError`.

**Files:**

- Modify: `packages/pi-agents/src/artifact-store.ts`

**Steps:**

- [ ] Either keep throwing `ArtifactStoreError` inside `Effect.try`/`tryPromise`, **or** introduce:

  ```ts
  class ArtifactStoreFailure extends Data.TaggedError('ArtifactStoreFailure')<{
    code: ArtifactStoreError['code'];
    message: string;
    cause?: unknown;
  }> {}
  ```

  and map to `new ArtifactStoreError(code, message, { cause })` in the Promise façade.

- [ ] Prefer minimal churn: wrapping existing throws with `Effect.try({ try, catch })` is acceptable if codes stay correct.
- [ ] Do not change code strings.

**Validation:**

- Covered by Task 2 tests.

### Task 2: Effect-ify write/read/resolve methods

**Outcome:** `createArtifactStore` methods run Effect programs; all artifact tests pass.

**Files:**

- Modify: `packages/pi-agents/src/artifact-store.ts`
- Test: `packages/pi-agents/tests/artifact-store.test.ts`

**Steps:**

- [ ] Convert `writeBytes` / read helpers to `Effect` (sync fs via `Effect.sync` / `Effect.try`, or keep sync body and only wrap the public async methods — **prefer real Effect around fallible steps**).
- [ ] Public methods:

  ```ts
  writeTextArtifact(...): Promise<RunArtifactRefV1> {
    return runEffectPromise(this.writeTextEffect(...));
  }
  ```

  (method or closure style matching the factory pattern).

- [ ] Preserve test seams: `fileFsync`, `directorySync`, `stagingName`, required `directoryFsync`.
- [ ] Preserve POSIX mode best-effort chmod behavior.
- [ ] Do not alter `makeTempRunDir` unless tests demand it.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/artifact-store.test.ts`
- Expected: Pass (size limits, corrupt detection, capability gate, JSON invalid, happy path write/read).

### Task 3: Consumer smoke

**Outcome:** RunStore still constructs and uses artifact store without code changes.

**Files:**

- None expected

**Steps:**

- [ ] Run a focused run-store artifact-related subset if available; otherwise full `run-store` is optional pre-merge, but typecheck is mandatory.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/result-payload.test.ts`
- Expected: Pass.
- Optional before merge: `bun test tests/run-store.test.ts` (long) — Expected: Pass.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/artifact-store.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

## Failure Behavior

- Oversized write → `artifact_too_large` (no partial published object under final path).
- Hash mismatch on read → `artifact_corrupt`.
- Capability false → no directorySync calls; file fsync still mandatory.

## Privacy and Security

- Artifacts may hold model output; paths stay under runDir; no new logs of content.

## Rollout Notes

- Internal; no on-disk format change; no README change.

## Risks and Mitigations

- Async wrapping of currently sync fs changing timing — keep fs calls sync inside Effect unless tests require async; do not introduce real async fs without cause.
- Losing `cause` chain — preserve `options.cause` on `ArtifactStoreError`.

## Open Questions

None.
