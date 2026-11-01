# AGENTS.md

Guidance for any agent contributing to this repository. Keep it short; add a rule here only when it is adopted and worth knowing before touching code.

## What this is

An MCP server that drives Lenovo's anonymous DCSC website (dcsc.lenovo.com) through the same JSON API its web app uses. The goal is 1:1 parity with what an unauthenticated user can do on the website, exposed as tools an AI agent can use efficiently.

Read before changing behaviour: [CONTRIBUTING.md](CONTRIBUTING.md), [.docs/context.md](.docs/context.md), and the active plan [.docs/roadmaps/2026_11_01_review_cleanup_plan.md](.docs/roadmaps/2026_11_01_review_cleanup_plan.md).

## Layout

- `src/http` - the only place that talks to DCSC (`DcscHttpClient.send`).
- `src/domain` - DCSC features: wire shapes (zod), requests, reductions.
- `src/session` - in-memory sessions and workspaces, persistence, recovery.
- `src/mcp` - tool registration (`*Tools.ts`, wired in `tools.ts`) and `service.ts`. Handlers wrap work in `guard()` from `toolSupport.ts`.
- `src/files` - the artifact store. All files the MCP writes go through it.
- `test` - vitest, offline, committed fixtures. `scripts/parity` - live gates (`npm run parity -- <case>`).

## Commands

- `npm run check` - typecheck, lint, unit tests, offline contracts, build, stdio smoke. Must pass before a change is done.
- Live gates: `npm run parity:*`, `npm run contract:live`. They hit dcsc.lenovo.com.

Parity target: [.docs/website-actions.md](.docs/website-actions.md) lists every anonymous website action, its endpoint and its MCP tool. Add a website feature only if it is in that table; update the table when the website changes.

## Tool design

- One tool per website panel. Reads and writes are separate tools, so `readOnlyHint` is true. Use a `kind` switch only when every kind has the same inputs and output shape.
- Annotations are declared with each tool, not in name lists.
- One handle parameter `session` (configuration or workspace) and one `expectedRevision`. No parameter aliases.
- Descriptions: one or two sentences on when to use the tool. Cross-tool workflow guidance lives once, in the capabilities resource.
- Mode-specific behaviour comes from the solution mode's `systemFunctionList`, not hard-coded per tool.
- MCP-only helpers are allowed when they make DCSC work easier (sizing, comparison), never as invented Lenovo data.

## Rules

- **Evidence over claims.** A website capability is done only when a headless browser run and an MCP run of the same action produce matching state or artifacts, and the gate computes its status from that comparison. Never hard-code a pass status, and never count "no error, non-empty response" as verified. An upstream that refuses or returns nothing usable is blocked or dropped.
- **Tests run once, serially.** Parallel agents only edit and review. One runner runs `npm run check` and live gates, never concurrently: the machine and DCSC's WAF (HTTP 499 cooldowns) both fail under load.
- **Browsers are headless.** Use the repo's Playwright Chromium.
- **Live traffic is throttled and serial.** Anonymous requests only. No credentials, accounts or purchases.
- **Tool responses stay small.** Keep responses under the conformance budget (8000 bytes). Return file paths for artifacts written through `src/files`, never file contents or base64.
- **Published state is immutable.** Change workspace or configuration state only inside `sessions.transact(...)` on the draft; published values are deep-frozen and shared with history, and an in-place edit throws. Tests set up state the same way.
- **Fail visibly.** Don't swallow upstream errors; report them through the central error handling.
- **No compatibility shims.** Nothing depends on current tool names; rename, merge and delete freely.
- **Commits go on a branch, through a PR.** Never push to `main`.
- **Worktrees:** start from the working branch (`git checkout <branch>` first; new worktrees default to `main`). Remove merged worktrees under `.claude/worktrees/` before `npm run check`; lint scans them.
- **Keep data out of commits:** no sessions, exports, traces, cookies or credentials. Fixtures are anonymous and minimal.
