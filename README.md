# lenovo-dcsc-mcp

An MCP server that drives Lenovo's **Data Center Solution Configurator**
([dcsc.lenovo.com](https://dcsc.lenovo.com/)) programmatically, so an LLM can
search the catalog, launch a configuration, explore options against Lenovo's
real rules engine, and read back list prices.

DCSC ships only as a browser SPA. This server talks to the same same-origin
JSON API the SPA uses. **No Lenovo login is required** for catalog, launch and
pricing — that is verified, not assumed.

## Install as a Claude Code plugin

```bash
claude plugin marketplace add leuquim/lenovo-architect
claude plugin install lenovo-dcsc@lenovo-architect
```

Not affiliated with or endorsed by Lenovo. Prices are DCSC list prices as returned by the public configurator.

---

For maintainers: [current context](.docs/context.md), [review cleanup plan](.docs/roadmaps/2026_11_01_review_cleanup_plan.md), and [Phase 3 design](.docs/roadmaps/2026_11_01_phase3_design.md).

## Status

| Capability | State |
|---|---|
| Catalog search & browse | **Working** |
| Launch a CTO/LFO configuration | **Working** |
| Explore options (search, tabs, sections, feature detail) | **Working** |
| List pricing + resource constraints | **Working** |
| Bill of materials | **Working** |
| Change selections (mutation, with rules reconciliation) | **Working** |
| PCI and storage wizards | **Working** — inspect/select options, edit components and optional PCI slots, clear storage options, switch RAID mode (`pci-wizard*`, `storage-wizard*`) |
| Multiple identical units (quantity) | **Working** — extends price and the exported line |
| Duplicate a configured product N times | **Working** — configuration copies, racked Clone Multiple, linked edits and independent Copy (`rack-clone*`, `rack-copy`, `chassis-*`, `quantity-handoff-*`) |
| Export CFXML + Excel ZIP | **Working** — per configuration or per workspace |
| Import XML | **Working** via DCSC's own `/multiple/cfxml_import`, except the x-config fixture, which DCSC rejects for the website too (`xconfig-import`) |
| Preconfigured (LFO) models | **Working** — launch, inspect, export |
| Multi-product solutions (server + switch + rack) | **Working** — one workspace, many configurations |
| Rack enclosures + U placement | **Working** — placement validated by DCSC (`rack-*`) |
| PDUs, line cords, power & heat reporting | **Working** |
| Power settings | **Working** — voltage, policy and load factor (`power-controls`); missing native power is reported as unavailable |
| Native reference solutions | **Working** — browse, customize and download Lenovo's original XML |
| Manufacturing validation (`/lmc_validation`) | **Working** — terminal valid/invalid verdicts bound to the current export payload (`validation`); the website's own call errors anonymously |
| Cabling | **Working** — automatic Management and manual Management/100GbE/DAC storage workflows, replacement, shared selections (`manual-*`, `network-*`); breakout is a known difference after DCSC reimport |
| Rack/floor export | **Working** — rack/floor data, PDU/cord reports and workbook sheets (`rack-lifecycle`, `floor-preference`, `rack-power*`, `workbook-import`) |
| Storage definitions and components | **Working** — definitions, placement, server assignment, controller/SAN editing, manual DAC connections, direct-attached FC, export/reimport and removal (`storage-*`) |
| Standalone software and product services | **Working** — software quantity and covered-product count, export and website import; independent services use a separate basket (`software-*`, `services*`) |
| Guided/Expert and Auto-Correct | **Working** — Guided supports on/off; Expert forces Auto-Correct off |
| Cluster / HPC-LeSI solution modes | Not offered anonymously (`/api/solution_modes` lists General Purpose and HPC and AI - Systems) |
| Account saves and partner/bid pricing | Login-gated; out of scope (website-actions.md "Authenticated backlog") |

The server registers **41 MCP tools**, each with complete MCP annotations and a
bounded response size (8,000 bytes). Run `npm run check` (typecheck, lint, unit
tests, offline contracts, build, stdio smoke) for local checks. Live API
contracts and the browser-vs-MCP parity harness (`scripts/parity`) are separate
gates; a passing request alone does not establish website parity. Browser runs
use isolated headless Chromium. The plan and design are in `.docs/roadmaps/`.

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

## Tools (41 Registered Tools)

| Tool | Purpose |
|---|---|
| **Discover** | |
| `dcsc_settings_get` | Country, language, currency and the available solution modes. |
| `dcsc_settings_set` | Set the default country and language, and the withdrawn-since date that also lists withdrawn products. |
| `dcsc_search` | Find products, parts, preconfigured codes, SIDs, specialty catalog entries, service products and the software offered for a product ID (`kind`: products, tree, parts, preconfigured, sids, specialty, serviceProducts, software). |
| `dcsc_category` | Category pages, sub-category filters, services categories and the discovery routes of a category or product. |
| `dcsc_reference_solutions` | Browse the Deployment-Ready and TruScale reference solution catalog. |
| **Launch & import** | |
| `dcsc_launch` | Open a CTO, LFO, LFO-as-CTO, reference solution, software or services basket, or load Unconfigured options. |
| `dcsc_import` | Import a CFXML or Excel file or XML text. |
| **Configure** | |
| `dcsc_configuration_get` | Read a configuration: tabs, options, selections, feature detail, rule errors, slot and bay resources, rule changes, recommendations, rule versions. |
| `dcsc_configure` | Apply option changes, sales quantity, Guided/Expert mode, Auto-Correct and the AI Express / Full Mode switch. |
| `dcsc_wizard_get` | Read the PCI or storage wizard options and current selection. |
| `dcsc_wizard_set` | Select PCI or storage wizard options. |
| `dcsc_auto_fix` | Resolve rule validation errors in hardware sections, as the website Auto-fix does. |
| `dcsc_basket_browse` | Browse the standalone software catalog or loaded services options. |
| `dcsc_basket_set` | Add, change or remove items in a standalone software, hardware or services basket. |
| **Workspace, racks & floor** | |
| `dcsc_workspace_get` | Workspace summary, rack and floor layout, baskets, undo history and saved validation jobs. |
| `dcsc_rack_get` | Rack cabinets, compatible chassis and nodes, and PDU and cord options of a rack. |
| `dcsc_rack_add` | Add a rack cabinet to a workspace. |
| `dcsc_rack_edit` | Place, move, unplace, detach, remove, lock, clone and copy items. |
| `dcsc_rack_position_rule` | Valid U-positions and placement rules for an item in a rack. |
| `dcsc_floor_set` | Position and colour racks, edit the Floor Preference, and flip the Auto Arrange and COG Validation controls. |
| `dcsc_pdu_set` | Set rack PDUs and line or jumper cords. |
| **Network, cabling & storage** | |
| `dcsc_network_get` | Network catalog (topologies, devices, cables, controllers, switches) and the connectors of a topology. |
| `dcsc_network_set` | Select a topology and connectors, set a node role or save network preferences. |
| `dcsc_auto_connect` | Run Auto-Connect to generate the workspace cabling. |
| `dcsc_cabling_get` | Connection graph with stable row IDs, port choices, compatible cables and the distance between two endpoints. |
| `dcsc_cabling_set` | Create manual connections or edit endpoints and cable parts. |
| `dcsc_storage_get` | Storage network definitions, assignments and detached storage hardware. |
| `dcsc_storage_set` | Add, update, rename, remove, assign, place or customize storage networks. |
| `dcsc_vlh_get` | VLH wizard info and the dimensions and connectors of a product. |
| `dcsc_vlh_set` | Create VLH items and export them to a `.vlh` file, or import a `.vlh` file (upstream currently returns HTTP 500). |
| `dcsc_virtual_container_get` | Compatible inner products and rule results of virtual containers. |
| **Power** | |
| `dcsc_power_get` | Engineering Power Report, and the voltage, load factor and policy choices of a configuration. |
| `dcsc_power_set` | Save voltage, load factor and power policy. |
| **Validate & export** | |
| `dcsc_validate` | Manufacturing validation, optionally with the mandatory software check. |
| `dcsc_export` | Reports ZIP (mode-aware default types), power report, configuration tree, reference XML or Services catalog ZIP, returned as file paths. |
| **Sessions & analysis** | |
| `dcsc_session_list` | Open sessions and workspaces, client health and restore diagnostics. |
| `dcsc_session_close` | Discard a configuration or workspace. |
| `dcsc_undo` | Undo or redo workspace edits, or revert the last configuration change. |
| `dcsc_compare` | Compare scenarios, size scale-out racks, diff two configurations, fetch service insights. |
| `dcsc_reconcile_workspace` | Propose, inspect and accept reconciliation of damaged or legacy workspaces. |
| `dcsc_recovery_export` | Export a recovery JSON snapshot or original archive bytes. |

### Workflow notes

**Imports.** `dcsc_import` goes through DCSC's own importer. When Lenovo omits the
floor grid on an x-config rack, the MCP uses native hierarchy U-position codes and
the website's default client-side floor placement; incomplete explicit metadata
still fails. Inspect the import diagnostics: Lenovo accepting the XML does not mean
saved cabling was recovered. Native compressed rack groups expand by original
identity and U-position (`grouped-rack-import`, `nested-grouped-import`). Imported
Unconfigured selections are kept across derivation and exported as separate lines
(`reference-unconfigured`); edit them with `dcsc_launch` and `dcsc_configure`.

**PCI risers use the native wizard.** Discover choices with `dcsc_wizard_get`, then
`dcsc_wizard_set` with the workspace revision, option ID and optional row/slot
choices. Ordinary riser feature edits are rejected because Lenovo can silently
discard them (`pci-wizard`, `pci-wizard-linked`).

**Storage wizard.** `dcsc_wizard_get` shows option IDs, groups, feature codes and
quantities; `dcsc_wizard_set` selects an option or edits a component. `optionId: null`
clears the option once its drives are removed, as the website's drive guard
requires. Adding a controller can create an invalid combination: the response
reports native storage errors; remove the previous controller separately. On
storage-wizard CTOs, changing `RAID_CONFIG` through `dcsc_configure` clears drives,
backplanes and controllers like the website: submit the mode switch alone, then
choose parts (`storage-wizard`, `storage-wizard-raid`, `storage-wizard-sr850`).

**Power.** `dcsc_power_get` lists voltage IDs and policy values; `dcsc_power_set`
saves them with the returned workspace revision. `loadFactor` is the slider
percentage; reported utilization is calculated. Export warns for nondefault load
factors.

**Cabling.** Auto-connect counts are not a completeness verdict: follow
`pages.diagnostics` or `dcsc_workspace_get` with `path: ["cablingDiagnostics"]`.
Edit existing native rows with `dcsc_cabling_get` then `dcsc_cabling_set`;
`refreshConnectionId` plus `expectedRevision` refreshes the choices of one row
without changing the design. For manual creation, choose free ports, call
`dcsc_cabling_get`, then pass an offered part and the same revision to
`dcsc_cabling_set`; `pinExistingRoutes: true` keeps existing routes as MANUAL,
otherwise native rerouting is rejected. `cableQuantities: { oldPart, newPart }` sets
per-product quantities on replacement. Native cable-rule errors abort the edit
without committing anything. Manual planning links are not in native connection
counts or Lenovo exports. Cases: `manual-create*`, `manual-cabling-*`,
`manual-replace-*`, `manual-source-swap`.

**Scope follows the handle.** `dcsc_export` and `dcsc_validate` treat a
configuration id as that configuration and a workspace id as the whole solution.

**Quantity is not placement.** `dcsc_configure` with `salesQuantity: 4` prices four
nodes but is one configuration, so `dcsc_rack_edit` adds one item to the cabinet.
For four nodes in a rack use `dcsc_rack_edit` (action `clone`, optionally
`placement: "same-rack"`) and place each (`rack-clone`, `quantity-handoff-*`).
Linked edits from the source or a clone update the whole group atomically; divergent
linked configurations are rejected during export. Configuration undo restores the
group only while every member shares that edit boundary; use workspace history
after intervening edits or when a chassis edit also updates its nodes
(`chassis-clone`, `chassis-parent-edit`). `dcsc_rack_edit` also implements the
website's independent Copy (`rack-copy`, `chassis-copy`, `chassis-linked-copy`,
`chassis-member-copy`). Unsupported imported container shapes are rejected with
their source data preserved rather than flattened.

**Large results.** Workspace summaries and layouts include executable `inspect`,
`detail` and `next` objects; pass their arguments unchanged. `expectedRevision`
stops an edit shifting the results midway; restart inspection after a revision
conflict. Part and standalone software catalog continuations carry a fingerprint
and keep the query and filters.

**Auto-connect settings** are optional partial edits, e.g.
`dcsc_auto_connect(session, settings: {autoAddPDU: false})`; omitted fields keep
their value, and a rejected operation leaves settings and connections unchanged.
An empty connection result does not prove a networking design works.

**Standalone services** support one serviced product with one base package plus
independent add-on families, kept separate from hardware and software baskets
(`services`, `services-quantity`). After import, `dcsc_launch(workspace, refresh: true)`
restores selectable metadata. Unsupported quantities in `dcsc_basket_set` fail
without saving state.

**Software** group selection, multi-select, maintenance and CAL quantity changes
follow the captured website contracts (`software-*`). Discover section IDs with
`dcsc_configuration_get`; change derived licence quantities separately.

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

- **Search beats browsing.** `dcsc_configuration_get(session, query: "64GB")` searches
  every tab at once. Walking eleven tabs to find a feature code is the failure
  mode the design exists to prevent.
- **Prices are deltas.** Within a section, options are priced relative to the
  current selection ("+$4,200"), because that is the question actually being
  asked.


## What it cannot do yet

Limits are where the website does something the MCP does not, or where DCSC
refuses. Evidence is the latest parity report for the case id, or
[.docs/website-actions.md](.docs/website-actions.md).

- **Upstream errors for the website too.** x-config rack import (`xconfig-import`,
  `POST /multiple/cfxml_import` returns HTTP 500) and `.vlh` import (`vlh-import`,
  `POST /vlh/import` returns HTTP 500) are blocked. The website's Manufacture
  Validation and Tools > Recovery server list also fail anonymously (HTTP 500).
- **Breakout cabling does not survive DCSC's own CFXML import.** The MCP keeps the
  breakout divider; the website returns P2P/divider 1 after reimport
  (`manual-create-breakout`, `manual-replace-breakout`, known differences).
  Breakout and splitter cables are excluded from manual point-to-point creation.
- **Power load factor resets on CFXML import** (`power-controls`): inspect and
  reapply it after import.
- **LFO RAID-mode switching is rejected** until fixed-part restoration is supported
  (`src/app/serviceHelpers.ts`); use the website.
- **Legacy Excel recovery is unsupported.** When Lenovo asks for a companion Excel
  recovery step on import, the MCP warns that floor placement and cabling may be
  incomplete (`src/app/importExport.ts`).
- **Designs migrated from v1 are `legacy-unverified`.** Export and manufacturing
  validation require re-import or explicit acceptance of a current reconciliation.
  Restore failures and original-file archives are listed by `dcsc_session_list`;
  `dcsc_recovery_export(archiveId)` returns the source bytes.
- **Website actions with no tool** (the website-actions.md "GAP" rows): feature-flag
  list, news panel, configuration name and colour, Show Errors and the Auto-Correct
  character table, slot-occupancy summary, view-only filter, sort and column
  state, the direct `/ctos/export` Save, and the `isAiExpress` category filter.
- **Login-gated, out of scope:** Config AI+, quote spreadsheet export, saved
  configurations and auto-save restore, partner/bid pricing (website-actions.md
  "Authenticated backlog"). Cluster / HPC-LeSI modes are not offered anonymously;
  `/api/solution_modes` returns General Purpose and HPC and AI - Systems only.

Software-only export defaults to the reports offered by the website, including
CFXML, workbook and CSV outputs. Rack and connection reports require hardware.
Mixed CTO hardware plus standalone software uses the CTO export endpoint.

## Configuration

All settings take `DCSC_`-prefixed env vars, or a JSON file at
`~/.config/lenovo-dcsc/config.json`. Env wins.

`dcsc_settings_set` changes the current process default for subsequent searches and
launches. It resets to configuration on restart; saved workspaces retain their own
country/currency. `dcsc_session_list` reports the active default separately from config.

`dcsc_settings_get` returns the website labels and function flags for each mode.
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

These are structural, not conventional — both are checked by oxlint and by tests.

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
factory — handle-scope resolution, rack density banding, and the option-list truncation that hid every line
cord on a rack.

Live checks (these hit DCSC; keep them occasional, not per-commit):

```bash
npx tsx scripts/smoke.ts         # client foundation, ~4 requests
npx tsx scripts/export-smoke.ts  # launch -> exact CPU derive -> nonempty XML/XLSX export
npx tsx scripts/mcp-smoke.ts     # bounded stdio responses, mutation and nonempty export
npx tsx scripts/conformance.ts   # dynamic tool inventory, continuations and response budgets
npx tsx scripts/verify-fixes.ts  # export regression checks across configuration shapes
npm run parity -- <case|tag|all>  # browser-vs-MCP harness in isolated Chromium; cases live in scripts/parity/cases
```

Each case reports pass, fail or blocked. A case id or a tag selects one or more
cases; an unknown selector prints the available case ids.

Parity runners exit `1` for a failed assertion and `2` when every executed
assertion passed but a required upstream capability is blocked. A blocked run
is never reported as release success.

A release is a commit on `main`: CI runs `npm run check` on it, and `npm run parity -- all` is run serially against that commit.

**`verify-fixes.ts` covers breadth.** Where conformance walks every tool once,
this walks the same fixes across shapes that behave differently: a plain CTO
node, a cloned multi-configuration workspace, a rack with PDUs and line cords,
current products in a second solution mode, an LFO model, and a GB300
tray in the MGX cabinet. It asserts on the exported CFXML itself — counting
`ConfigurationGroupLineNumberReference` blocks — rather than trusting the
server's own report of what it exported.

**`conformance.ts` checks transport coverage.** It inventories the current tool
registry dynamically (41 tools currently) and asserts that every registered
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

## License

MIT. See [LICENSE](LICENSE).
