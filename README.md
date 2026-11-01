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
| PCI and storage wizards | **Working for documented CTO cases** — inspect/select options, edit components and optional PCI slots, clear storage options, and switch RAID mode |
| Multiple identical units (quantity) | **Working** — extends price and the exported line |
| Duplicate a configured product N times | **Verified configuration copies, direct racked Clone Multiple and independent Copy** — source/member linked edits and fresh-browser handoffs pass; the supported nested D3/SD535 lifecycle and linked chassis PSU edits also pass |
| Export CFXML + Excel ZIP | **Working** — per configuration or per workspace |
| Import XML | **Working** — via DCSC's own `/multiple/cfxml_import` |
| Preconfigured (LFO) models | **Working** — launch, inspect, export |
| Multi-product solutions (server + switch + rack) | **Working** — one workspace, many configurations |
| Rack enclosures + U placement | **Working** — placement validated by DCSC |
| PDUs, line cords, power & heat reporting | **Working** |
| Power settings | **Working for supported products** — voltage, policy and load factor; missing native power remains explicitly unavailable |
| Native reference solutions | **Working** — browse, customize and download Lenovo's original XML |
| Manufacturing validation (`/lmc_validation`) | **Verified valid/invalid workflow** — on 2026-10-16, live rack/server cases returned authoritative terminal verdicts with canonical payload/revision binding. Responses stay bounded, with full saved diagnostics available through inspection. Unavailable and stale results never count as valid. |
| Cabling | **Verified automatic Management and manual Management/100GbE/DAC storage workflows** — creation, replacement, shared selections, recovery and website handoff for the documented cases. Four-way breakout survives MCP recovery; native website import loses its breakout shape. Broader topologies remain unverified. |
| Rack/floor export | **Verified one-/two-rack and captured PDU/cord workflows** — XML linkage, workbook sheets, browser handoff and restart; broader physical matrix remains |
| Storage definitions and components | **Verified documented DAC cases; broader coverage partial** — definitions, placement, server assignment, controller/SAN editing, manual DAC connections and replacement, export/reimport and removal. Tested FC/optical cases lack usable native connections; tested catalogs expose no expansions. |
| Standalone software and product services | **Verified basic workflows** — software quantity and covered-product count, persistence reload, export and headless website import; imported service quantities are preserved; independent services use a separate basket |
| Guided/Expert and Auto-Correct | **Implemented** — Guided supports on/off; Expert forces Auto-Correct off |
| Cluster / HPC-LeSI solution modes | Cluster mode is not offered anonymously |
| Account saves and partner/bid pricing | **Not tested** — anonymous workflow coverage only |

The project has completed the **2026-10-31 Anonymous Parity Completion**:
- **108 Registered MCP Tools**: 108/108 tools verified with complete MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) and a tightened context diet footprint (< 28,000 description characters).
- **1,212 Unit Tests across 145 files**: 100% passing test suite across domain logic, serialization, and tool ergonomics.
- **209/209 Conformance Checks Passed**: `scripts/conformance.ts` asserts 108/108 registered tools invoked and successful, with all tool responses strictly under the 8,000-byte output budget (`maxBytes <= MAX_TOOL_BYTES`).
- **Complete Parity Phase Pipeline**:
  - **Phase 0 Inventory**: 381 paths mined from the live DCSC bundle (`app-2026-01-14-5be41ba.js`), classifying 107 MCP-covered routes, 75 auth-gated routes, 41 SPA routes, and 158 candidate gap paths.
  - **Phase 1 Live Verification**: Automated harness (`scripts/parity-phase1-tools.ts`) verified 25 tool/restart/export capabilities against live `dcsc.lenovo.com` (`artifacts/parity-phase1/2026-10-31/report.json`).
  - **Phase 2 Gap Packages**: Implemented and verified G1 (Power XLS), G5 (Supply status lead times), G7 (Error customize with auto-derive), G9 (Rule & table versions), G10 (Anonymous discovery helpers), and G11 (Share URL retrieval) (`artifacts/parity-phase2/2026-10-31/report.json`).
  - **Phase 3 HPC/AI E2E Acceptance**: Verified 3 comprehensive end-to-end scenarios against live DCSC (`artifacts/parity-phase3-hpc-e2e/2026-10-31/report.json`): Scenario 1 (Multi-rack HPC compute cluster), Scenario 2 (AI factory pod), and Scenario 3 (External CFXML import, validate, fix, re-export).
  - **Verified Release Checkpoint**: Source manifest integrity verified via `scripts/release-checkpoint.ts` (`artifacts/release-2026-10-31-parity-completion/checkpoint/manifest.json`).

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

