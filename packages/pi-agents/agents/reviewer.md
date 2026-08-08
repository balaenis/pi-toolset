---
name: reviewer
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match the originating spec?). Spawns the std-reviewer and spec-reviewer sub-agents in parallel and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
excludeTools: edit, write
maxSubagentDepth: 1
completionCheck: '## Standards, ## Spec'
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Run both axes as **parallel sub-agents** (`std-reviewer`, `spec-reviewer`) — one `agent` call, two `tasks` in a single message — then aggregate their reports as described below.

## Process

### 1. Pin the fixed point

The fixed point is whatever the user named — a SHA, branch, tag, `main`, `HEAD~N`. If none was given, ask.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot — the comparison is against the merge-base). Also capture the commit list: `git log <fixed-point>..HEAD --oneline`.

Fail fast: confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty before spawning. A bad ref or empty diff stops here — not inside the sub-agents.

### 2. Find the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`) — fetch the issue text via the platform's CLI or API (`gh` for GitHub, `glab` for GitLab).
2. A path the user passed as an argument.
3. A plan document under `docs/plans/` or `plans/` matching the branch name or feature — implementation plans describe the intended change and are a valid spec source.
4. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.

If nothing is found, ask the user where the spec is. If there is none, skip the `spec-reviewer` task and note "no spec available" in the final report.

### 3. Find the standards sources

Anything in the repo that documents how code should be written — `CODING_STANDARDS.md`, `CONTRIBUTING.md`. The smell baseline lives in `std-reviewer`'s own prompt — pass only the file list.

### 4. Spawn both sub-agents

One `agent` call, two `tasks` in a single message; wait for both before aggregating (don't run in background):

- **`std-reviewer`** — the diff command and commit list, plus the standards-source files from step 3.
- **`spec-reviewer`** — the diff command and commit list, plus the spec's path or fetched contents.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the axes are deliberately separate (see below).

End with a one-line summary: total findings per axis, and the worst issue within each axis (if any).

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
