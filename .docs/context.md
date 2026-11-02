# Current project context

Updated 2026-11-02. Describes the delivered state after the 2026-11 review and cleanup
([plan](roadmaps/2026_11_01_review_cleanup_plan.md), [Phase 3 design](roadmaps/2026_11_01_phase3_design.md)).
Earlier investigation logs are preserved in [historical context](context-2026-10-30-history.md);
do not infer current behaviour or limitations from them.

## What this is

A local, anonymous stdio MCP server that drives dcsc.lenovo.com through the JSON API its web app
uses. Goal: one MCP action per anonymous website action, with small, agent-friendly responses.
List prices only, not partner quotes. The parity target is [website-actions.md](website-actions.md).
Delivery rules are in [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).

## Architecture

Layers, top to bottom:

- `src/mcp` - the MCP surface. `server.ts` starts the stdio server; `tools.ts` wires the 41 tools,
  registered by one module per website area (`*Tools.ts`: catalog, configuration, session, rack
  layout, fabric/power, manual cabling, power control, storage, standalone basket, import/export,
  VLH, validation, reconciliation, recovery, reference solutions, wizard). Handlers stay thin and
  wrap work in `guard()` from `toolSupport.ts`. `service.ts` composes the `src/app` workflows.
  `continuations.ts` carries paging for large results.
- `src/app` - feature workflows used by `service.ts`, one module per website area (launch,
  catalog, configuration view, workspace view/refresh, rack, network, cabling, storage, power,
  standalone, import/export, validation, VLH, reconciliation, compare). `runtime.ts` holds the shared
  dependencies.
- `src/domain` - DCSC features: zod wire shapes, request builders and reductions. No I/O.
- `src/session` - in-memory sessions and workspaces (`SessionStore`), persistence and recovery.
- `src/http` - the only place that talks to DCSC (`DcscHttpClient.send`). Only this layer imports
  `undici`; 5xx bodies are redacted, HTTP 499 is never retried and starts a cooldown ladder, and a
  5xx on a POST raises an ambiguous-state error.
- `src/files` - the artifact store; every file the MCP writes goes through it.
- `src/config`, `src/model`, `src/schemas`, `src/util` - settings, shared types and helpers.

### State and persistence

- Sessions are configurations or workspaces. DCSC keeps no server-side session, so the client owns
  the configuration and posts it back on every mutation.
- Each workspace persists to `workspaces/<id>/doc.json` plus content-addressed values under
  `workspaces/<id>/blobs/`; `doc.json` is renamed into place last. `workspace-index.json` lists the
  saved workspaces. All of it lives under the state directory (`src/session/persist.ts`).
- Published workspace and configuration state is deep-frozen and shared with history. Changes happen
  only inside `sessions.transact(...)` on a draft; an in-place edit throws. Rejected operations leave
  revision, history and persisted state unchanged.
- Mutation tools take one handle (`session`) and `expectedRevision`; a stale revision fails before commit.
- Legacy or damaged saved designs are quarantined and handled through `dcsc_reconcile_workspace`
  and `dcsc_recovery_export`.

## Verification

- `npm run check`: typecheck, lint, unit tests (`test`, offline, committed fixtures), offline
  contracts, build, stdio smoke.
- `npm run contract:live` and the scripts in `scripts/` (`smoke.ts`, `export-smoke.ts`, `mcp-smoke.ts`,
  `conformance.ts`, `verify-fixes.ts`, `release-checkpoint.ts`) hit dcsc.lenovo.com. `npm run mine`
  diffs the live SPA bundle against the previous baseline at zero API cost.
- Parity harness `scripts/parity`: runs the same website action in a headless Chromium browser and
  through the MCP over stdio, and computes pass, fail or blocked from the comparison. Cases are in
  `scripts/parity/cases`; run `npm run parity -- <case|tag|all>`. Exit 1 is a failed assertion, exit 2
  a blocked upstream capability; blocked is never reported as passed.
- A capability counts as delivered only when the browser run and the MCP run produce matching state or
  artifacts. Run live gates serially: DCSC's WAF answers load with HTTP 499 cooldowns.

## Removed in the cleanup

AI configurator, memory wizard, CFXML validation, P2P and Power XLS exports (GROUP_XLS/P2P_XLS),
blueprints, the config ID tool, and the separate scale-out, compare and diff tools (now one
`dcsc_compare`). The phase-numbered parity scripts and their suites were replaced by `scripts/parity`.

## Known limits

Scoped native limitations (storage connection graph after import, CFXML load factor reset, lock flag,
service Save HTTP 500) are listed in the README under "What it cannot do yet" and in
[website-actions.md](website-actions.md). Account saves and partner/bid pricing are untested
(anonymous access only). Complete website parity is not claimed.