## Tools (41 Registered Tools)

| Tool | Purpose |
|---|---|
| **Discover** | |
| `dcsc_settings_get` | Country, language, currency and the available solution modes. |
| `dcsc_settings_set` | Set the default country and language for later launches and searches. |
| `dcsc_search` | Find products, parts, preconfigured codes, SIDs and specialty catalog entries (`kind`: products, tree, parts, preconfigured, sids, specialty). |
| `dcsc_category` | Category pages, sub-category filters, services categories and the discovery routes of a category or product. |
| `dcsc_reference_solutions` | Browse the Deployment-Ready and TruScale reference solution catalog. |
| **Launch & import** | |
| `dcsc_launch` | Open a CTO, LFO, LFO-as-CTO, reference solution, software or services basket, or load Unconfigured options. |
| `dcsc_import` | Import a CFXML or Excel file, XML text or an online Configuration ID. |
| **Configure** | |
| `dcsc_configuration_get` | Read a configuration: tabs, options, selections, feature detail, rule changes, recommendations, rule versions. |
| `dcsc_configure` | Apply option changes, sales quantity, Guided/Expert mode and Auto-Correct. |
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
| `dcsc_floor_set` | Position a rack on the floor grid. |
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
| `dcsc_vlh_set` | Creates VLH items and exports them to a `.vlh` file. |
| `dcsc_virtual_container_get` | Compatible inner products and rule results of virtual containers. |
| **Power** | |
| `dcsc_power_get` | Engineering Power Report, and the voltage, load factor and policy choices of a configuration. |
| `dcsc_power_set` | Save voltage, load factor and power policy. |
| **Validate & export** | |
| `dcsc_validate` | Manufacturing validation, optionally with the mandatory software check. |
| `dcsc_export` | Reports ZIP, power report, configuration tree, reference XML or online Configuration ID, returned as file paths. |
| **Sessions & analysis** | |
| `dcsc_session_list` | Open sessions and workspaces, client health and restore diagnostics. |
| `dcsc_session_close` | Discard a configuration or workspace. |
| `dcsc_undo` | Undo or redo workspace edits, or revert the last configuration change. |
| `dcsc_compare` | Compare scenarios, size scale-out racks, diff two configurations, fetch service insights. |
| `dcsc_reconcile_workspace` | Propose, inspect and accept reconciliation of damaged or legacy workspaces. |
| `dcsc_recovery_export` | Export a recovery JSON snapshot or original archive bytes. |

### Workflow limits to keep in mind

**x-config rack migration initializes missing floor metadata.** When Lenovo
omits the floor grid, the MCP uses native hierarchy U-position codes and the
website's default client-side floor placement. Incomplete explicit metadata
still fails. Saved source cabling is not proven recovered merely because
Lenovo accepts the XML; inspect the import diagnostics.

**Grouped rack imports preserve physical instances.** Native compressed groups
expand by original identity and U-position. The GB300 NVL72 reference design
passes launch, restart, export and browser reimport with 29 racked devices,
a spare tray, selected parts and prices preserved. MGX rack filler selections
follow its catalog; numeric GB300 power remains unavailable upstream.

