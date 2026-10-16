# lenovo-dcsc-mcp

An MCP server that drives Lenovo's **Data Center Solution Configurator**
([dcsc.lenovo.com](https://dcsc.lenovo.com/)) programmatically, so an LLM can
search the catalog, launch a configuration, explore options against Lenovo's
real rules engine, and read back list prices.

DCSC ships only as a browser SPA. This server talks to the same same-origin
JSON API the SPA uses. **No Lenovo login is required** for catalog, launch and
pricing — that is verified, not assumed.

---

For maintainers: [current context and next steps](.docs/context.md), [roadmap](.docs/roadmaps/2026_10_15_dcsc_parity.md), and [verified findings](.docs/roadmaps/2026_10_15_dcsc_finding_audit.md).

## Status

| Capability | State |
|---|---|
| Catalog search & browse | **Working** |
| Launch a CTO/LFO configuration | **Working** |
| Explore options (search, tabs, sections, feature detail) | **Working** |
| List pricing + resource constraints | **Working** |
| Bill of materials | **Working** |
| Change selections (mutation, with rules reconciliation) | **Working** |
| Multiple identical units (quantity) | **Working** — extends price and the exported line |
| Duplicate a configured product N times | **Verified configuration copies, direct racked Clone Multiple and independent Copy** — source/member linked edits and fresh-browser handoffs pass; the supported nested D3/SD535 lifecycle also passes |
| Export CFXML + Excel ZIP | **Working** — per configuration or per workspace |
| Import XML | **Working** — via DCSC's own `/multiple/cfxml_import` |
| Preconfigured (LFO) models | **Working** — launch, inspect, export |
| Multi-product solutions (server + switch + rack) | **Working** — one workspace, many configurations |
| Rack enclosures + U placement | **Working** — placement validated by DCSC |
| PDUs, line cords, power & heat reporting | **Working** |
| Manufacturing validation (`/lmc_validation`) | **Verified valid/invalid workflow** — on 2026-10-16, live rack/server cases returned authoritative terminal verdicts with canonical payload/revision binding. Responses stay bounded, with full saved diagnostics available through inspection. Unavailable and stale results never count as valid. |
| Cabling | **Verified Management workflow** — automatic switch provisioning, exact port/cable graph and browser handoff; other topologies and storage graphs remain open |
| Rack/floor export | **Verified one-/two-rack and captured PDU/cord workflows** — XML linkage, workbook sheets, browser handoff and restart; broader physical matrix remains |
| Storage definitions and components | **Partial** — definitions, placement, server assignment, controller/SAN editing, export/reimport and removal work; a populated storage connection graph remains open. Current catalogs expose no expansions. |
| Standalone software and product services | **Verified basic workflows** — software quantity and covered-product count, persistence reload, export and headless website import; imported service quantities are preserved; independent services use a separate basket |
| Guided/Expert and Auto-Correct | **Implemented** — Guided supports on/off; Expert forces Auto-Correct off |
| Cluster / HPC-LeSI solution modes | Cluster mode is not offered anonymously |
| Account saves and partner/bid pricing | **Not tested** — anonymous workflow coverage only |

The parity implementation is in progress. Run `npm run build`, `npm run typecheck`,
`npm run lint`, `npm test`, and `npm run contract` for local checks. Live API
contracts and dynamic MCP conformance are separate gates; a passing request
alone does not establish website parity. Browser tests use isolated headless
Chromium. The execution roadmap and evidence ledger are in `.docs/roadmaps/`.

Rack-bearing export now preserves the slim layout hierarchy, full physical rack
data and floor information. A generated PNG supplies the Rack Report sheet.
The verified one-rack import/re-export preserved eight product lines, quantities,
prices and currency. Broader layout and connection cases remain release gates.

**CTO and LFO are mirrored endpoint families and both must be routed
explicitly** — `/ctos/*` vs `/lfos/*` for launch, autoDerive and export. The
LFO routes additionally resolve the model by its **LFO code**, not the
underlying CTO code; sending the CTO code returns "Unable to find a model with
model number …".

---

## Quick start

Requires Node.js 22 or newer (Node 24 recommended), npm, Git, and access to this private repository. This is an unofficial integration and runs locally over stdio; no shared hosted service or Lenovo API key is required for the supported anonymous workflows.

```bash
git clone git@github.com:leuquim/lenovo-dcsc-mcp.git
cd lenovo-dcsc-mcp
npm ci
npm run build
npm run smoke:stdio
```

The smoke check starts the real MCP server, lists its tools and checks health without contacting Lenovo or using your saved sessions.

Follow the [client setup guide](docs/client-setup.md) for **Claude Code, Claude Desktop, Codex**, and other stdio MCP clients. It includes copyable configurations, absolute-path guidance and separate persistent state for each client. Colleagues need repository access before cloning; the package is private and is not published to the public npm registry.

Optional live check after installation:

```bash
npx tsx scripts/mcp-smoke.ts
```

For development, `npm run check` runs typecheck, lint, unit tests, offline contracts, build and the isolated stdio smoke check. [Contributing](CONTRIBUTING.md) explains live/headless verification and package checks.

## Tools

| Tool | Purpose |
|---|---|
| **Discovery** | |
| `dcsc_find_products` | Search the catalog. The normal way to get from "SR630 V3" to `7D73CTO1WW`. |
| `dcsc_browse_catalog` | Walk the category tree. Use only to understand structure. |
| `dcsc_solution_modes` | List solution modes and their master slices. |
| `dcsc_blueprints` | Curated starting points with current catalog membership by mode and dated historical configuration checks. |
| `dcsc_start_from_blueprint` | Launch a blueprint in the correct solution mode. |
| `dcsc_list_racks` / `dcsc_fabric_options` | Paginated racks (optionally compatible with a product/session); complete fabric and storage catalogs. |
| `dcsc_find_parts` | Global hardware/software/service part lookup. |
| `dcsc_service_categories` / `dcsc_list_locales` / `dcsc_set_locale` | Services taxonomy; country/currency. |
| **Configuring** | |
| `dcsc_launch` | Start a configuration session. Pass `workspace` to add to a solution. |
| `dcsc_list_options` | Search or list options. `query` searches all tabs. |
| `dcsc_get_feature` | Full detail + attribute map for up to 10 codes. |
| `dcsc_get_configuration` | Paginated selected parts grouped by tab; follow structured `next` arguments. |
| `dcsc_configure` | Apply option changes. Returns only the diff. |
| `dcsc_set_quantity` | N identical units in one configuration. **Places one item in a rack.** |
| `dcsc_clone_configuration` | N configuration copies; optional `placement: "same-rack"` runs captured Clone Multiple staging/derive for direct, rule-free CTO items. Placement, commercial grouping, linked edits from either member, export and fresh-browser reimport are verified. Independent Copy uses `dcsc_copy_rack_item`. |
| `dcsc_set_node_role` / `dcsc_set_topology` | Tag Compute/Storage/Management; select a fabric. |
| `dcsc_undo` | Revert the last configuration edit. |
| `dcsc_set_configuration_controls` | Set Guided/Expert and Auto-Correct across the workspace, with atomic derive and persistence. |
| `dcsc_software_*` / `dcsc_services_*` | Catalog, select, inspect, remove and export standalone products. Use `dcsc_services_set_product_quantity` for covered-product count. Software and services `launch(refresh: true)` preserve selected quantities and saved prices while refreshing browse metadata. |
| **Solutions** | |
| `dcsc_add_rack` / `dcsc_place_in_rack` | Add a cabinet; place a configuration, validated by DCSC. |
| `dcsc_configure_pdu` | PDUs **and line cords**. A PDU without a line cord is not orderable. |
| `dcsc_add_storage_network` / `dcsc_edit_storage_network` | Create, update, rename and remove storage definitions. Updates use current catalog IDs, required workspace CAS and optional graph regeneration; inspect definitions through workspace layout pages. |
| `dcsc_place_storage_network` | Instantiate an existing AI/HPC storage definition in a rack using fresh physical controller/SAN-switch aliases. |
| `dcsc_customize_storage_switch` | Open or reopen a definition’s managed SAN-switch template with stable identity; excludes unplaced templates from workspace order totals. |
| `dcsc_assign_storage_network` | Assign an exact storage definition name (or null to clear) to an explicit server configuration. Auto-connect is optional and defaults to false. |
| `dcsc_customize_storage_controller` | Open the selected controller and return its configuration handle for option discovery/editing. Reopening preserves edits. Controllers remain managed by their storage definitions. |
| `dcsc_place_on_floor` | Floor tiles. Client-side planning only — DCSC has no floor endpoint. |
| `dcsc_add_cabling` | `/auto_connect` with persisted Automated Rack PDU, Automated Switch and P2P settings, or a local planning link. Local planning links are excluded from Lenovo exports. |
| `dcsc_workspace_layout` | Read validated elevation, cabling and floor with lossless detail pages. |
| `dcsc_edit_layout` / `dcsc_workspace_history` | Move/unplace/detach/remove/arrange and workspace undo/redo. `detach` mirrors native Delete Node and warns about Lenovo's reimport loss; use `unplace` for a roundtrip-safe loose node. |
| `dcsc_copy_rack_item` | Independent same-rack Copy for a supported General Purpose CTO item; separate edits and commercial lines. |
| `dcsc_set_rack_lock` | Lock/unlock a direct physical item or reserve an empty U; one-based input positions. |
| `dcsc_network_connectors` / `dcsc_set_network_preferences` | Stable compatible connector IDs and workspace device/cable choices. In AI/HPC workspaces, a changed automatic-switch preference provisions Lenovo's required main/leaf switches on Close; `autoConnect: true` additionally regenerates the graph. |
| **Analysis** | |
| `dcsc_power` | DCSC's own power and heat, aggregated and per rack. |
| `dcsc_scale_out` | Size N nodes into racks. Warns on air-cooling density. |
| `dcsc_compare_scenarios` | Price/power/rack trade-offs across designs; incomplete prices or power reports expose known subtotals and prevent misleading rankings. |
| `dcsc_validate` | Return the authoritative manufacturing verdict, exact diagnostic counts and explicit `validatedScope`; large reports include executable inspection links. |
| `dcsc_validation_jobs` | Page through persisted validation status, staleness, messages, local diagnostics, headroom and raw reports without another upstream request. |
| `dcsc_explain` / `dcsc_diff_sessions` | Why an option is unavailable; diff two configurations. |
| **Output & ops** | |
| `dcsc_export` | CFXML + Excel ZIP. Scope follows the handle. |
| `dcsc_import` | Import a CFXML through DCSC's own importer. |
| `dcsc_reconcile_workspace` | Propose, inspect and explicitly accept current reconciliation of legacy state. |
| `dcsc_recovery_inspect` | Page through restore warnings, quarantined records and preserved original-file archives, even when no workspace loaded. |
| `dcsc_recovery_export` | Export one workspace as a bounded JSON snapshot, or export an archive ID as its exact original bytes, including corrupt input. |
| `dcsc_session_info` / `dcsc_session_list` / `dcsc_session_close` | Session management. |
| `dcsc_health` | Circuit breaker state, WAF cooldown, effective config. |

### Two traps worth naming

**Scope follows the handle.** `dcsc_export` and `dcsc_validate` treat a
configuration id as *that configuration* and a workspace id as *the whole
solution*. They used to resolve a configuration id up to its parent workspace,
so asking to export one node in a seven-product solution exported all seven.

**Quantity is not placement.** `dcsc_set_quantity(4)` prices four nodes but is
still one configuration, so `dcsc_place_in_rack` adds one item to the cabinet.
For four nodes in a rack, use `dcsc_clone_configuration` and place each. The explicit
`placement: "same-rack"` option also places clones of a supported racked source; its
placement, grouped commercial export, browser reimport and restart gates pass.
Linked edits initiated from the source or a clone update the entire group atomically;
both paths pass commercial export and fresh-browser reimport. Configuration undo
restores the group only while every member still shares that edit boundary; use
workspace history after intervening edits. Divergent linked configurations are
rejected during export. `dcsc_copy_rack_item` implements the website's distinct
Copy operation for a supported direct General Purpose CTO item. It creates an
independently editable configuration with its own commercial lines; export,
fresh-browser reimport and immediate process-kill recovery pass.

Workspace exports preserve imported Message History records and include current
diagnostics. Supported HPC edits append native-style action records in the same
durable commit as the edit. Workspace undo/redo restores those records exactly.
Configuration-only `dcsc_undo` restores configuration state without rewinding
the workspace action history; use `dcsc_workspace_history` for that scope.

Workspace summaries and layouts include executable `inspect`, `detail` and
`next` objects for large collections, raw connection fields and warnings. Pass
their arguments unchanged: `expectedWorkspaceRevision` prevents a design edit
from shifting the results midway through inspection. Restart inspection after a
revision conflict. Global part and standalone software catalog continuations
similarly carry a fingerprint and preserve the query and filters. Page offsets
advance by the number actually returned after response-size trimming.

Auto-connect settings are optional partial edits, for example
`dcsc_add_cabling(session, settings: {autoAddPDU: false})`. Omitted fields retain
their saved value. Settings and the accepted connection result commit together;
a rejected operation leaves both unchanged. These settings apply to subsequent
layout and auto-connect requests. A successful empty connection result does not
prove a populated networking design works.

### Why the tools look like this

A single `launch` response is ~150 KB — it cannot go into a model's context.
Every tool therefore returns a **projection**, not the tree:

```
L0  session summary   tabs, price, constraints            ~1–2 KB
L1  tab view          sections + current selections       ~1 KB
L2  section view      one line per option, paginated      ~1–3 KB
L3  feature detail    everything, for a few codes         ~1 KB
```

Two deliberate choices worth knowing:

- **Search beats browsing.** `dcsc_list_options(session, query: "64GB")` searches
  every tab at once. Walking eleven tabs to find a feature code is the failure
  mode the design exists to prevent.
- **Prices are deltas.** Within a section, options are priced relative to the
  current selection ("+$4,200"), because that is the question actually being
  asked.

## What it cannot do yet

- Populated Management cabling passes browser/MCP graph and export handoff checks.
  `dcsc_cabling_connections` exposes stable existing-row IDs, endpoint ports and
  compatible cable parts; `dcsc_edit_cabling_connection` supports revision-bound
  endpoint and cable-part edits with authoritative distance/derive results, atomic
  persistence and crash recovery. Lenovo's UI has not exposed Add/Delete for these
  rows. Lenovo's native shared-part edit preserves the graph row but drops its
  part from the canonical BOM; the MCP uses a quantity-preserving request path
  that passes derive, export and immediate process-kill recovery. Same-component
  occupied destination ports are swapped atomically with both affected rows
  reported. Distributed leaf preference Close now matches Lenovo's switch
  calculation, launch, layout and derive sequence. Its exact three-row graph,
  crash restart, export and fresh-browser handoff pass. Managed-storage
  physical-alias cable-part edits remain an explicit verification gate. The
  maintained post-import Direct Attached FC probe receives HTTP 200 without
  errors but returns zero storage rows; its historical input retains a prior SAN
  configuration. Separate clean FC and optical iSCSI exports also return zero
  rows after fresh import, but that import collapses the managed template root
  into its physical alias and omits `definition.controller.id`; those results
  remain qualified post-import controls. A fresh optical-iSCSI pre-export case
  preserved the distinct managed root and physical alias, controller reference,
  assigned racked server, compatible connector media and P2P settings, with no
  switches present. Lenovo still returned HTTP 200 without errors and zero
  connections. This is a bounded result for that tested design, not evidence of
  a global storage outage. The maintained FC runner exits 2 rather than treating
  an unrelated Management row as storage evidence.
- Controller editing supports the captured DM3200F and selected-base BCBN launch contracts.
  SAN-switch opening, reuse, option edits propagated to physical aliases,
  commercial export/reimport and exclusive deletion also pass. Current supported
  catalogs contain no expansions.
  Controller browser import matches the website-own XML import, including its
  limitation: it drops the editable controller configuration while retaining the definition and commercial rows.
- Allowed multiple PDU quantities pass. Supported nested chassis/node creation,
  export/import, independent nested-node edits, unplace/re-place, detach,
  chassis removal with explicit child disposition, history and immediate
  process-kill recovery pass. The strengthened real-MCP lifecycle covers 291
  calls, including both parent dispositions and their reimports; all three native
  removal action gates also pass. Native Delete Node keeps the node's commercial
  configuration in the export but Lenovo drops it on reimport. The MCP therefore
  exposes that behavior as `detach` with an explicit warning; `unplace` preserves
  the node as a loose physical item through export/import. Broader VLH/container
  shapes remain matrix growth.
  Item and empty-U locks use captured wire formats and pass transactional,
  restart and live server-acceptance checks. Reserved U positions survive CFXML
  export/import. Lenovo's own CFXML exporter does not persist an item's `lock`
  flag: replaying the browser-native export form and importing its XML drops the
  item lock while retaining the reserved U. The MCP matches that upstream limit.
  Direct racked Clone Multiple, linked edits and independent Copy pass. The captured two-rack PDU/cord handoff and MCP workspace history pass.
  Unsupported imported container shapes are rejected with
  their source data preserved rather than flattened.
- Standalone service coverage currently supports one serviced product with one
  base package plus independent add-on families. Use `dcsc_services_launch(workspace, refresh: true)` to restore
  selectable metadata after import before selecting another option. Independent services remain separate from hardware
  and standalone software, matching the website workflow. The website selects one
  of each service per product; its summary counter changes covered-product count.
  `dcsc_services_set_product_quantity` preserves imported service quantities and
  refreshes summary pricing. `dcsc_services_set_quantity` is an API extension:
  unsupported quantities fail without saving state and report the requested and
  accepted values. Imported non-unit service quantities remain readable and
  exportable. In the verified non-unit service case, Lenovo displays the correct
  quantities after import and product resize, but its native Save sends an empty
  service list and returns HTTP 500. MCP export preserves those quantities and
  reimports correctly; use the MCP to save further changes in that workflow.
- Software group selection/removal, multi-select, maintenance and priced CAL
  quantity changes follow captured website contracts. Discover exact section IDs
  with `dcsc_list_options`; change derived licence quantities separately. The
  verified 50-user CAL filter has no None option: remove its User CAL group to
  match the website's Reset while retaining Device CAL. Priced CAL quantity-three exports match the browser in both scopes. Broader licensing remains a verification case.
- Saved quantity imports from earlier builds have their linked clone ownership
  repaired on restart when the original identities and selected configurations
  prove the repair safe. The original file is archived first. Conflicting or
  independently edited members remain readable but cannot be changed; recover
  the source file and import complete CFXML into a new workspace.
- Designs migrated from v1 remain `legacy-unverified`. Export and manufacturing
  validation require re-import or explicit acceptance of a current reconciliation.
  Configuration reconciliation cannot certify legacy physical layouts or repair
  quarantined configurations, cables, racks, floor items or PDU references. Those
  designs require repair or a complete current CFXML import. Discarded history
  stays recoverable without being confused with missing current design data.
  Restore failures and original-file archives are discoverable through
  `dcsc_recovery_inspect`; `dcsc_recovery_export(archiveId)` preserves source bytes
  even when JSON parsing failed.

Software-only export defaults to the reports offered by the website, including
CFXML, workbook and CSV outputs. Rack and connection reports require hardware.
Mixed CTO hardware plus standalone software uses the CTO export endpoint.

## Configuration

All settings take `DCSC_`-prefixed env vars, or a JSON file at
`~/.config/lenovo-dcsc/config.json`. Env wins.

`dcsc_set_locale` changes the current process default for subsequent searches and
launches. It resets to configuration on restart; saved workspaces retain their own
country/currency. `dcsc_health` reports the active default separately from config.

`dcsc_solution_modes` returns the website labels and function flags for each mode.
The captured AI/HPC mode enables Preferences, Auto Connect and Auto Arrange; General
Purpose disables those UI controls. Build networking solutions in the appropriate
mode from the start. Importing a General Purpose CFXML can restore its original mode.

| Variable | Default | Notes |
|---|---|---|
| `DCSC_COUNTRY` / `DCSC_GEO` / `DCSC_LANGUAGE` / `DCSC_CURRENCY` | `US` / `NA` / `en` / `USD` | These four travel together; a mismatched pairing is a classic DCSC 500. |
| `DCSC_HOST` | `dcsc.lenovo.com` | Restricted to a fixed allowlist. |
| `DCSC_MAX_CONCURRENCY` | `2` | |
| `DCSC_TOOL_REQUEST_BUDGET` | `40` | Hard cap per tool call. |
| `DCSC_LOG_LEVEL` | `info` | Logs go to **stderr**; stdout is JSON-RPC. |
| `DCSC_LOG_RAW_ERRORS` | `false` | Local debugging only — bypasses 5xx redaction. |
| `DCSC_ENABLED` | `true` | Kill switch. |

## Operational rules this codebase enforces

These are structural, not conventional — both are checked by ESLint and by tests.

1. **One HTTP chokepoint.** Only `src/http/**` may import `undici`. Everything
   else calls `send()`, which applies the six mandatory headers and seven
   mandatory query params. Omitting `integrationParams: {}` or `masterSlices`
   makes DCSC return HTTP 500, sometimes with a raw JDBC statement, so
   `assertPreamble()` fails **locally** before a request is spent.

2. **5xx bodies never reach the user.** DCSC leaks SQL, Java stack frames and
   internal hostnames in error responses. Users see a fixed template plus a
   request id; logs get a redacted, hashed form. Covered by tests.

3. **Back off, never evade.** HTTP 499 is DCSC's bot-mitigation verdict. It is
   never retried and trips a global cooldown ladder (60 s → 5 m → 15 m → 1 h).
   The User-Agent is pinned, the host list is fixed, and there is no proxy
   support anywhere — rotating any of those to dodge the flag would change what
   this activity is, and the codebase forecloses it.

4. **A 5xx on a POST is ambiguous, not retryable.** It raises
   `DcscAmbiguousStateError` so the caller re-reads state. A silent duplicate
   mutation is worse than a visible failure.

5. **The raw payload is kept verbatim.** DCSC holds no server-side session
   (`launch` returns `id: null`), so the client owns the configuration and posts
   it back on mutation. All summarization is derived *beside* the raw, never
   instead of it.

## How mutation and export actually work

These contracts were recovered by driving the real SPA in a browser and reading
the outgoing requests (`fixtures/capture/autoDerive-request.json`). They are
undocumented and were not guessable — several details cost repeated HTTP 500s
before the capture settled them.

**The configuration lives on the client.** `launch` returns `id: null`; DCSC
keeps no server-side session. The client generates the id (`US__<uuid>0`) and
posts the configuration back on every call.

**Mutation — `POST /api/ctos/autoDerive`** (`batch_customizing` is 404 in the
current release; it has been retired):

- The body carries a **reduced** model, not the 150 KB launch tree: only the
  sections that hold selections, each with its `results[]`. About 24 KB.
  Posting the full tree fails with `ConfigurationResult.getSections() is null`.
- A `delta` describes the change — `{section, featureCode, quantity,
  previousFeatureCode, previousQuantity}`. DCSC reconciles dependent parts from
  it, so it is load-bearing rather than descriptive.
- `workspaceInformation.configurations` is **null**; the configurations go in
  the top-level `configurations` array.
- `workspaceInformation.nonRackData` (physical placement) is a different object
  from `workspace.nonRackArea` (layout). Conflating them returns a bare 500.
- **A priming `autoDerive` with no delta must run right after launch.** It
  materialises the derived sections — fillers, labels, voltage, service and
  software rows — that the launch response does not contain. Without it the
  first real change is rejected.
- `customizingFlags.autoDerive` remains true. Auto-Correct maps to `autoVariant`;
  hardware requests carry `guideMode` in the query. Expert forces Auto-Correct off.
  Software mutations use the captured software flags and return a software patch,
  which requires its own reconciliation rather than the hardware response parser.
- **Three identifiers name a section, and only one of them works.** DCSC's
  internal `section.name` (`FRONT_NONRAID_HDD`, `PDU`) is what the reduced model
  matches on; `section.description` is the human title the listings print
  (`Front HDD not in RAID Array`, `Power Distribution Unit`); our synthetic slug
  (`storage.front-nonraid-hdd`) is a third. `dcsc_configure` resolves all three
  via `resolveSection` and rejects an unknown section with candidates — passing
  a title used to create a phantom section that autoDerive accepted and dropped,
  which was indistinguishable from success.
- **A selection into a section with no existing results must carry its
  sub-tab.** `reduceConfiguration` keeps only sections that already hold
  results, so a first selection (drive bays on a fresh node, PDUs on a fresh
  rack) synthesizes the section. Synthesizing it with an empty `subTabTitle`
  produced an HTTP 200 with the change silently discarded.
- **Never trust `applied`.** DCSC returns 200 for changes it ignores, so
  `dcsc_configure` re-reads the post-change index and reports `notApplied` per
  requested code rather than assuming the round trip meant success.

**Export — `POST /api/ctos/export_zip`**, a form-encoded POST (the SPA submits
it through a hidden iframe, but at the wire level it is an ordinary POST):

- `exportFileTypes` is a plain top-level array inside `data` — `["XML",
  "QUOTE", "SUMMARY", …]`. Omit it and the server returns HTTP 200 with a valid
  but **empty** archive. It is not the `{zipAll, selection}` shape the bundle's
  own builder function suggests.
- The export DTO takes a **different configuration shape** from autoDerive and
  rejects unknown properties. It reads `code`, not `ctoCode` — omit `code` and
  the rule engine requests `/cto/characters/` with an empty segment and 404s.
- `cloneDependencyColor` values are objects, not colour scalars; `{}` is fine.
- `networkingInformation` and `messageHistory` use operation-specific captured
  shapes. Preserve import provenance in saved state; do not post the entire import
  response as an export DTO.
- The query is minimal — `country_or_region`, `language`, `currency`,
  `fileName`, `_request` — with no `geo`, `solutionMode` or `masterSlices`.
- `image` is empty for a non-rack configuration. Rack Report requires a PNG;
  this server renders one from physical positions without launching a browser.

Output: a ZIP containing `<name>.xml` (Lenovo **CFXML 2.6** — the file that
re-imports into DCSC and raises a bid in Lenovo Bid Portal) and `<name>.xlsx`
(the quote workbook). Archives land under `DCSC_ARTIFACT_DIR` with a manifest.

### Re-capturing after a DCSC release

If a release breaks these contracts, re-capture rather than guess:

```bash
playwright-cli -s=dcsc open "https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server" --browser=chromium
```

Then install a hook that records the outgoing form and **suppresses the submit**
(the download otherwise kills the CLI session), drive Summary → Export → Save,
and read `window.__cap` back with `eval`. Query specific fields rather than
dumping the whole 27 KB body.

## Drift detection

DCSC is undocumented, unversioned, and ships releases weekly to fortnightly.

```bash
npm run mine
```

fetches the date-stamped SPA bundle, extracts every API path literal, the export
form fields and the format flags, and **diffs them against the previous
baseline** — telling you what Lenovo added, removed or renamed *before* you call
any of it. This costs **zero API requests**. Run it on a schedule.

## Tests

```bash
npm test        # offline; no network
npm run lint
npm run typecheck
```

`test/safety.test.ts` covers the properties that must not regress: redaction,
the 5xx template, the retry and 499 policies, the preamble assertion, export
filename sanitisation, and the mutation diff.

`test/scope-and-power.test.ts` covers the defects found building a real AI
factory — handle-scope resolution, rack density banding, blueprint
completeness disclosure, and the option-list truncation that hid every line
cord on a rack.

Live checks (these hit DCSC; keep them occasional, not per-commit):

```bash
npx tsx scripts/smoke.ts         # client foundation, ~4 requests
npx tsx scripts/export-smoke.ts  # launch -> exact CPU derive -> nonempty XML/XLSX export
npx tsx scripts/mcp-smoke.ts     # bounded stdio responses, mutation and nonempty export
npx tsx scripts/conformance.ts   # dynamic tool inventory, continuations and response budgets
npx tsx scripts/verify-fixes.ts  # export regression checks across configuration shapes
npm run parity:headless          # isolated Chromium; reports pass/fail/blocked per case
npm run parity:software          # fresh headless browser/MCP OS & Software differential
npm run parity:recovery          # real MCP stdio recovery, SIGKILL/restart and live legacy validation
npm run parity:projections       # real MCP stdio large-workspace paging and exact detail reconstruction
npm run parity:storage           # live MCP controller edit/assignment and immediate SIGKILL/restart
npm run parity:storage-reimport -- --mcp-xml /path/to/managed-controller.xml
npm run parity:rack-clone -- --action=clone --fresh # headless physical-clone browser oracle
npm run parity:nested-vlh       # native supported chassis/node workflow and export handoff
npm run parity:nested-stdio     # real MCP nested edit/history/crash/import/export lifecycle
npm run parity:nested-remove-chassis -- --out=/path/to/report # native populated-chassis Delete wire oracle
npm run parity:nested-detach -- --out=/path/to/report         # native Delete Node wire/export oracle
npm run parity:nested-unplace -- --out=/path/to/report        # native Move To Non Rack wire/export oracle
npm run parity:controls-locale   # headless DE/EUR conflicting-control differential
npm run parity:catalogs          # exhaustive bounded catalog/fabric/software continuations
npm run parity:blueprints        # launch every available blueprint; reject retired entries
npm run parity:validation        # strict authoritative verdict, payload/hash and stale-job gate
npm run parity:services          # base service + add-on selection, removal, export and reimport
npm run parity:network           # populated Management graph and fresh-browser handoff
npm run parity:network-leaf      # Distributed main/leaf graph, restart, export and browser handoff
npm run parity:rack-power        # captured two-rack PDU/cord handoff, history and restart
npm run parity:storage-placement # managed storage physical placement, derive and export
npm run parity:storage-placement-reimport -- --mcp-report /path/to/storage-placement/report.json --out /path/to/reimport-report
npm run parity:storage-fc -- --out /path/to/report # post-import Direct Attached FC control; currently exits 2 on HTTP 200/zero storage rows
npm run parity:manual-cabling    # existing-row cable derive, SIGKILL recovery and export
npm run parity:manual-cabling:shared    # preserve a shared cable quantity while splitting one row
npm run parity:manual-cabling:collision # atomically swap an occupied destination port and restart
```

Parity runners exit `1` for a failed assertion and `2` when every executed
assertion passed but a required upstream capability is blocked. A blocked run
is never reported as release success.

`npm run release:checkpoint` records the current **54-command** local/live/headless
matrix, including every command advertised above, its fixture dependencies and
the exact dirty source snapshot. Run that ordered inventory from the materialized
checkout described in its manifest; declared exit-2 capabilities remain blocked,
not passing.

**`verify-fixes.ts` covers breadth.** Where conformance walks every tool once,
this walks the same fixes across shapes that behave differently: a plain CTO
node, a cloned multi-configuration workspace, a rack with PDUs and line cords,
current products in a second solution mode, an LFO model, and a GB300
tray in the MGX cabinet. It asserts on the exported CFXML itself — counting
`ConfigurationGroupLineNumberReference` blocks — rather than trusting the
server's own report of what it exported.

**`conformance.ts` checks transport coverage.** It inventories the current tool
registry dynamically (72 tools at this checkpoint) and asserts that every registered
tool is exercised — the coverage gate fails if a tool is added without a check —
and it covers what the happy path misses: the LFO endpoint family, batched
changes, pagination, filters, stale-revision rejection, and the error surface
(including that no internals leak). It caught three real bugs the smoke test
could not: LFO priming routed to the CTO endpoint, LFO export routed to the CTO
endpoint, and `toToolError` collapsing our own guidance messages into a generic
string.

Mutation tools accept `expectedRevision` for optimistic concurrency. Configuration
edits (quantity, undo and role) compare the configuration revision; layout,
cloning, cabling, PDU and joining an existing workspace compare its workspace
revision. Tool schemas state the scope. A stale request fails before commit.
Closing a standalone-only workspace deletes its persisted basket; closing the
last hardware configuration retains any standalone basket in that workspace.

The headless suite is a separate semantic gate. It compares browser state and
handoffs and records unresolved cases explicitly. Historical fixtures retain
serialization evidence; current catalog prices require contemporaneous comparisons.

## Limits and risks

- **List prices only, and not a quote.** Anonymous responses carry list price
  for one country and currency. Partner and bid pricing sit behind
  `/lbp/*`, which requires a Lenovo ID. Configuration summaries include currency,
  country, `pricedAt` and a disclaimer. Missing or unavailable prices remain null;
  known subtotals are reported separately from complete totals.
- **Lenovo's terms apply.** There is no `robots.txt` (it 404s), but that is not
  permission. Closed CORS and a WAF are signals this traffic is not intended.
  Whether to run this is a business decision, not a technical one.
- **It will break.** Undocumented and unversioned against a weekly release
  cadence. Budget maintenance; run the drift detector.
- **A configuration containing errors cannot be imported into Lenovo's quote
  tools.** Any feature that presents a config as quote-ready must check this.
- **The legitimate path exists.** Lenovo runs an internal DCSC API programme
  (release notes reference configuration API response modes, an xconfig search
  API, and "Public-to-APIH"). It is partner-gated and undocumented. Contact
  `salesconfig@lenovo.com`.

  If credentials arrive, the swap point is `DcscService` — the MCP tools already
  talk only to it, never to HTTP. A formal `DcscTransport` interface was drafted
  and then removed: with one implementation it was unreferenced code, and
  guessing the shape of an API nobody has seen would have been worse than
  deriving it when it exists.

Persistence errors return `kind: persistence`, `localNotCommitted: true`, and
`remoteApplied` to distinguish a local-only failure from a completed Lenovo
operation whose local save failed. The committed design is retained and no
automatic retry occurs; follow the returned recovery guidance.
