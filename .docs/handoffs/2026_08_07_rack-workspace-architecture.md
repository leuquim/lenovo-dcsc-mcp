# Handoff: Capture the rack/multi-product contracts and rebuild on a workspace model

> Historical handoff, superseded by [current context](../context.md) and the October finding audit. The next steps and blocked rack-export claim below describe the earlier state.

**Created:** 2026-08-07
**Source session cwd:** /home/miquel/projects/lenovo-dcsc
**Status:** in-progress

## Next task

Use `/playwright-cli` to capture the DCSC request contracts we still don't have —
rack launch, adding a second product to a solution, cabling, and the real shapes
of `networkingInformation` and `messageHistory` — then **restructure the server
around a Workspace model** rather than bolting rack support onto the current
single-configuration session.

Acceptance: a single MCP conversation can produce "8 × ThinkSystem SR680a V4 in a
rack with an InfiniBand switch and cables" as **one solution**, exported as one
ZIP whose CFXML contains all products, with a rack diagram and P2P report. The
conformance suite (`scripts/conformance.ts`) covers it and still passes 100%,
including its coverage gate.

## Why this matters

The current session model holds exactly one configuration. Quantity was added to
express "8 identical nodes", but a *solution* — several different products
sharing a rack, with placement and cabling — is a different shape, not a bigger
version of the same one. The explicit instruction for this task is to build
robust foundations that scale to full DCSC capability, **not** to patch the
single-config model until it limps through the rack case. Expect to change
`SessionStore` and the export/mutation payload builders, not just add tools.

## Context the next session needs

### Read first
- `README.md` — "How mutation and export actually work" documents every contract
  recovered so far. Read this before touching payloads; the details are
  non-obvious and cost many HTTP 500s to find.
- `.docs/handoffs/` — this file.

### Files
- `src/session/SessionStore.ts` — **the architectural constraint.** One
  `ConfigSession` = one configuration (`raw`, `reduced`, `configurationId`).
  A workspace holding N configurations plus rack/floor areas is the change.
- `src/domain/reduce.ts` — all payload builders. `reduceConfiguration`,
  `buildAutoDeriveRequest`, `buildExportData`, `buildExportConfiguration`,
  `buildGroups`, `buildPlacement`. Note `workspace.nonRackArea` (layout) vs
  `workspaceInformation.nonRackData` (placement) are different objects — this
  distinction is already load-bearing and generalises to racks.
- `src/mcp/service.ts` — orchestration and the de facto seam between tools and
  HTTP. `launch`, `#autoDerive`, `configure`, `setQuantity`, `exportZip`.
- `src/mcp/tools.ts` — 15 tools. Descriptions matter: they steer the model
  (search-before-browse, confirm-before-select).
- `src/model/project.ts` / `index.ts` / `diff.ts` — L0–L3 projections, the search
  index, and the mutation diff. These keep tool results in the 1–8 KB range and
  must keep doing so when a result spans multiple products.
- `src/http/request.ts` — the single chokepoint. Only `src/http/**` may import
  `undici` (ESLint-enforced). All new endpoints go through `send()`.
- `scripts/probe-rack.ts` — rack endpoint map, already written and runnable.
- `scripts/conformance.ts` — the gate. Has a coverage assertion that **fails if
  any registered tool is never exercised**. Extend it, don't bypass it.
- `scripts/usecase-cluster.ts` — the 8-node scenario; currently prints what it
  cannot express. That list is the definition of done.
- `fixtures/capture/autoDerive-request.json` — the reference browser capture.
  New captures belong beside it.
- `fixtures/endpoints.json` — 359 API path literals mined from the SPA bundle
  (`npm run mine` re-mines and diffs across releases, zero API calls).

### Decisions already made
- **Keep `raw` verbatim; post back a reduced model.** DCSC has no server-side
  session (`launch` returns `id: null`), so the client owns state. Never
  normalise `raw` away.
- **CTO and LFO are mirrored endpoint families** (`/ctos/*` vs `/lfos/*`) and must
  be routed explicitly for launch, autoDerive and export. LFO routes resolve the
  model by **LFO code**, not the underlying CTO code.
- **A priming `autoDerive` with no delta must run after launch** to materialise
  derived sections; it is best-effort and recorded as `session.primed`.
- **The export DTO differs from the autoDerive DTO** — it reads `code` (not
  `ctoCode`) and rejects unknown properties.
- **`exportFileTypes` is a plain top-level array inside `data`.** Omitting it
  yields a valid but empty ZIP.