**Grouped chassis imports preserve child ownership.** A native D3 export with
two linked populated chassis now imports as two chassis with the correct node
in each. `dcsc_clone_configuration` with `placement: "same-rack"` also clones
populated chassis and their direct node children into separate linked groups.
The D3 case passes undo/redo, restart and browser export/reimport with prices
preserved. Simple product/machine-type capacity bounds are supported; deeper containers, VLH and complex placement rules remain unsupported.

**Reference solutions use Lenovo's current catalog.** Imported Unconfigured selections are retained
across hardware derivation and exported as separate commercial lines. Editing
those selections uses `dcsc_load_unconfigured` and `dcsc_set_unconfigured`;
one native quantity-edit/export comparison passes; broader linked/product coverage remains open. Original-template downloads use Lenovo’s validation/download flow; broader
reference-solution families still need verification.

**Excel support depends on the workbook.** Lenovo's website and API reject a
tested mixed rack/server workbook with an unsupported-multiple-products error.
Use its companion CFXML in that case. Populated cabling recovery through Excel
remains unverified.

**PCI risers use the native wizard where available.** Discover choices with
`dcsc_pci_wizard`, then call `dcsc_set_pci_wizard` with the current workspace
revision, option ID and optional row/slot choices. Ordinary riser feature edits
are rejected on these products because Lenovo can silently discard them.
SR650 V4 optional-slot addition is verified through crash recovery, undo/redo,
subsequent derivation and XML import on both MCP and website. Successful spare-slot
removal and the 500W alternative riser also match native API results. Live edits
through a linked copy update both configurations, and both retain the result
after MCP and website XML import. Other wizard option families remain additional
coverage targets.

**Storage wizard choices retain explicit intent.** Use `dcsc_storage_wizard` to
inspect option IDs, groups, feature codes and offered quantities, then
`dcsc_set_storage_wizard` to select an option or edit one of its components.
Pass `optionId: null` to clear the entire option after removing configured drives;
the MCP enforces the website's drive guard.
Adding a controller can temporarily create an invalid combination; the response
reports native storage errors and the accepted quantity. Remove the previous
controller separately when replacing it. SR860 V4 option/component edits are
verified across four linked servers, recovery, history, later derivation and
MCP/website XML import. SR850 V4 mixed SAS/SATA + AnyBay option/component edits
are also verified across four linked servers and the same recovery/XML handoff.
On storage-wizard CTOs, changing `RAID_CONFIG` mode through
`dcsc_configure` clears previous drives, backplanes and controllers, matching the
website. Submit the mode switch alone, then choose new storage parts. Same-mode
edits preserve storage intent. LFO mode switching is rejected until its fixed-part
restoration is verified; other product families remain additional coverage targets.

**Power settings have an XML round-trip limit.** Use `dcsc_power_controls` to
discover exact voltage IDs and policy values, then `dcsc_set_power_controls`
with its returned workspace revision. `loadFactor` is the slider percentage;
the reported power utilization is a calculated output. Saved MCP sessions keep
the selected load factor across restart and undo/redo. Lenovo's CFXML importer
can reset it: native and MCP SR630 V3 exports saved at 100% both reimported at
70%, while preserving 230 V and policy. Export warns for nondefault load
factors; inspect and reapply the desired setting after XML import.

