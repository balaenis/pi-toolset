# RunStore Disabled Directory Sync Regression Test Plan

**Goal:** Prove the injected `directorySync` implementation is never called when the probed `directoryFsync` capability is false.

**Inputs:** Round 2 Tasks 1–3 implementation and its incremental code review.

**Assumptions:** Production behavior is correct; this plan adds only branch-specific regression coverage.

**Architecture:** Extend the existing directory-sync-disabled lock/claim/terminal cycle with a throwing/counting seam. A successful cycle plus zero calls proves every publication path honors the capability gate.

**Tech Stack:** TypeScript, `bun:test`.

---

## File Map

- Modify: `packages/pi-agents/tests/run-store.test.ts` — strengthen the existing disabled-directory-sync protocol test.

## Tasks

### Task 1: Assert the Directory Sync Seam Is Bypassed

**Outcome:** A regression that invokes `directorySync` while capability is false fails deterministically on every host.

**Steps:**

- [ ] Locate the existing lock/claim/terminal cycle using `directoryFsync: false`.
- [ ] Inject a `directorySync` implementation that increments a counter and throws if called.
- [ ] Run the complete existing cycle without changing its production expectations.
- [ ] Assert the counter remains zero.
- [ ] Do not modify production code or unrelated tests.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: Suite passes and the disabled-capability test proves zero `directorySync` calls.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `git diff --check`
- Expected: No whitespace errors.

## Failure Behavior

If any lock, claim, terminal, or cleanup path bypasses the capability gate, the injected seam throws and the test fails.

## Privacy and Security

No production or trust-boundary behavior changes.

## Open Questions

None.
