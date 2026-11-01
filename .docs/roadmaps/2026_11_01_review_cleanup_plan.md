# Full review, simplification and parity plan

**Date:** 2026-11-01
**Goal:** The MCP matches what an anonymous user can do on dcsc.lenovo.com, one MCP action per website action, with simple, maintainable, fast code and tools that agents can use efficiently.
**Baseline:** `main` at `6563ee5`. 38.6k lines in `src` (`mcp/service.ts` is 4.7k), 108 tools in 21 modules, 148 test files, 56 scripts.
**Supersedes for new work:** `2026_10_31_anonymous_parity_completion.md`. That roadmap's live-gate results are not accepted as evidence (see [Evidence rule](#evidence-rule)).

## Standards

Every package follows, in this order: `CONTRIBUTING.md`, this plan, and `~/.claude/engineering-style.md`. The review bar is correct, simple, idiomatic, consistent with the project, and no regressions.

### Evidence rule

A capability is delivered only when a headless browser run of the website and an MCP run of the same action produce matching state or artifacts. The gate computes its status from that comparison. Status literals in scripts, "non-empty response" checks and unit tests alone do not count. An upstream that refuses or returns nothing usable makes the capability blocked or dropped, never verified.

## Phase 0 — Baseline (orchestrator)

- Branch `review/cleanup-2026-11` from `main`. All work lands through one PR.
- Record baseline metrics for later comparison: tool count, tool-schema token size, response bytes per tool (conformance run), `npm run check` time, LOC per module, live call counts and latency for one representative workflow.

## Phase 1 — Source-of-truth inventory

1. **Website action census.** A headless walk of every anonymous screen, menu, tab, button and modal in General Purpose and HPC/AI modes. For each action, record the endpoint and payload it triggers. Uses the repo's headless Playwright Chromium (already installed) with throttled, serial traffic (DCSC's WAF cooldown triggers quickly).
2. **Endpoint census.** All API paths in the live bundle mapped to the calling action (reuse `scripts/mine-bundle.ts`).
3. **Output:** `.docs/website-actions.md`, one table: website action → endpoint → anonymous result (works / refused / empty) → current MCP tool and argument, or gap. This becomes the single parity target. Everything downstream refers to it.

## Phase 2 — Independent review (read-only, parallel)

Each reviewer receives the code and the standards, not prior findings. Each finding includes file:line, a concrete failure scenario, and whether it is introduced or pre-existing.

| Dimension | Scope |
|---|---|
| R1 Correctness | Bugs, error handling, state, recovery, concurrency, in `src` |
| R2 Simplification | Duplication, dead code, speculative structure, oversized modules (`service.ts`, `SessionStore.ts`, `standaloneTools.ts`, `reduce.ts`) |
| R3 Architecture | Module boundaries, thin tool handlers, one owner per fact, HTTP/domain/session layering |
| R4 Tool ergonomics | 108 tools: overlap, naming, schema size and clarity, descriptions, response shape and size, error messages, number of calls a typical HPC workflow needs |
| R5 Performance | Redundant upstream calls, caching, buffering and stream limits, persistence I/O, startup cost |
| R6 Verification assets | Tests and the 56 scripts: hollow gates, duplicated harness code, dead scripts, coverage of state transitions and money |
| R7 Parity gaps | Phase 1 table vs MCP: missing actions, wrong wire behaviour, features claimed but not working (seed list: G2, G3, G4, G6, G7, G12) |

The orchestrator verifies every finding against the code before it enters the fix list. Nitpicks are dropped.

## Phase 3 — Target design (user approval gate)

The orchestrator produces from the verified findings:

- **Tool surface map:** current tools → target tools, with a merge/rename/remove rationale per row. The target is the fewest tools that still map cleanly to website actions and keep schemas small.
- **Module layout:** target split of `service.ts` and the other oversized modules, and which layer owns each concern.
- **One parity harness:** a shared browser-vs-MCP comparison library. The maintained `parity-*` scripts become thin cases on it; the hollow phase gates are deleted.
- **Ranked fix list:** must-fix and later, introduced and pre-existing separated.

No execution starts until this is approved.

## Phase 4 — Execution packages

Order matters: the harness comes first so every later package can be proven.

1. **E1 Parity harness**, plus porting existing gates to it.
2. **E2 Structural refactor:** split `service.ts` and the other oversized modules along the approved layout. No behaviour change, proven by the full unit suite and an unchanged conformance output.
3. **E3 Tool surface:** apply the tool map: schemas, descriptions, response shapes, errors.
4. **E4 Defect fixes** from the verified list (includes the direct-report export path, share-link handling and the import master-slice check).
5. **E5 Parity gaps:** one package per missing or broken website action, each closed with a harness case.
6. **E6 Cleanup:** delete dead code, scripts, fixtures and docs made obsolete.
7. **E7 Performance** fixes with before/after measurements.

E2 and E3 are serial: they touch the same files. E4–E7 packages run in parallel when their file sets don't overlap.

## Phase 5 — Verification (orchestrator only)

- After each merged package: `npm run check`.
- After E5: affected live harness cases, serially.
- At the end: full harness run and `release:checkpoint`, compare metrics with the Phase 0 baseline, `/code-review` then `/simplify` on the branch, then the PR with CI on Node 22 and 24.

## Phase 6 — Documentation

README tools and status tables, `.docs/context.md`, the finding audit, and `website-actions.md` updated to the delivered state. Retire superseded roadmaps.

## Orchestration

| Role | Who | Does |
|---|---|---|
| Orchestrator | This session (Opus) | Writes briefs, verifies findings, approves designs with the user, merges, runs all tests and live gates, final review |
| Inventory | Sonnet subagent | Phase 1 census (browser + bundle) |
| Reviewers | Sonnet subagents, one per dimension, parallel, read-only | Phase 2 |
| Mechanical work | Haiku subagents | Bulk renames, dead-code removal, doc tables, porting scripts to the harness: work with a precise spec |
| Implementers | Sonnet subagents, one package each, each in its own git worktree | Phase 4 packages |

Rules for subagents:

- No tests, type checks, lint or live website traffic, except the Phase 1 census, which is serial. The orchestrator runs these once per merge.
- One package per agent, an explicit file scope, and an acceptance criterion taken from this plan.
- The report back lists changed files, the decisions made, and anything left undone. Results are verified, not trusted.
- No commits to `main`, no pushes; the orchestrator commits on the branch.

## Decisions needed

- **D1 Tool compatibility.** Does anyone use the current tool names (the Claude Code plugin, colleagues)? If not, tools are renamed and merged freely. If so, the tool map needs a transition plan.
- **D2 Repo standards file.** Add an `AGENTS.md` pointing to `CONTRIBUTING.md` and this plan, so future agents find the rules without a brief.
- **D3 Live traffic budget.** The census and harness runs make anonymous requests to Lenovo. Confirm this is acceptable at a throttled, serial rate.