**Cabling counts are not a completeness verdict.** Auto-connect reports how many
requested networks have no connections and links to per-network diagnostics.
A working Management network does not establish that an assigned storage network
has been cabled. Follow `pages.diagnostics`, or inspect
`dcsc_workspace_layout` with `path: ["cablingDiagnostics"]`. Check P2P settings,
assignments, compatible ports, placement and Lenovo messages before changing
hardware. Use `dcsc_cabling_connections` followed by
`dcsc_edit_cabling_connection` to modify existing native rows. To refresh choices for
one existing row, call `dcsc_cabling_connections` with `refreshConnectionId` and
`expectedRevision`; this queries Lenovo without changing the design.
Replacement recalculates choices when the requested part is absent from saved choices.
Manual planning
links are not included in native connection counts or Lenovo exports. For native manual
creation, choose free ports, call `dcsc_manual_cabling_options`, then pass an offered
part and the same workspace revision to `dcsc_create_cabling_connection`. If discovery
reports pinnable routes, use `pinExistingRoutes: true` to retain their exact ports
and cables by marking them MANUAL. Without pinning, native rerouting is rejected.
This preserves routes during creation; a later explicit Auto-Connect operation
still recalculates the complete graph.
Creation selects the new source connector and preserves the cable quantity in
both configuration and rack data during derivation. Management and 100 GbE copper
creation have passed browser export/reimport checks. A compatible uplink port
alone does not establish that a switch supports the requested host-network topology.
For cable replacement, optional `cableQuantities: { oldPart, newPart }` sets the
per-product quantities, including spares, across a shared template or linked group.
For example, `{ oldPart: 2, newPart: 2 }` retains a pair of each cable type when
changing one route on a controller that requires paired cables. Quantities must
cover every physical instance's remaining routes. Native cable-rule errors abort
the edit without committing the graph, quantities, history or revision.
Manual 10 GbE DAC creation also passes with two physical DE2000H controllers
sharing a template and using different cable parts. Import preserves explicitly
selected spare cable quantities across layout recalculation; the mixed-cable case
passes restart recovery and website import with matching connections and prices.
Manual creation intersects distance choices with Lenovo's cable catalog for the
requested topology. Breakout and splitter cables require a different connection
model and are excluded from this point-to-point operation.

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
both paths pass commercial export and fresh-browser reimport. Linked HPC node
edits from a cloned D3/SD535 member also update both nodes and survive native
export/reimport; when an edit updates parent chassis too, use workspace history
to restore the dependent changes together. Configuration undo
restores the group only while every member still shares that edit boundary; use
workspace history after intervening edits. Divergent linked configurations are
rejected during export. `dcsc_copy_rack_item` implements the website's distinct
Copy operation for a supported direct General Purpose CTO item or populated
HPC chassis with direct node children. It creates independent parent and child
configurations with their own commercial lines; export, fresh-browser reimport,
workspace undo/redo and immediate process-kill recovery pass for the captured
D3/SD535 case. A copied-node processor edit leaves the original unchanged and
survives restart and native browser reimport. Copy from a linked chassis root or member preserves the original groups and creates independent
parent/child copies; copied-node edits, history, restart and native reimport pass.
Deeper/VLH
containers remain unsupported.

Workspace exports preserve imported Message History records and include current
diagnostics. Supported HPC edits append native-style action records in the same
durable commit as the edit. Workspace undo/redo restores those records exactly.
Configuration-only `dcsc_undo` restores configuration state without rewinding
the workspace action history; use `dcsc_workspace_history` for that scope.

Workspace summaries and layouts include executable `inspect`, `detail` and
`next` objects for large collections, raw connection fields and warnings. Pass
their arguments unchanged: `expectedRevision` prevents a design edit
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

