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

The latest frozen release run completed **90 commands: 85 passed, 4 declared
upstream capability blocks, and 1 native browser-menu failure**. The failed
nested-placement check passed on an unchanged targeted rerun, including export
and fresh website import; the original failure remains in the report. Source
integrity passed before and after the full run. The four blocked checks cover
GB300 power/dependent cooling, the tested FC graph, and both breakout website
import checks. This is qualified verification, not a completely green first run.

The tested snapshot includes the PCI/storage wizards and source-port swaps.
Working-tree runtime files match it; a subsequent populated-RAID regression and
its fixture passed separately. See the
[current action inventory and gaps](.docs/roadmaps/2026_10_15_dcsc_parity.md#audited-user-action-inventory-and-next-work-rule-2026-10-30)
for implemented workflows and remaining limits. Neither tool counts nor passing
checks establish complete website parity.

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
| `dcsc_reference_solutions` | Browse Lenovo's native Deployment-Ready/TruScale categories, CRNs, details, popular designs and download-validation results, with lossless paginated metadata. |
| `dcsc_launch_reference_solution` | Load a native CRN/SID into a new editable workspace through Lenovo's Customize API. Preserves reference identity and exposes import diagnostics. |
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
| `dcsc_clone_configuration` | N configuration copies; optional `placement: "same-rack"` runs captured Clone Multiple staging/derive for direct CTO items with supported product/machine-type capacity bounds. HPC switch cloning is verified through undo/redo, crash/restart, export and fresh-browser reimport; linked HPC switch cable edits are also verified through cabling refresh, crash/restart and native import. Independent Copy uses `dcsc_copy_rack_item`. |
| `dcsc_set_node_role` / `dcsc_set_topology` | Tag Compute/Storage/Management; select a fabric. For topology selection, explicitly pass `ports: []` or `connectorIds: []` to deselect all ports on that network; omitted selectors retain automatic selection of a sole compatible connector. |
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
| `dcsc_cabling_connections` / `dcsc_edit_cabling_connection` | Inspect native connection rows and compatible choices; edit existing endpoints or cable parts. Supported four-way breakout cable replacement updates all branches sharing the physical destination port and reports additional `updatedConnections`; it preserves other cables and spares. Replacement is verified through MCP creation, restart, export, MCP reimport, a second restart and re-export. Direct website import remains blocked by Lenovo’s breakout-shape import defect. These tools do not create/delete native rows. |
| `dcsc_manual_cabling_options` / `dcsc_create_cabling_connection` | Discover compatible cables and create a native manual connection with coupled BOM updates. Creation from a free graph verified through MCP, persisted reload, export and website import. Use explicit `pinExistingRoutes: true` to convert existing AUTO network rows to MANUAL and preserve their routes; the affected count is reported. The maintained gate verifies stdio MCP creation, immediate process-kill recovery and fresh website import. Requires compatible placed ports. Use `connectionType: "breakout-4"` for one branch of a 100G QSFP28-to-four-25G SFP28 DAC breakout; up to four matching branches may share a destination port. Cable quantities count physical destination ports, including partially used cables. Native service creation is confirmed. MCP reimport restores the demonstrated saved breakout shape from CFXML after exact identity matching and checks native retention. Direct website reimport currently rewrites breakout shape to P2P/divider 1; website handoff remains unresolved. Broader breakout shapes remain unverified. Connection inspection exposes `category` and `divider`. Linked source selections update the whole group; native Auto-Connect may add sibling routes, included in cable quantities and reported by `additionalConnectionCount`. Linked-source 100GbE copper creation is verified through restart and website reimport. Management creation on linked SN2201 destinations is also verified: cable quantities are shared per member and cover the busiest member, preserving spares. Inspect `destinationConfigurationIds` before creating. Managed source aliases resolve their topology selections through the owning template while retaining physical endpoint identity. DB710S Management creation to a direct SN2201 destination is verified through MCP crash/restart, reimport, re-export and fresh website import. Managed DE2000H destination creation on an imported storage design is verified through MCP source-port selection, creation, two crash recoveries, export/reimport and fresh website import. A second gate starts with eight optical modules and no DACs, explicitly replaces them with two A3RG DACs using dcsc_configure, and passes the same lifecycle. Cable creation does not automatically remove optics. Native import collapses the template to a physical singleton; fresh managed-template creation, hardware configuration, placement and cabling also pass the full lifecycle in an existing server/rack workspace. A two-instance DE2000H case also passes creation, crash recovery, re-export and website import, preserving two selected DACs per instance. Demand growth beyond those spares remains unverified. |
| `dcsc_workspace_layout` | Read validated elevation, cabling and floor with lossless detail pages. |
| `dcsc_edit_layout` / `dcsc_workspace_history` | Move/unplace/detach/remove/arrange and workspace undo/redo. `detach` mirrors native Delete Node and warns about Lenovo's reimport loss; use `unplace` for a roundtrip-safe loose node. |
| `dcsc_copy_rack_item` | Independent same-rack Copy for a supported General Purpose CTO item or populated HPC chassis with direct node children; separate configurations and commercial lines. |
| `dcsc_set_rack_lock` | Lock/unlock a direct physical item or reserve an empty U; one-based input positions. |
| `dcsc_network_connectors` / `dcsc_set_network_preferences` | Stable compatible connector IDs and workspace device/cable choices. In AI/HPC workspaces, a changed automatic-switch preference provisions Lenovo's required main/leaf switches on Close; `autoConnect: true` additionally regenerates the graph. |
| **Analysis** | |
| `dcsc_power` | DCSC's own power and heat, aggregated and per rack. |
| `dcsc_power_controls` / `dcsc_set_power_controls` | Discover native voltage/policy choices and save recalculated power settings, including load factor. Changes use a workspace revision and update linked configurations atomically; unknown power stays unavailable. |
| `dcsc_pci_wizard` / `dcsc_set_pci_wizard` | Discover native PCI options and adapter assignments, select an option, or validate optional riser slots. Uses workspace revisions and atomic history; Lenovo may add supporting slots during derivation. |
| `dcsc_storage_wizard` / `dcsc_set_storage_wizard` | Discover storage options, controllers and backplanes; select an option or edit a component while preserving explicit wizard intent across linked configurations and export. Native combination diagnostics remain visible. |
| `dcsc_scale_out` | Size N nodes into racks. Warns on air-cooling density. |
| `dcsc_compare_scenarios` | Price/power/rack trade-offs across designs; incomplete prices or power reports expose known subtotals and prevent misleading rankings. |
| `dcsc_validate` | Return the authoritative manufacturing verdict, exact diagnostic counts and explicit `validatedScope`; large reports include executable inspection links. |
| `dcsc_validation_jobs` | Page through persisted validation status, staleness, messages, local diagnostics, headroom and raw reports without another upstream request. |
| `dcsc_explain` / `dcsc_diff_sessions` | Why an option is unavailable; diff two configurations. |
| **Output & ops** | |
| `dcsc_export` | CFXML + Excel ZIP. Scope follows the handle. |
| `dcsc_import` | Import CFXML or a local DCSC Excel workbook through Lenovo's own importer. Excel uses `filePath`; specify `solutionMode` for designs outside General Purpose. Legacy companion-workbook recovery remains unsupported and is reported when Lenovo requests it. |
| `dcsc_reconcile_workspace` | Propose, inspect and explicitly accept current reconciliation of legacy state. |
| `dcsc_recovery_inspect` | Page through restore warnings, quarantined records and preserved original-file archives, even when no workspace loaded. |
| `dcsc_recovery_export` | Export one workspace as a bounded JSON snapshot, or export an archive ID as its exact original bytes, including corrupt input. |
| `dcsc_session_info` / `dcsc_session_list` / `dcsc_session_close` | Session management. |
| `dcsc_download_reference_solution` | Validate download eligibility and save Lenovo’s original reference-template XML, preserving its bytes and returning a checksum. Open it with `dcsc_import`. |
| `dcsc_load_unconfigured` / `dcsc_set_unconfigured` | Load native Unconfigured choices, then edit client-held selections transactionally. Inspect choices with `dcsc_list_options`; use workspace history to undo. Native quantity edit and export parity verified on one reference design; broader product coverage remains open. |
| `dcsc_health` | Circuit breaker state, WAF cooldown, effective config. |

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

**Reference solutions use Lenovo's current catalog.** They are separate from
the curated local blueprints. Imported Unconfigured selections are retained
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
`expectedWorkspaceRevision`; this queries Lenovo without changing the design.
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
npm run parity:storage-wizard    # linked storage options/components, recovery, intent and native XML handoff
npm run parity:storage-wizard -- --clear # whole-option clearing, drive guard and native XML handoff
npm run parity:storage-wizard -- --raid # RAID-mode clearing, linked recovery and native XML handoff
npm run parity:storage-wizard -- --raid-reverse # return to non-configured RAID and verify the empty choice
npm run parity:storage-wizard -- --sr850 # mixed SAS/SATA + AnyBay layout on linked SR850 V4 servers
npm run parity:manual-source-swap # atomic source-port swap, history, restart and website handoff
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
npm run parity:storage-placement # managed storage physical placement, derive and export
npm run parity:storage-placement-reimport -- --mcp-report /path/to/storage-placement/report.json --out /path/to/reimport-report
npm run parity:storage-fc -- --out /path/to/report # post-import Direct Attached FC control; currently exits 2 on HTTP 200/zero storage rows
npm run parity:manual-create     # create on a populated graph, pin routes, SIGKILL/restart and browser import
npm run parity:manual-replace:breakout # replace a shared physical cable, then verify MCP recovery and website handoff
npm run parity:manual-create:breakout # two manual branches share a QSFP28 port; verify quantities, restart and browser import
npm run parity:manual-create:100g # add a second 100 GbE DAC connection and verify quantity, restart and browser import
npm run parity:manual-create:managed-source # managed DB710S source, crash/reimport and browser handoff
npm run parity:manual-create:managed-destination # imported DE2000H destination, public ports/create and browser handoff
npm run parity:manual-create:storage-prepare # explicit optical-to-DAC hardware preparation before creation
npm run parity:manual-create:fresh-storage # fresh managed template, hardware setup, placement, cabling and browser import
npm run parity:manual-create:shared-storage # two managed physical instances, separate routes and spare preservation
npm run parity:manual-create:linked-source # shared source ports, sibling route/BOM, restart and browser import
npm run parity:switch-clone      # HPC switch capacity, linked ownership, history, crash and browser import
npm run parity:switch-edit       # linked HPC switch cable edit and native handoff
npm run parity:manual-create:linked-destination # create on both linked switches; verify per-member quantities
npm run parity:manual-cabling    # existing-row cable derive, SIGKILL recovery and export
npm run parity:manual-cabling:shared    # preserve a shared cable quantity while splitting one row
npm run parity:manual-cabling:collision # atomically swap an occupied destination port and restart
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