- **Back off, never evade** on HTTP 499: pinned UA, fixed host allowlist, no
  proxy support. This is deliberate and must not be "optimised" away.
- **5xx bodies never reach the user** (they leak SQL and Java frames); users get
  a fixed template plus a request id.
- **No speculative abstraction.** A `DcscTransport` interface was written and
  then deleted as unreferenced. Introduce interfaces when a second
  implementation exists.

### Ruled out / dead ends
- `/ctos/batch_customizing` — **404 on every method**, retired. `autoDerive` is
  the mutation path.
- Posting the full ~150 KB launch tree back — fails with
  `ConfigurationResult.getSections() is null`.
- The `{zipAll, selection}` shape the SPA bundle's builder function suggests — it
  is **not** what the export endpoint takes.
- Blind error-oracle probing for the export payload — converges far too slowly
  (many 500s, then an opaque 400 "Failed to read request"). **Browser capture is
  the tool for payload shapes.** Probing is only good for missing *parameters*.
- `networkingInformation: {powerSelection:{},cables:[],switchMap:{}}` and
  `messageHistory: {history:[],validationReport:[]}` — plausible but wrong; each
  fails the whole body with HTTP 400. Currently omitted entirely.
- `/ctos/racks/{code}/launch` with body `{}` — HTTP 500.
- `/ctos/racks/compatible_categories` — GET, not POST.

### playwright-cli technique (learned the hard way — reuse it)
- Use an isolated session: `playwright-cli -s=<name> open <url> --browser=chromium`.
- **The session dies when a download fires.** Hook
  `HTMLFormElement.prototype.submit`, record `this.elements` into a global, and
  **do not call the original** — you get the payload without the download.
- Read captures back with targeted `eval` queries (keys, specific fields), not by
  dumping 27 KB. `--raw` output into a file redirect flakes; pipe to `head`/`tee`.
- Deep-link straight to the customize page:
  `https://dcsc.lenovo.com/#/configuration/cto/<code>?hardwareType=server`.

### Open questions
- What body does `/ctos/racks/{code}/launch` need? (500s on `{}`.)
- Real shapes of `networkingInformation` and `messageHistory`.
- Does a multi-product solution use the `multipleProductData` form field (present
  in the export form, currently always `[]`)?
- Is the **Cluster** solution mode reachable anonymously? `/solution_modes`
  returns only `General Purpose` and `HPC and AI - Systems` for US. The bundle
  lists Cluster and HPC-LeSI. If Cluster is login-gated, say so explicitly rather
  than faking it.
- Should a workspace be one MCP session handle containing N configurations, or N
  session handles plus a workspace handle? Decide before writing code.

## Commands / state to be aware of

- **Nothing is committed.** `git status` is entirely untracked; the repo was
  `git init`-ed but has no commits. Consider an initial commit before refactoring.
- The MCP server is registered at **user scope**:
  `claude mcp add lenovo-dcsc --scope user -- node /home/miquel/projects/lenovo-dcsc/dist/mcp/server.js`.
  It runs the **built** `dist/`, so `npm run build` is required before a restart
  picks up changes.
- Verification: `npm test` (27 offline), `npx tsx scripts/conformance.ts`
  (35 live assertions, 15/15 tools), `npm run lint`, `npm run typecheck`.
- Live scripts hit DCSC. Keep them occasional; pacing is 2 concurrent, ~4 req/s,
  40-request budget per tool call.
- Export artifacts accumulate in `~/.local/share/lenovo-dcsc/artifacts/` — the TTL
  is configured but no sweeper is wired.

## Suggested first moves

1. Read `README.md` §"How mutation and export actually work", then
   `src/domain/reduce.ts` and `src/session/SessionStore.ts`.
2. Commit the current tree so the refactor is reversible.
3. Drive the real SPA with `/playwright-cli`: build a rack solution with two
   different products and a switch, add cabling, export with `RACK_DIAGRAM`,
   `FLOOR` and `P2P_REPORT` ticked. Capture the `autoDerive` and `export_zip`
   payloads using the submit-suppression hook. Save under `fixtures/capture/`.
4. From the captures, decide the Workspace model **on paper first** — how N
   configurations, rack areas, placement and cabling compose — and check it
   against the open question above before writing code.
5. Refactor `SessionStore` → workspace, then re-point `reduce.ts` builders at it.
   Keep `raw` verbatim per configuration.
6. Extend `scripts/conformance.ts` alongside each capability; make
   `scripts/usecase-cluster.ts` print an empty "could NOT express" list.