Linked HPC D3 chassis edits update their dependent node shared data atomically.
Use workspace undo when a parent or child edit updates both groups. The native
PSU change is verified through restart and website reimport.

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
  reported. Same-component source-port swaps are also supported when connector
  names, assigned network and topology match. The MCP swaps both rows atomically;
  the tested native editor instead duplicates the source endpoint. Correct swaps
  pass Lenovo API retention, restart, history, MCP and fresh website import. Distributed leaf preference Close now matches Lenovo's switch
  calculation, launch, layout and derive sequence. Its exact three-row graph,
  crash restart, export and fresh-browser handoff pass. Managed-storage
  physical-alias cable-part edits pass the documented shared-storage replacement
  and imported-linked lifecycle checks. The
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
factory — handle-scope resolution, rack density banding, and the option-list truncation that hid every line
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
npm run parity -- network-switch  # populated Management graph against the browser oracle and a fresh website import
npm run parity -- network-leaf    # Distributed main/leaf graph, restart, export and website import
npm run parity -- storage-lifecycle # managed controller and SAN switch lifecycle, restart, export and website re-import
npm run parity -- storage-placement # managed storage physical placement, derive, export and website re-import
npm run parity -- storage-fc      # website Direct Attached FC Auto-Connect against the MCP
npm run parity -- manual-cabling  # every manual cabling mode (create, replace, breakout, storage, shared, collision)
npm run parity -- manual-source-swap # atomic source-port swap, history, restart and website import
npm run parity -- rack-power      # website two-rack PDU/cord flow against the MCP, history, restart and re-import
npm run parity -- rack-power-multi # second power code and non-unit PDU/cord quantities
npm run parity:rack-clone -- --action=clone --fresh # headless physical-clone browser oracle
npm run parity:nested-vlh       # native supported chassis/node workflow and export handoff
npm run parity:nested-stdio     # real MCP nested edit/history/crash/import/export lifecycle
npm run parity:nested-remove-chassis -- --out=/path/to/report # native populated-chassis Delete wire oracle
npm run parity:nested-detach -- --out=/path/to/report         # native Delete Node wire/export oracle
npm run parity:nested-unplace -- --out=/path/to/report        # native Move To Non Rack wire/export oracle
npm run parity:controls-locale   # headless DE/EUR conflicting-control differential
npm run parity:catalogs          # exhaustive bounded catalog/fabric/software continuations
npm run parity:validation        # strict authoritative verdict, payload/hash and stale-job gate
npm run parity:services          # base service + add-on selection, removal, export and reimport
npm run parity:storage-wizard    # linked storage options/components, recovery, intent and native XML handoff
npm run parity:storage-wizard -- --clear # whole-option clearing, drive guard and native XML handoff
npm run parity:storage-wizard -- --raid # RAID-mode clearing, linked recovery and native XML handoff
npm run parity:storage-wizard -- --raid-reverse # return to non-configured RAID and verify the empty choice
npm run parity:storage-wizard -- --sr850 # mixed SAS/SATA + AnyBay layout on linked SR850 V4 servers
npm run parity:pci-wizard        # native PCI slots, crash/history, derive, XML and browser handoff
npm run parity:power-controls    # native power controls, crash/history, derive, XML and browser handoff
npm run parity:chassis-clone     # native populated-chassis clone, undo/redo and browser handoff
npm run parity:chassis-copy      # independent populated-chassis Copy and browser handoff
npm run parity:chassis-linked-copy # preserve linked sources while creating an independent copy
npm run parity:chassis-member-copy # Copy from a linked member; preserve original parent/child groups
npm run parity:nested-grouped-import # populated chassis/node groups, restart and native reimport
npm run parity:grouped-rack-import # native grouped rack launch, healthy restart and export/browser handoff
npm run parity:xconfig-import    # native x-config import/layout, restart and export handoff
npm run parity:workbook-import   # Excel import over stdio, crash/restart, export and native browser controls
npm run parity:unconfigured      # Unconfigured quantity edit, restart and browser XML handoff
npm run parity:reference-download # original-template bytes versus native Export, import and restart
npm run parity:reference-solutions # native template catalog/customize, crash/restart and browser handoff
npm run parity:switch-clone      # HPC switch capacity, linked ownership, history, crash and browser import
npm run parity:switch-edit       # linked HPC switch cable edit and native handoff
```

Parity runners exit `1` for a failed assertion and `2` when every executed
assertion passed but a required upstream capability is blocked. A blocked run
is never reported as release success.

`npm run release:checkpoint` records the current **55-command** local/live/headless
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
registry dynamically (85 tools currently) and asserts that every registered
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
