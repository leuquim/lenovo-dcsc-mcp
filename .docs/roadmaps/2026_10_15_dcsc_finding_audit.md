# Current finding audit: 23 original findings plus dependency remediation

**Update (2026-10-31):** **COMPLETED.** The full anonymous DCSC parity scope has been achieved and verified across all four phases of the [2026-10-31 Anonymous Parity Completion Roadmap](2026_10_31_anonymous_parity_completion.md). All 108 registered tools are verified with full MCP annotations, context diet (< 28,000 description characters), and 209/209 conformance checks passing with exit code 0. For current handoff and repository delivery, see [current context](../context.md). Raw `artifacts/` references below are local evidence locators; maintained fixtures are included in Git.


## Current answer: MCP gaps versus native limitations

The MCP does **not** yet establish complete website parity. Its 85 tools and passing
unit tests are not a coverage percentage. The latest frozen build completed all
90 commands: 85 passed, 4 declared upstream blocks and 1 native Add Node menu
failure. An unchanged targeted rerun passed placement/export/fresh import; the
original matrix failure remains recorded. Source integrity passed before/after.
Authoritative results: `artifacts/release-2026-10-30-wizards-source-swap/results/report.json`
and `nested-vlh-recheck/resolution.json` in that release folder.
[PR #2](https://github.com/leuquim/lenovo-dcsc-mcp/pull/2) is ready for review;
Node 22 and 24 CI passed at `f808aaf`. The table below separates implemented
improvements from upstream observations and missing evidence.

| Website capability or reported gap | Current classification | Evidence / remaining action |
|---|---|---|
| Manual cable creation and replacement | MCP integration gap addressed for documented Management,100GbE and DAC storage cases | Combined shared-storage public gate passes24 calls, replacement before/after import, retained spares, restart, re-export and website graph/price comparison. Frozen rerun also passed24 calls: `artifacts/parity-manual-cabling/2026-10-30T18-23-48-053Z/report.json` in the frozen checkout. |
| Managed/linked storage cable ownership | MCP integration gap addressed | Template/physical aliases resolve to native editing groups; explicit paired quantities and rollback are verified. Additional hardware combinations remain unverified. |
| PCI and storage wizard editing | APIs support these; MCP integrations added | Option/component selection, whole storage-option clearing and CTO RAID switching have native and MCP evidence. LFO mode restoration remains unverified without an enabled native case; see the roadmap. |
| Native power controls, reference solutions and modern Excel import | APIs support these; MCP integrations added | Their current frozen release gates passed, including native byte comparison for one reference-template download. Coverage remains bounded to documented cases. |
| Four-way breakout website import | Observed native import limitation | Native CFXML import changes BREAKOUT4 to P2P/divider1. MCP recovery retains the demonstrated shape; broader breakout shapes remain unverified. |
| Power load-factor XML round trip | Observed native import limitation | Native and MCP SR630 V3 exports at100% reimport at70%; voltage/policy survive. MCP saved sessions retain the setting; export warns and the setting can be reapplied. |
| GB300 power / dependent DWC advisory | Native values unavailable in tested context | Current frozen verify-fixes returned18 passes,0failures,2blocked checks; null power cannot support the dependent numeric advisory. |
| Detached node XML reimport | Observed native retention limitation | Native Delete Node export includes the detached commercial node but reimport loses it. Unplace is the documented retention alternative. |
| FC/optical storage and expansions | Catalog/graph limitations observed for tested combinations only | Current frozen native FC gate confirms HTTP200, one Management cable, zero storage cables and no errors with assigned storage/P2P enabled (`artifacts/release/storage-fc/report.json` in the frozen checkout). No general API-unsupported claim; broader supported hardware input is still needed. |
| Legacy companion-workbook cabling recovery | API exists; usable real input not verified; MCP gap remains | Frontend uses /excel_import then /connection_recovery. Modern workbooks are not valid controls. Native sample template has only Part number/Qty, no connection data. |
| Memory wizard | API exists; supported website case not established | Tested product availability=false and anonymous US purley category discovery=[]; launch catalogs alone do not establish a usable workflow. |
| Account saves and partner/bid prices | Authentication-dependent, unverified | Anonymous evidence cannot establish either support or absence. Needs applicable account access and a verified native flow. |
| Linked nested-node Delete Node | Native frontend failure for tested root and member; API support unverified | Both clicks fail before any post-click API call and leave state unchanged. Member evidence: `artifacts/linked-node-member-detach-audit-2026-10-30/report.json`. Keep the MCP guard pending a successful native contract for another shape. |
| Combined independent-service and hardware export | Unverified native contract | Separate exports work; MCP rejects the unverified combination explicitly. Do not infer universal API absence. |
| Other topology, reference and nested/container shapes | Coverage gaps | Existing cases are bounded evidence; do not generalize to every website-supported design. |

Detailed native captures and regression paths follow below. Older entries describe
historical states; current context and source-bound results take precedence.

## Shared managed-storage replacement and imported-linked lifecycle verified (2026-10-30)

**Final current result:** combined public gate40223 PASS24 MCP calls, both fresh
and imported replacement, spares,crash recovery,re-export and website graph/price
parity. Full check16118 PASS970tests/17contracts/build/81tools. Release inventory
focused40303 PASS2tests. The frozen82-command matrix completed78pass/0fail/4declared blocks; see the consolidated
[current context](../context.md). Intermediate statuses below are historical.


Previous goal turn was progress: mixed import lifecycle and native UI replacement
captured. The current implementation removes the managed-alias replacement guard.
ManualConnectionEdit and dcsc_edit_cabling_connection accept optional cableQuantities
{oldPart,newPart}, per product including spares. Planning resolves linked/template
physical ownership and enforces maximum per-instance graph usage, including untouched
siblings. Default direct replacement semantics remain unchanged. Shared replacement
uses existing native configure plus seeded autoConnect and workspace derive, restoring
both requested cable quantities across the native per-route layout projection. It
checks exact graph cardinality/retention, every editable/physical destination's cable
quantities, and native cable-section errors before committing the transaction. No
new endpoints or registered tools. Native invalid cable rules also reject direct
replacement atomically. It does not round quantities from prose rule messages.

Live service92359 PASS on fresh shared managed template: one A1PH→A1PJ route,
other route retained, both quantities2, export/reimport with no cable errors.
Evidence artifacts/managed-replacement-service-2026-10-30/report.json and API captures.
Full check64394 terminal PASS: 967 tests/124 files,17 contracts,typecheck/lint/build,
81-tool startup (/tmp/dcsc-shared-replacement-full-check.log). Maintained public
gate36654 terminal PASS22 MCP calls, including public replacement, two restart
checks, reimport with paired quantities, recovered export and fresh browser graph/
commercial parity. Evidence artifacts/parity-manual-create/2026-10-30-replace-storage-run1.
Native invalid-pair rollback56374 terminal PASS: explicit1+1 returned native paired
rule errors; graph/configurations/history/revision and persisted snapshot unchanged.
Evidence artifacts/managed-replacement-negative-2026-10-30/report.json.

Additional imported-linked replacement81748 failed before HTTP because the existing
linked-configure guard excluded HPC storage. Extended the HPC linked path to storage
with no managed-template role or alias owner, matching CTO product/validation controls
and quantity1. Native retry20011 returned the linked root AND containing rack; now
allow that physically related rack, preserve strict identities/target coverage, and
require workspace undo for dependent rack edits. Node/storage root-only and switch/
storage rack-dependent regressions pass (focused71 tests19047, static65938/85230).

Imported retry85961 exposed unused spare A1PJ loss;12561 proved it vanished already
in targeted derive. Control30758 changed only explicit A1PJ forAutoConnect flags to
false and native derive retained quantity2 without errors. Shared replacement now
marks explicitly retained parts with no remaining route as manual spares in the raw
selections and physical rows before configure. Auto-connect may also remove a spare
record; the quantity restager can restore its exact pre-call physical record, never
inventing ownership. Regression covers last-route removal, retained quantity2,
forAutoConnect:false, immutable inputs and missing-record rejection (focused69
PASS77496; typecheck/lint28510/42364 before final ownership change).

Imported linked retry66974 terminal PASS after all fixes: replacement A1PJ→A1PH,
both codes qty2 on both physical products, no cable errors, export/reimport passes.
Evidence artifacts/imported-linked-replacement-2026-10-30/run5/report.json and native
captures. Earlier runs remain failed controls, not repeated blockers. Current full
check16118 running /tmp/dcsc-shared-replacement-final-check.log. Maintained gate40223
running /tmp/dcsc-shared-replacement-gate2.log, evidence
artifacts/parity-manual-create/2026-10-30-replace-storage-run2. This extended gate
performs public replacement both BEFORE and AFTER import, checks unused spare qty2,
then restart/re-export and website graph/commercial parity. Poll exact live handles.

New maintained command parity:manual-replace:shared-storage (inventory82, tools81).
Gate covers paired preparation, two fresh physical instances sharing one template,
public edit, crash recovery, export/import, recovered export and website comparison.
Await extended public lifecycle results; broader storage models/topologies remain
unverified. Goal remains active; no full parity claim.

## Manual import spare quantities preserved; mixed-storage lifecycle verified (2026-10-30)

A controlled two-instance storage case with A1PH and A1PJ manual routes exposed
quantity loss during MCP import. Native CFXML initially returned both cable codes
at quantity 2 on both physical products. racks/customize projected active-route
counts of 1; the following workspace autoDerive consumed those counts and produced
paired-cable validation errors. Restaging the explicitly imported quantities before
derive returned quantity 2 for both codes with no cable errors.

The import-only layout path now snapshots explicit manual P2P cable selections and
restages them after layout customization, before configuration derive. It normalizes
missing CFXML category with divider=1 only in the planning copy. It does not invent
absent selections, infer pair rounding, or change the accepted connection graph.
Reduced native evidence is tracked in test/fixtures/parity/manual-import-cable-spares.json.
Focused native-manual/import tests: 33 passed. Service live import → export → reimport:
PASS, two routes and both cable quantities 2; evidence
artifacts/managed-replacement-seed-2026-10-30/fixed-import2/report.json.

The first full check caught nullable result.quantity in the new helper; corrected
with a zero default. Full check81295 terminal PASS: 966 tests/124 files, 17 contracts,
typecheck, lint, build and 81-tool startup; log /tmp/dcsc-import-spares-full-check2.log.
Maintained mixed-storage gate42209 terminal PASS, 21 public MCP calls: two distinct
cable codes across two physical instances of one fresh template, two SIGKILL/restart
checks, import quantities and zero cable errors, immutable fresh cable discovery,
recovered re-export and fresh website import with exact graph/commercial parity.
Evidence artifacts/parity-manual-create/2026-10-30-mixed-storage-run1/report.json,
mcp-recovery-report.json, native-import.json, native-layouts.json and numbered calls.
Inventory is now 81 maintained commands and 81 tools (distinct counts).

Native replacement investigation44800 terminal captured, configurationValid:false.
Evidence artifacts/storage-replacement-native-refresh-2026-10-30/replacement-report.json,
4-derive.json, native-refresh.json, after.txt. The website's own distance-refresh
action populated actual imported rows with 12/13 choices and DAC_SFP_CABLE metadata;
then its existing-row editor changed one A1PH to A1PJ and issued targeted derive.
No graph injection. This is a programmatic native-action refresh, not evidence of
an ordinary UI refresh workflow. Saved frontend shows port changes/Save alone do
not request fresh distances. The actual replacement request targeted the first
physical root and customizingIds BOTH imported linked physical members. It selected
A1PJ quantity1, removed A1PH from reduced selections; native derive returned A1PH1
and A1PJ1 with paired-cable rule errors for both (valid quantities2/4/6/8). Thus the
API DOES support replacement, but this native UI flow does not keep the paired BOM
valid. Do not label it an upstream unsupported operation or a successful valid
configuration. This imported physical-root control does not yet capture fresh
managed-template replacement. Next: implement/verify atomic shared-template
replacement with explicit valid cable quantities and native validation feedback.
No live jobs remain.

Managed-storage cable replacement remains guarded: subtract-one/add-one violates
native paired quantities in the observed controller. The explicit valid-quantity
route-seeding control is not public replacement acceptance. Full website parity,
unverified topologies and final immutable release matrix remain open. Goal active.

## Fresh existing-row cable discovery implemented and live-verified (2026-10-30)

Added optional refreshConnectionId to dcsc_cabling_connections; requires
expectedWorkspaceRevision and preserves the refresh target in paging continuations.
Service clones current physical/floor/graph input, queries calculateDistance,
intersects choices with catalog topology/connection shape, validates response
endpoints/topology/distance, rechecks current workspace revision/existence, and
returns a projected report WITHOUT changing the graph/history/revision/persistence.
No new registered tool (still81). README documents usage.

Existing-row replacement now fetches fresh choices when the requested cable is
absent from saved compatibleCables, including native import omissions. It stages
only the refreshed row inside the existing transaction and then runs the coupled
replacement derive. Wrong distance endpoints fail without commit. Managed alias
replacement guard remains; paired/shared quantity semantics still require work.

Focused service/tool tests31 PASS57744, typecheck/lint PASS. Tests cover immutable
discovery, required/CAS revision, wrong response endpoint on discovery/edit, coupled
replacement after absent metadata, and executable refresh paging continuation.
Full check42671 terminalPASS964tests/124files,17contracts,build,81toolsmoke. This run
started before final absent-requested-part condition refinement; focused31/static
checks cover that refinement. Latest shared-runner assertion was added afterward.

Public stdio live69068 terminalPASS2calls: import recovered shared XML, fresh
choices include A1PJ, persisted session file unchanged byte-for-byte. Evidence
artifacts/imported-cable-choices-2026-10-30/run2/report.json and numbered calls.
Important qualification: this MCP import already had12 cached choices after layout
processing. Initial native CFXML/browser response omits choices, but MCP layout
processing can recover them. First probe61424 failed its too-strong empty-cache
assumption; no production failure. Missing-cache behavior is regression-tested;
live run proves fresh native discovery/read-only semantics, not a universally
broken imported MCP workflow. Preserve this correction in future reports.

Maintained shared-storage gate now refreshes one recovered connection and asserts
A1PJ plus snapshot immutability before re-export/browser check. It has not been
rerun yet with this added assertion; standalone stdio probe verifies the operation.
No live jobs. Next: managed alias replacement with correct shared/pair/spare quantity
semantics, native derive validation and public lifecycle. Full website parity and
final immutable80-command matrix remain open. Goal active.

## Paired replacement quantities validated; imported choices gap confirmed (2026-10-30)

Paired control46808 terminalPASS: explicit service configure A1PHqty2+A1PJqty2
retained those selections with ZERO cable-section errors on the template and both
physical instances. Evidence artifacts/managed-replacement-paired-audit-2026-10-30/
report.json and native derive/customize captures. This is valid shared hardware
preparation, not yet a managed manual replacement or its export acceptance.
Earlier qty1+qty1 control remains captured/configurationValid:false.

Browser capture64848 terminalFAILED to select A1PJ because imported connection's
cable dropdown was empty (Not Found). Native CFXML autoConnectResults contain no
cableDistance/compatibleCables for either row. Actual existing-row editor opened
and showed both routes. Evidence artifacts/storage-replacement-browser-2026-10-30/
{native-import,panel,edit,choices} files. No native replacement action completed.
Port refresh55050 and component refresh49922 both terminalFAILED waiting for
calculateDistance; same-component port change did not emit the awaited request,
and changing target component likewise did not emit it in the probed timing. These
are UI-probe failures, NOT proof that website or API replacement is unsupported.
No live jobs remain.

Actionable MCP gap: inspectManualCabling currently projects only saved rows;
manualCabling.cableChoices reads cableDistance.compatibleCables and otherwise shows
only the existing part. Imported native rows therefore cannot discover replacement
parts even though calculateDistance supports them (creation already uses that API).
Next implement revision-guarded read-only fresh choices for one existing connection,
likely optional refreshConnectionId on existing dcsc_cabling_connections (no new
registered tool needed), plus replacement revalidation against fresh distance when
import omitted choices. Preserve physical endpoint identity and validate returned
from/to/topology. Keep imported graph immutable during discovery. Tests should cover
missing choices, wrong distance endpoints, revision changes, and atomic edit failure.
Managed replacement guard remains until actual alias derive/shared quantity behavior
is integrated and verified; public dcsc_configure can explicitly prepare valid pairs.
Goal active. Last full958 tests precedes one additional passing regression (focused32).

## Recovered shared export passes website; paired replacement rule captured (2026-10-30)

Standalone headless browser16173 terminalPASS reimported the RECOVERED re-export
from shared-storage-run2/019-dcsc_export.json, not the original creation export.
Graph retained2 exact routes and physical commercial comparison passed. Evidence
artifacts/shared-storage-recovered-browser-2026-10-30/{report,native-import,layouts}.json.
Maintained shared-storage gate now chooses recoveredExport.xml/recoveredWorkspace
for its browser check and reports browserExportXml. Typecheck/lint14297 PASS.
This closes the recovered-export browser coverage gap with direct live evidence;
the updated full maintained gate has not been rerun solely for this routing change.

Managed replacement native control49171 terminal completed; report status was
normalized to CAPTURED/configurationValid:false because HTTP/transaction success
was not a valid configuration. Explicit public service configure A1PHqty1+A1PJqty1
on the fresh shared template retained those quantities but returned native
7Y70_71_CTO2_DAC_CABLES_PAIRS_A.1 errors on template and BOTH physical instances.
Each cable type requires even quantities2/4/6/8. Evidence
artifacts/managed-replacement-audit-2026-10-30/{report,1-cto_autoDerive,3-racks_customize}.json.
This is a configuration quantity control, not a captured website manual replacement
operation. Do not remove managed cable-replacement guard or infer native rounding.
Native accepts invalid quantities with validation messages; no silent validity claim.

LIVE46808 paired follow-up: same copied source workspace, explicit A1PHqty2+A1PJqty2,
asserts zero template section errors. Log /tmp/dcsc-managed-replacement-paired.log;
artifacts/managed-replacement-paired-audit-2026-10-30/quantity-probe.ts and report.json
when complete. Poll SAME handle; restore of78MiB session snapshot can take~1minute
of CPU before any HTTP logs. Do not restart on quiet output. No other live jobs.
Next inspect paired result and per-instance quantities/errors, then capture/implement
replacement with correct shared-template/spare semantics and public acceptance.
Goal active; full website parity and final80-command immutable release remain open.

## Shared managed cabling and re-export gate passes (2026-10-30)

Live15746 terminalPASS19calls, two manual routes, both SIGKILL recoveries, MCP
import/re-export and fresh website import with graph/commercial parity. Evidence:
artifacts/parity-manual-create/2026-10-30-shared-storage-run2/report.json and
mcp-recovery-report.json. Both physical controllers retain A1PHqty2 and no section
errors after reimport. Scope: two instances sharing one template with one route
each, preserving selected spare quantity2. Demand growth beyond spares unverified.
Browser gate imports the first export; recovered re-export is backend-verified but
has not yet had a separate browser roundtrip. Keep this distinction explicit.

Root cause/fix: native cfxml_import returns separate quantity-one controller
configurations and a color owner rebased to the first physical ID. Fresh headless
SPA customize request explicitly links both under that root. MCP previously
classified all storage color groups as presentation-only and lost this dependency.
expandImportedClones now promotes only rooted explicit native color ownership
whose members are materialized active physical configurations, with no actual
managed-template dependency still owning them. Rootless missing-template colors
remain presentation-only. Conflicting explicit ownership fails closed; matching
product codes alone never establish links. Export guard remains unchanged.
Captured minimal fixture storage-materialized-clone-import.json; focused32tests
pass including preservation of explicit managed ownership with either template or
physical color root. Browser native control20258 PASS at
artifacts/shared-storage-import-audit-2026-10-30/{native-import,layouts,report}.json.

Full check44418 terminalPASS958tests/124files,17contracts,build,81tools before the
last extra physical-root/explicit-template regression; focused32tests6373 pass
with that refinement. README and tool metadata describe bounded shared support.
No live gate jobs remain. Next verify browser import of recovered export, demand
growth beyond paired spares, and managed alias cable-part replacement. Remaining
website workflows/final immutable80-command release matrix still outstanding.
Goal active. User requested status/percent; no defensible overall parity percentage
exists yet, as website/account/broader compatibility inventory is not fully measured.

## Shared storage re-export failure isolated (2026-10-30)

Both previously live jobs are now TERMINAL. Shared gate79478 FAILED during
manual-mcp-reimport's recovered export: `Clone dependency color
US__b37f4321-9498-4e45-b214-9a3689d73f6d0 conflicts with the active dependency group;
reconcile or reimport the workspace before exporting.` This occurred AFTER both
connections, first crash/export, MCP reimport, both recovered physical products'
qty2/no-section-errors checks and second crash passed. Evidence report.json and
numbered tool calls under artifacts/parity-manual-create/2026-10-30-shared-storage-run1.
This is a new import clone-color ownership/re-export defect, not proof of an upstream
cabling limitation. Next inspect persisted recovered workspace dependency/colors,
original exported CloneDependencyColor and import ownership reconciliation. Keep
re-export guard intact until ownership is correctly reconciled. Do not rerun whole
gate before a fix/evidence warrants it.

Full check7179 terminalPASS:955tests/124files,17contracts,build,81-tool smoke.
No live jobs remain. Shared gate stays failed; fresh single-instance gate remains
PASS16calls. Goal active.

## Fresh managed destination gate passes; shared instances running (2026-10-30)

Fresh gate74447 terminalPASS16calls:
artifacts/parity-manual-create/2026-10-30-fresh-storage-run3/report.json.
Includes public definition, fresh controller template, HIC/protocol/DAC setup,
physical placement with distinct alias, source assignment/ports, manual creation,
two SIGKILL recoveries and fresh browser import with graph/commercial parity.
Shared commercial comparator correction passes the live gate. README/tool guidance
now reflect fresh controller support within an existing imported server/rack design.

Added sharedStorage variant and `parity:manual-create:shared-storage` (release
inventory80). Uses A1PH1m DACqty2 for two controller instances sharing one fresh
template; second placement must reuse template, second source port connects to
second physical alias, graph retains first row, template spares stayqty2. Recovery
checks require both physical configurations, qty2 cables and zero section errors.

LIVE79478: shared run1 at artifacts/parity-manual-create/2026-10-30-shared-storage-run1,
log /tmp/dcsc-shared-storage-gate.log. Both creations and first crash/export passed;
last observed files include017-dcsc_import.json. Poll SAME handle; full acceptance
pending. LIVE7179: npm run check, /tmp/dcsc-shared-storage-full-check.log. Process
inspection confirms npm/check and vitest worker still running. Last logs are mocked
WAF cases (do not mistake them for a live backend block); no terminal suite result
observed. Poll same handle, never restart on observation timeout. Earlier static
checks18301 passed, before small shared-recovery assertions; full check includes them.
No other live jobs. Next finish these gates, then shared demand growth beyond spares
and managed cable-part replacement. Broader storage protocols and final immutable
release matrix remain outstanding. Goal active.

## Fresh managed setup reaches creation/recovery; commercial oracle corrected (2026-10-30)

New maintained variant `parity:manual-create:fresh-storage` (release inventory79)
imports an existing server/rack design, creates a NEW direct-attached DE2000H
storage definition, opens its fresh template, explicitly configures B4B7qty2 HICs,
B4DCqty1 iSCSI setting, no B4B2 optics and A3RGqty2, places a new physical instance,
assigns source network and selects ports before manual creation. Distinct template
and physical IDs are asserted. This is fresh controller setup within an imported
server/rack design, not a claim of entirely fresh workspace creation.

Run1/11288 failed correctly because fresh defaults lack HIC/protocol; comparing
against accepted native controller revealed NETWORK_ADAPTER B4B7qty2 and
NETWORK_ADAPTER_CFC B4DCqty1. Run2/64160 completed16 MCP calls, creation, two crash
recoveries, exports/reimport, but browser commercial comparator failed. Initially
suspected pricing defect was disproved: editable template price21264.01 differs
from placed product21833.01. Authoritative storagePhysicalConfigurations contains
21833.01, matching native workspace derive and reimport. Production exportGroups
and workspaceProjection already consume the physical values. Shared test helper
incorrectly compared editable-template raw price. Corrected groupedRackParity to
expand authoritative physical configurations. Added regression with two instances
and a negative control rejecting a one-unit wrong physical price. Test1/static90415
PASS. Tool descriptions now accurately expose managed-source/imported-storage
support and storage assignment/port preparation instead of claiming all managed
physical aliases unsupported; tools7tests12336 PASS.

Full check37225 PASS953tests/123files,17contracts,81tools/build, before the shared
comparator correction/new regression. Latest comparator static checks pass.
Run3/74447 is LIVE: poll SAME handle; do not restart on observation timeout.
Log /tmp/dcsc-fresh-storage-gate3.log, evidence directory
artifacts/parity-manual-create/2026-10-30-fresh-storage-run3. Browser acceptance for
fresh setup remains pending until this run passes. Run2 evidence remains in
2026-10-30-fresh-storage-run2 including mcp-recovery-report.json. No other live jobs.
Next finish fresh setup gate, then shared managed-instance quantity/creation and
managed destination replacement contracts. Complete final release matrix still
outstanding. Goal active.

## Storage hardware preparation through MCP passes (2026-10-30)

Added `parity:manual-create:storage-prepare` and native-exported optical starting
fixture. Gate starts with eight B4B2 optical modules and no A3RG cables, explicitly
calls dcsc_configure to remove optics and select the required two DACs, verifies
selected quantities and zero controller section errors, then selects source ports,
creates a manual connection, SIGKILL/restarts, exports/reimports, SIGKILL/restarts
again and performs fresh headless website import with commercial/graph parity.

Live50012 terminalPASS11calls. Evidence:
artifacts/parity-manual-create/2026-10-30-storage-prepare-run1/report.json,
mcp-recovery-report.json and numbered MCP calls. Native optical seed89692 passed
with optics8/cables0/errors[]; generation script and report under
artifacts/managed-destination-audit-2026-10-30/optical-seed.* and optical-seed-report.json.
This removes preconfigured-DAC dependency from the imported-controller acceptance
path. Optics removal remains an explicit requested hardware edit, not an automatic
side effect of manual cable creation. No optical-cable graph support is claimed.

Typecheck/lint58756 PASS; release-checkpoint tests76469 PASS2; diff check clean.
Release inventory now78 commands. Complete final immutable release matrix remains
outstanding. No live jobs. Fresh managed-template launch/place/prepare/create and
shared managed-instance quantities still need a combined public gate; imported
controller native identity still collapses to a physical singleton. Existing
controlled service evidence covers distinct template/physical identities separately.
Next combine storage definition/customize/place tools with the now-verified explicit
hardware prep; retain captured layout/geometry and native cable-length constraints.
Managed alias cable replacement remains guarded pending its own derive contract.
Goal active.

## Imported storage destination public MCP gate passes (2026-10-30)

Maintained `parity:manual-create:managed-destination` passed 10 MCP calls, two
SIGKILL/restart checks, XML export/reimport/re-export and fresh headless website
import. One manual 10GbE_Copper SFP28:1 to DE2000H SFP+:1 connection survives;
A3RG cable quantity two is retained and browser commercial parity passes.
Evidence: artifacts/parity-manual-create/2026-10-30-managed-destination-run1/report.json
and mcp-recovery-report.json. Live handle65264 terminal exit0. Independent stored
state inspection found no controller section errors before/after MCP reimport.

Fixture xml/manual-cabling-managed-destination.xml is a native API export of the
accepted fixed-layout control, empty graph and empty source selectedTopologies.
MCP dcsc_set_topology selects the assigned storage-network port, then discovery
and creation run through stdio. Controller DAC hardware is preconfigured. Native
import collapses template to physical singleton; this does NOT prove fresh
managed-template public setup, multi-instance shared quantities, or cable hardware
preparation from default optics. Earlier controlled service probe covers distinct
physical/template identity separately. Keep these acceptance boundaries explicit.

Added maintained command to package and release inventory (77 commands). Static
checks18659 passed, release-checkpoint tests18451 passed2, git diff --check clean.
Last full953-unit/17-contract/81-tool check predates this maintained-gate addition;
complete immutable current live release matrix still outstanding. No live jobs.
Next: public controller hardware preparation/fresh managed placement, shared
managed-instance quantity verification and managed cable replacement. Goal active.

## Storage source port selection verified through service (2026-10-30)

`dcsc_set_topology` now accepts the exact name of an existing storage network
already assigned to the configuration. Duplicate names, fabric-name collisions,
unassigned networks and incompatible ports fail validation. Existing selections
are preserved. Focused network-preferences suite: 16 passed; typecheck/lint passed.
Full check completed: 953 tests in 123 files, 17 contracts, build and 81-tool startup
passed. This is not the complete live release matrix.

Live service-topology-create probe 50327 passed: source topology started empty,
applyTopology selected the storage-network port through the public service path,
manual discovery/creation succeeded, and export/import retained one connection,
A3RG quantity two and no controller section errors. Evidence:
artifacts/managed-destination-audit-2026-10-30/service-topology-create-report.json.
Controller cable configuration and placement still come from native captures;
this does not establish end-to-end public setup, stdio crash recovery or browser
acceptance for managed destinations. Next: maintain that complete gate and verify
shared physical instances. No jobs remain running from this turn. Goal active.

## Managed-destination service creation/handoff passes (2026-10-30)

Placement regression10832 terminalPASS13calls, report parity-manual-create/
2026-10-30-preserve-placement/report.json. No-arrange manual behavior retains managed
source creation/recovery/browser/clear lifecycle.

Service discovery now resolves destination physical alias to template configuration.
#autoConnectDraft matches accepted manual selections against plan.physicalDestinationIds
instead of templateId. Planner from prior turn stages physical cable quantities.
Focused40tests/typecheck/lint69467 PASS.

Live controlled service-create99534 terminalPASS: preconfigured native controller
A3RGqty2/noB4B2, assigned source10GbE_Copper topology, free graph; public service
inspectNativeManualCabling offersA3RG, createNativeManualCabling commits alias endpoint,
workspaceAutoDerive retains route, export/import keeps1connection/qty2/controller
sectionerrors[]. Evidence managed-destination-audit-2026-10-30/service-create-
report/options/result/export.json and service-create-sessions.json. Setup is controlled
from native captures, not yet public MCP setup or crash/browser gate. Preserve bounds.

Current fullcheck91013 LIVE /tmp/dcsc-managed-destination-full-check.log; poll same
handle. No other live probes. Next integrate/verify source storage-network topology
assignment from public workflow and cable preparation, then maintained managed-
destination stdio/crash/browser gate. Shared managed-instance quantity logic remains
unit-tested only; don't claim broad matrix coverage or silently remove optics.
README still conservative pending full acceptance. Goal active.

## Managed-destination planner groundwork implemented (2026-10-30)

planNativeManualCableSelection now resolves physical destination via authoritative
physicalTemplateIds to template configuration; resolves catalog/selected quantity on
template and counts usage across its physical instances. Returns physicalDestinationIds
separately from editable configurationIds. Demand uses maximum per physical member,
retaining existing spares. stageNativeManualCableQuantity stages physical IDs rather
than template-only identity, retaining compatibility for older direct plan callers.
Unit regression covers two aliases/templateqty2, per-member demand1 then3 and both
physical feature updates with input immutability. This generalization is planning
logic only; native shared-managed-instance quantity contract is not yet verified.

Focused21tests31936 passed; initial typecheck found readonly test collection push,
fixed with reassignment. Typecheck/lint57296 PASS. Service discovery still requires
direct destination and has not been enabled; source storage-network assignment,
managed selection routing, native quantities/rules and complete public gate remain
next. No public managed-destination parity claim.

Placement regression10832 still LIVE at latest handle poll:
artifacts/parity-manual-create/2026-10-30-preserve-placement,
/tmp/dcsc-manual-placement-live.log. Poll same handle. It began before planner changes
and primarily validates manual autoArrange:false. Last full952test check predates
placement/planner edits; run complete current checks after integration.
Goal active.

## Fixed-layout managed-destination handoff passes; manual auto-arrange disabled (2026-10-30)

Controlled fixed-layout handoff46717 terminalPASS: one exact manual connection,
A3RGquantity2 and no controller section errors after native export/import including
workspace derive. Evidence managed-destination-audit-2026-10-30/fixed-layout-report.json
and fixed-layout-sessions.json. This validates the no-arrange control, not public
managed-destination creation or full design validation.

Production #autoConnectDraft now uses autoArrange:false for explicit manual seeds;
ordinary unseeded HPC Auto-Connect retains autoArrange:true. Prevents native movement
from invalidating distances calculated before manual creation. Added query assertion
to atomic graph+BOM service regression. Focused19tests/typecheck/lint75739 PASS.

Live maintained regression10832 is running:
artifacts/parity-manual-create/2026-10-30-preserve-placement,
log /tmp/dcsc-manual-placement-live.log. It covers managed source creation, two crash
recoveries, browser handoff and explicit clearing lifecycle. Poll same handle; no
new fullcheck since this small change (last952tests/17contracts/81tools predates it).

Next implement managed-destination ownership with source topology assignment and
preconfigured valid cable quantities, guided by now-passing native handoff. Preserve
all aliases sharing template quantity and spares; do not auto-remove optical modules.
Managed destinations remain unadvertised until public lifecycle gate proves them.
Goal active.

## Managed-destination import cause corrected: stale row geometry (2026-10-30)

Important correction: original manual-dac-valid REQUEST positions serverU1/controllerU2
were changed by its autoArrange:true RESPONSE to controllerU1/serverU3. Export/import
faithfully preserved response positions. This was not an export placement defect.
Distance control54473: original0.44445m vs moved0.4889m; A3RG0.5m remains offered at
both positions, so cable length alone does not explain route rejection.

Refreshed-distance control81619 terminalPASS1connection: imported request with no
identity reconstruction, original manual row but recalculated totalDistance,
cableDistance,sourceLocation,destinationLocation preserved native route. Thus stale
row geometry is sufficient to explain the negative imported reseeds; identity collapse
alone is not established as cause. Evidence refreshed-distance-request/response/report
and moved-distance.json under managed-destination-audit-2026-10-30.

Fixed-layout native seed2238 terminalPASS(autoArrange:false). Full controlled service
export/import46717 is LIVE, log /tmp/dcsc-fixed-layout-handoff.log, writes
fixed-layout-report.json and fixed-layout-sessions.json. Poll same handle. No production
change this turn. Next use successful control for planner implementation, and evaluate
native creation autoArrange interaction: service #autoConnectDraft uses autoArrange:true
for HPC seeds, while retention assertion currently checks identity/ports/shape but not
geometry. Recalculation must use native distance and preserve requested endpoints and
cable compatibility; do not silently accept moved/stale metadata.
Goal active; remaining managed-destination public support still unverified.

## Managed-destination loss isolated to changed placement (2026-10-30)

Identity controls78731 terminal0 with two negative cases: adding physical controller
id to imported storage definition, or restoring original templateid/configurationid/
cloneDependency, did not retain route. CFXML decodedCloneDependencyColor DOES retain
originalroot598deac9->physical95aa55a9 mapping; networking blob omitsroot. Neither
fact alone proves an identity-repair solution.

Field controls91168 terminal0: template-identity baseline plus original rackArea and
floorItems restores native route; restoring only original preferences or configurations
does not. Layout controls37071 terminal0 isolates further: original physical quantities
only fails; original positions plus buildFloorState succeeds with imported quantities.
Original sourceU1/controllerU2 became importedsourceU3/controllerU1. Native retained
manual route only after restoring positions. Evidence identity-controls-report.json,
field-controls-report.json,layout-controls-report.json and per-case request/response
under artifacts/managed-destination-audit-2026-10-30/.

Next investigate export placement/original full-catalog derived U_POSITION metadata
in controlled fixture and calculate cable distance against changed positions. Avoid
misdiagnosing native import graph loss as general managed-identity failure or adding
blind reseeding. Position restoration is diagnostic evidence, not permission to undo
user placement changes. No production edit this turn; all probes terminal. Goal active.

## Managed-destination import graph loss located; reseeding alone fails (2026-10-30)

Import capture46153 terminal1(exactgraph assertion). Native cfxml_import response
contains1 saved manual row. Both subsequent racks_customize requests carry1row but
responses contain0. Artifacts: managed-destination-audit-2026-10-30/capture-recovery-
2-cfxml_import.json,4/6-racks_customize.json and persisted capture-recovery-sessions.

Native reseed27651 terminal1: used final imported customization request state with
original full manual row through /auto_connect; HTTPsuccess did not retain graph.
reseed-request/response/report.json capture exact result. Thus merely calling native
auto_connect after hydration is not a verified recovery strategy.

Identity comparison: preexport controller root598deac9... maps to physical95aa55a9...
and storageConnectionNetworks.controller includes root id/hardwareType. Imported
request collapses controller into singletonphysical95aa55a9... and storage definition
controller has onlyfeatureCode/option, noid. Source storage assignment and selected
10GbE_Copper SFP28:1 topology survive. Next isolate loss of managed controller identity
and reconstruct only when original CFXML/native metadata uniquely proves ownership;
do not guess product-code matches or commit locally restored routes without native
acceptance. No production changes or live jobs this turn. Goal remains active.

## Managed-destination full workspace handoff exposes graph loss (2026-10-30)

New controlled handoff96650 completed export and native import/hydration but failed
exact graph retention. Setup combines accepted native rack/connection state with full
source/controller/rack catalogs and wire-selected section results, persists via
SessionStore transaction, then uses service exportZip/importConfig. Source snapshot
ws_vb4e734d has oneMANUAL storage-named route/A3RGqty2/controllersectionerrors[];
imported ws_pps3gavf has zero routes but stillA3RGqty2/controllersectionerrors[].
Evidence artifacts/managed-destination-audit-2026-10-30/handoff.ts,
handoff-sessions.json,handoff-export.json,handoff-report.json; log
/tmp/dcsc-managed-destination-handoff.log. Native workspaceAutoDerive and both rack
customizations returned200. Probe does not yet capture response bodies individually;
next capture import and customization stages to locate graph loss before changing
production. Do not claim successful full handoff or valid complete design based only
on controller section errors. Exact assertion failure is probe-level after import,
not atomic rollback of that already-created imported workspace.

Potential avenue after wire confirmation: recover saved MANUAL seeds through native
auto_connect with exact graph/quantity validation, analogous in rigor to breakout
recovery. Do not merely restore local rows after native rejection. Managed destination
planner still disabled; no silent optics changes. No live jobs remain, latest full
checks unchanged952tests/17contracts/81tools. Goal active.

## Managed-destination valid DAC configuration control (2026-10-30)

Inspected owner native response: quantity1->2 notice is explicitly paired-cable rule
7Y70_71_CTO2_DAC_CABLES_PAIRS_A.1, but section also had DISTINCT error A3RG should not
be greater than0. Prior owner result must not be described as valid BOM acceptance;
optical transceiversB4B2qty8 remained selected.

New isolated dac-control79785 terminal0: configured MECH_TRANSCEIVER/B4B2qty0 and
DAC_SFP_CABLE/A3RGqty2. Native controller retains B4B7qty2/A3RGqty2, no B4B2 selection,
and NO section errors. Evidence dac-control-validation.json and dac-control-
cto_autoDerive.json under artifacts/managed-destination-audit-2026-10-30. The generic
dac-control-report inherited stale qty1 wording; validation/native response are the
authoritative quantity2 evidence.

Replayed manual-dac-valid49615 terminalPASS after staging accepted transceiver and
DAC section results in controller wire configuration AND managed physical rack item.
Native auto_connect retained exact manual serverSFP28:1->managedDE2000HSFP+:1 route,
10GbE_Copper/A3RG. Evidence manual-dac-valid-request/response/report.json. Does not yet
prove workspaceAutoDerive, full-source BOM validity, shared aliases, crash or export.
Next build service-level managed-destination probe with these native accepted catalog
and quantity constraints before enabling planner. Do not auto-remove optics silently
as a side effect of manual creation; explicit configuration choices remain necessary.
No production changes this turn; no live jobs remain. Latest fullcheck952tests/
17contracts/81tools remains unchanged. Goal active.

## Managed-destination cable ownership corrected; native quantity adjustment found (2026-10-30)

Do not infer cable ownership from calculateDistance.ctoCode alone. Captured full
source catalog offers A3RG in EXTERNAL_CABLES and controller catalog offers it in
DAC_SFP_CABLE. Current captured website selectCable explicitly uses c.destinationId,
then resolves clone root and replaces that configuration's section selection. Thus
the prior source-owner inference is not established; destination ownership remains
the website behavior for cable editing.

Standalone native controller selection probe85483 finished1 because strict expected
qty1 assertion failed: requested DAC_SFP_CABLE/A3RGqty1, accepted native results
contain A3RGqty2. This is native quantity adjustment, not absence of cable or rejection
of destination ownership. Evidence under managed-destination-audit-2026-10-30:
owner-cto_autoDerive.json, owner-sessions.json, owner-report.json and cable-owner.ts.
Probe uses accepted native controller catalog in isolated standalone session; does
not establish physical-alias derive, shared-template multiplication or export parity.
Next inspect native quantity rules/controller multiplicity and replay managed graph
with the accepted quantity2 before generalizing planner ownership/quantity handling.
No production change based on the earlier ctocode inference. No live jobs remain.
Latest complete checks remain952tests/17contracts/81tools; goal active.

## Managed-destination native manual route accepted (2026-10-30)

Used captured native Ethernet storage control from
artifacts/release-results/20261016T021139Z/storage-followup/native-iscsi-direct-run2.
Direct captured floor data had incomplete/stale storage location metadata; first
distance52953 returned500. Rebuilt floorItems via existing buildFloorState from
accepted rackArea: distance81143 then200 with offered A3RG0.5mSFP+DAC. Its minimal
manual seed returned500. Completed row location/item/preferredCable fields and
preserved source selectedTopologies for the storage-named network, as website manual
selection does. Complete probe55485 terminalPASS: native auto_connect retained exact
MANUAL/P2P/divider1 serverSFP28:1 -> managedDE2000HSFP+:1,10GbE_Copper,A3RG,network
Native Direct iSCSI Optical. Explicitly a DAC control on compatible Ethernet ports,
not proof of optical patch-cable creation. Evidence under
artifacts/managed-destination-audit-2026-10-30/manual-complete-{request,response,report}.json.
Failed earlier controls preserved separately; no production guards removed.

Important ownership finding: offered cableFeature.ctoCode is source7D73CTOHWW,
selectionGroups empty, not destination7Y70CTOHWW. Current MCP planner always selects
cables on destination. Native row acceptance alone does NOT establish BOM quantity,
source-vs-destination catalog selection, persistence or export handoff. Next inspect
website manual cable owner behavior and full source/controller catalogs; verify
native quantity derivation before generalizing creation ownership. Source topology
assignment needed for seeding also requires deliberate handling of storage-network
names, rather than pretending this is ordinary fabric preference assignment.

No live jobs remain. Latest fullcheck6263 PASS952tests/17contracts/81tools unchanged.
Managed-source+clear13callgate staysPASS. Managed-destination remains unadvertised
pending implementation and acceptance; overall goal active.

## FC alternative-adapter and distance controls completed (2026-10-30)

Native alternatives77001 terminal0. Fresh configure removed ATZV and selected ATZC
(QLogic16Gb enhancedGen5 dual-port) or BJ3H(Emulex32Gb LPe35002 dual-port), eachqty1
in isolated copies. Both native derive responses still expose sourceFeature-matched
ports with only1GbE_Fiber/10GbE_Fiber/25GbE_Fiber and connectorFunction Network.
Evidence artifacts/fc-connector-audit-2026-10-30/alternatives-report.json and
ATZC-/BJ3H-1-cto_autoDerive.json. Confirms mismatch is not confined to initial ATZV.

ExplicitFC seed probe59137 stopped before submitting any seed. calculateDistance
for server->DE2000H, network16Gb_Fibre, resolved correct physical locations and
0.4889m but offered only seven passiveSFP+DAC cables(A3RG,A1PH,A51N,A51P,A1PJ,A1PK,A3RH),
noLC-LC. manual-report.json FAIL 'No offered LC-LC cable'; manual-distance.json keeps
fullnative response. Do not describe this as native seed rejection: no auto_connect
seed request was sent. No fabricated compatibility or topology override introduced
in production. Further managed-destination work needs a native offered compatible
route/shape, e.g. genuine Ethernet storage control, or additional website contract.

Fullcheck6263 terminalPASS952tests/123files,17contracts/build/81tools includes cleared
port diagnostics. All current probes are terminal; no running jobs. Previous managed
source+publicclear13callgate remainsPASS. Remaining functional coverage and final
immutable76commandrelease remain incomplete; goal active.

## Public deselection passed; current FC metadata mismatch captured (2026-10-30)

Managed-source clear gate25517 terminalPASS13calls. Both report.json and
clear-ports-report.json under parity-manual-create/2026-10-30-managed-source-clear-run2
pass. Public ports:[] clears only managed source, survives SIGKILL/restart and
export/reimport with the existing server route retained. Browser creation handoff
also passed again. Roadmap now reflects completed public deselection acceptance.

Fresh FC import audit85026 terminal0, captured live native responses and final
configurations in artifacts/fc-connector-audit-2026-10-30/. Native selected server
ATZV qty1 is Emulex16Gb FC HBA, yet its sourceFeature ATZV connector topologies are
1GbE_Fiber/10GbE_Fiber/25GbE_Fiber only. Controller B4DA(Fibre Channel)qty1,
B4B7(HIC)qty2/B4B2(universalSFP)qty8 likewise expose Ethernet-only B4B7 SFP+ topology
metadata. This corroborates the historical capture with current native evidence;
not a general unsupported-API claim. Do not fabricate FC connector topology support.
Next investigate alternative native FC products or supported optical-iSCSI media
before enabling managed-destination creation/replacement.

Adjusted cablingDiagnostics for the new clearing operation: explicit
selectedConnectors:[] no longer counts as requested missing cabling. Missing legacy
connector details remain conservatively requested; another configuration's active
selection still counts; existing rows remain visible. Focused4tests/typecheck/lint
75365 PASS. Last fullcheck48082 PASS951tests/17contracts/81tools predates only this
small diagnostic change and latest maintained gate extension. No live jobs remain.
Full current immutable release and remaining website gaps remain outstanding.

## Public port-clearing gate added; broader roadmap reconciled (2026-10-30)

Fullcheck48082 terminalPASS951tests/123files,17contracts/build/81tools. Extended
managed-source maintained gate after successful browser creation handoff: call public
dcsc_set_topology with ports:[], assert selectedConnectors empty/current graph,
retain only existing server source, SIGKILL/restart with exact persisted snapshot,
export and MCP reimport with exact one-row graph. Writes clear-ports-report.json.
Typecheck/lint2491 PASS.

Gate25517 is LIVE:
artifacts/parity-manual-create/2026-10-30-managed-source-clear-run2,
log /tmp/dcsc-managed-clear-gate.log. At last authoritative process/handle observation,
creation and two-restart MCP recovery subgate passed (mcp-recovery-report.json),
browser creation handoff was running, and public clearing had not yet produced a
call artifact. Poll same handle; do not restart on timeout. Previous run1 remains
fully passed9calls; this run adds clearing coverage.

Updated main roadmap's status/acceptance boundary: October16 matrix is historical,
not final proof for current tree; original anonymous23-finding scope does not narrow
the user's expanded full-website objective. Explicitly retains managed destinations,
additional physical/breakout shapes, genuine legacy recovery, account workflows and
final immutable release verification as outstanding. Goal remains active.

## Managed-source full MCP/browser gate passed; explicit port clearing added (2026-10-30)

Maintained gate17662 terminalPASS9calls. Report:
artifacts/parity-manual-create/2026-10-30-managed-source-run1/report.json.
Verified discovery/creation DB710S physical alias -> direct SN2201 Management,
prior route pinned/preserved, cable3801qty1, immediate SIGKILL/restart, export,
MCP reimport exact2rows/qty1, secondSIGKILL/restart/reexport, fresh headless website
import with native graph and grouped commercial parity. README now states this
bounded managed-source support; managed destinations remain unsupported.

Found additional missing website action while preparing seed: explicit empty ports
or connectorIds were treated as omitted and auto-selected a sole connector. Updated
resolveConnectors to distinguish explicit empty selection from omitted selection.
Tool schema and README document clearing; omitted behavior unchanged. Added two
regressions for empty ports/IDs, other-network retention and omitted sole selection.
Focused15tests/typecheck/lint86525 PASS.

Live clear76821 terminalPASS: applyTopology on managed source template with ports:[],
autoConnect:true removed only managed source route; native export and MCP import
kept one server route and free source. Evidence clear-report.json, clear-export.json,
clear-sessions.json and clear-probe.ts under managed-manual-audit. Uses actual service
method, not direct state editing. Public stdio clear+crash gate still to add.

Current fullcheck48082 LIVE `/tmp/dcsc-clear-topology-full-check.log`, includes latest
clear behavior. Earlier export fullcheck34752 passed949tests/17contracts/81tools.
No live browser job remains. Next extend maintained gate for public explicit port
clearing, then continue remaining gaps and final current immutable release matrix.
Full website parity remains unproven; goal active.

## Maintained managed-source MCP gate added (2026-10-30)

Fullcheck34752 passed949tests/123files,17contracts/build/81tools including export
preference fix. New maintained --managed-source mode in parity-manual-cabling.ts
uses native-exported xml/manual-cabling-managed-source.xml. Seed92805 terminalPASS:
source template Management connectors cleared in controlled state, native Auto-Connect
then export/import retained one existing server route and a free DB710S source port.
Fixture provenance documented; not a pointer-created website control.

Gate imports seed through stdio MCP, discovers cable3801, creates DB710S physical
RJ45 mgmt:1 -> SN2201 RJ45:20, checks preserved existing route and quantity1, kills
MCP process/restarts, exports, MCP reimports with exact graph/quantity checks, kills
and restarts again, reexports, then compares native browser import/layout/commercial
state. Package parity:manual-create:managed-source and release inventory entry added
(76 commands). Typecheck/lint53930 PASS; release inventory1895 PASS2tests.

Live gate17662 is running under headless lock:
`artifacts/parity-manual-create/2026-10-30-managed-source-run1`, log
`/tmp/dcsc-managed-source-gate.log`. At last poll import, connection inspection and
manual-options calls had completed. Poll same handle; do not restart on observation
timeout. README command added but broad support claim deliberately awaits gate.
No full website parity or current immutable release certification claimed.

## Managed-source export/reimport fixed and verified at service level (2026-10-30)

Traced prior empty graph to missing exported preferences: native cfxml_import still
returned both MANUAL rows, but clusterPreference/storageNetworks were empty; native
rack customization then returned zero rows. buildExportData previously used only
serverState.networkingInformation. It now overlays current top-level clusterPreference
and storageConnectionNetworks (as storageNetworks), including explicit empty lists,
while retaining imported-only fields when current values are absent. Regression
covers absent mirror, authoritative clears and imported fallback. Focused7tests,
typecheck/lint42960 PASS.

Live export21803 and MCP import92334 both terminal0. Fixed native import has10cluster
preferences/1storage network/2connections (prior0/0/2). Complete MCP hydration retains
both exact MANUAL routes; preferences-fixed-recovery-report.json PASS2connections.
Cable3801 quantity remains1 before/after import, recorded in
artifacts/managed-manual-audit-2026-10-30/preferences-fixed-quantity-report.json.
Other evidence: preferences-fixed-export.json, preferences-fixed-import.json,
preferences-fixed-recovery-* wire captures and persisted sessions. This is the
controlled service setup, graceful restart/export/MCP reimport; not yet public stdio
creation/SIGKILL or browser handoff. Native endpoint source identity remained exact.

Fullcheck89354 (restore fix) passed948tests/123files,17contracts/build/81tools.
Latest fullcheck34752 is LIVE with export preference fix; log
`/tmp/dcsc-managed-export-full-check.log`. Poll same handle. Next add maintained
managed-source MCP gate using complete native seed, verify crash/restart/export and
browser handoff, then update README support scope. Full website parity remains open.

## Managed cable restart defect fixed; reimport loses graph (2026-10-30)

Persistent controlled handoff41356 exposed a real restore bug: validateKnownReferences
accepted only configuration/session IDs for cable endpoints, quarantining the valid
DB710S physical alias. Fixed cable-only validation to include authoritative storage
physical aliases whose owning template exists; invalid alias ownership still marks
damage. Extended storage-placement restart regression to retain a physical-to-physical
cable and separately quarantine an unknown alias. Focused14tests, typecheck and lint
passed. Initial test type error (cablePart vs CableLink.cableCode) corrected.

The original failed snapshot now restores cleanly and exports XML. Native import
control5527 finished exit0; artifact handoff-native-export.json points to XML.
MCP import recovery75488 finished exit1: import completed, but persisted imported
workspace has zero connections, whereas source has two MANUAL Management rows
(server->SN2201 port3 and DB710S alias->SN2201 port10). Exact graph assertion failed.
Evidence in artifacts/managed-manual-audit-2026-10-30: handoff-sessions.json,
handoff-native-import.json, recovery-quantity-sessions.json, recovery-quantity-report.json,
recovery-quantity-* captures. Next locate whether native importer or hydration drops
these rows; do not label upstream until comparing the wire stages.

The earlier full check99658 passed948tests/123files,17contracts/build/81tools before
this restore fix. Current full check89354 is running, log
`/tmp/dcsc-managed-restore-full-check.log`; poll that same handle. No live probe remains.
Controlled setup still uses native capture plus full catalogs and explicit free source;
not a website-created free-port control. Public MCP/browser managed-source gates remain
outstanding. No full managed-source parity claim or release claim.

## Managed-source service creation passes; prior distance diagnosis corrected (2026-10-30)

Controlled live service probe97679 finished exit0. Discovery offered compatible
Management cables; creation passed native cto_autoDerive, auto_connect and workspace
AutoDerive with exact graph retention and adequate cable quantity checks. The source
remained the DB710S physical alias, while sourceConfigurationIds names its template;
destination is direct SN2201. No additional routes were generated. Evidence:
`artifacts/managed-manual-audit-2026-10-30/service-report.json`, service-discovery.json,
service-*-wire files and service-probe.ts. No live jobs remain from this investigation.

Correction to the preceding entry: the distance API returned copper cables alongside
fiber choices. Zero discovery choices came from the controlled fixture, not proven
upstream incompatibility. Captured wire configurations omit full tabs/catalogs; the
probe now hydrates them from same-product persisted native configurations while
restoring wire-selected section results. It also converts native floor cells into
SessionStore rackId/x/y placements; directly assigning native cells produced invalid
coordinates. These are probe fixes, not production changes. Root-first dependency
normalization remains explicit in the probe. Source row is deliberately omitted to
exercise creation, so this is not a website-created free-port control.

Distance orientation controls88526 all finished; reversed endpoint order changes
reported product owner but does not solve or explain filtering. Website SPA action
uses source->destination and connection topology, matching production. No request
reversal, fabricated compatibility or topology-filter weakening was introduced.
Next: persist the controlled service result, verify restart/export/import, then add
maintained real-MCP managed-source coverage before advertising full support. Current
production source lookup fix has 39 focused tests/typecheck/lint passing; full check
and complete managed-source handoff are still outstanding.

## Managed-source lookup implemented; distance catalog mismatch exposed (2026-10-30)

Added nativeManualSourceConfigurationId and optional physical-template mapping to
selectNativeManualSourceGroup. Both service discovery and creation resolve source
network/topology ownership through this mapping; distance and connection endpoints
retain the physical alias. Unit test covers Map/record mappings, template-only
updates, immutable input and missing owners. Focused 39 tests, typecheck and lint
passed. No complete managed-source support claim yet; README remains conservative.

Controlled service probe: artifacts/managed-manual-audit-2026-10-30/service-probe.ts.
It builds a workspace from the native captured payload and omits the source row;
this is not a website-created free-port control. Initial discovery failed because
one historical storage dependency listed alias before root; probe explicitly
normalizes root-first ordering (production guard unchanged). Second run9571 exited1:
lookup and distance succeeded, but discovery returned zero compatible choices.
Distance correctly resolved DB710S A1/U4 -> SN2201 A1/U6; its catalog nevertheless
contains source-product 7DHNCTO1WW LC-LC fiber cables (ASR5 etc.), not destination
SN2201 Management cables. All distance choices have empty selectionGroups. Evidence
service-1-manual_cabling_distance.json, service-discovery.json, service-report.json.
Next investigate native UI distance orientation/cable ownership for switch sources;
do not bypass topology filters or invent a cable choice. Native manual seed acceptance
remains proven but full service creation is not. No job remains from live probe or
static checks; historical session-file search72205 may still be running.

## Managed-source manual cabling: native acceptance confirmed (2026-10-30)

Fresh DcscHttpClient replay of the captured r49 san-switch-mgmt layout returned
HTTP 200 and retained both requested MANUAL rows with exact graph identity checks.
The managed DB710S 7DHNCTO1WW physical alias was retained as source; its destination
RJ45 port was changed from 2 to 10. Evidence and qualifications:
`artifacts/managed-manual-audit-2026-10-30/manual-report.json`, request/response and
`probe.ts`. Probe process 71148 finished exit 0. No running job remains from this probe.

This establishes native seeded manual-row acceptance for this managed source,
not fresh free-port creation, BOM correctness or export/import parity. Do not yet
remove production guards based on this narrower result. The service's creation
and discovery source lookups require a direct configuration ID; discoverManualPorts
already resolves physicalTemplateIds. selectNativeManualSourceGroup also expects
configuration IDs. Next: resolve physical source to its owning template while
retaining physical endpoint identity on the graph/distance request, then verify
through a persisted managed workspace and the full creation lifecycle. Managed
destinations require separate cable/BOM ownership handling and remain unverified.

## Latest verification: manual creation and breakout replacement (2026-10-30)

Both previously pending jobs have finished. The current full local check passed
947 tests in 123 files, 17 contract tests, build and stdio startup with 81 unique
tools. Log: `/tmp/dcsc-breakout-replacement-catalog-check.log`.

The maintained breakout replacement run2 completed 17 MCP calls. Its MCP recovery
subgate passed: five connections, two physical cables, shared cable replacement,
restart, export, MCP import, second restart and re-export. Evidence:
`artifacts/parity-manual-create/2026-10-30-breakout-replace-run2/mcp-recovery-report.json`.
Overall status remains blocked solely on the independently demonstrated native
website import conversion of BREAKOUT/divider4 into P2P/divider1; see adjacent
`report.json`. Neither job is still running. README now reflects this result.

The user clarified that the original complaint probably concerned adding a manual
connection. Native acceptance demonstrates that this was addressable in the MCP,
not a general lack of API support. Managed physical aliases and broader breakout
shapes remain guarded/unverified; empty native FC graphs are scoped observations,
not proof that all storage cabling APIs are unsupported. No full website parity or
current immutable release-matrix completion is claimed.

## MCP breakout recovery fully passed; native replacement inconsistency captured (2026-10-30)

Recovery36795/run4 terminal2 with explicit WEBSITE BLOCK only. MCP subgate PASS:
15calls total, creation of two manual branches sharing port60 beside automatic49,
physicalqty2, firstSIGKILL/restart, export, MCP reimport with restored shapes/qty,
secondSIGKILL/restart and re-export. Evidence
`artifacts/parity-manual-create/2026-10-30-breakout-recovery-run4/mcp-recovery-report.json`.
Overall report blocked for independently confirmed website BREAKOUT4->P2P1 loss;
no other graph differences. This finally proves the full MCP recovery handoff subset.

Replacement23786/run1 terminalFAIL at sharedreplacement: newly created rows have
empty selectionGroups, unlike auto rows used by serviceprobe. Current planner now
resolves absent groups against exactly one destination catalog section containing
BOTH old and new cable parts; missing or ambiguous sections reject. Existing supplied
groups remain authoritative. Added missing/ambiguous-group tests to native shared
replacement test; focused30tests and static88218PASS. Rerun14576 LIVE:
`artifacts/parity-manual-create/2026-10-30-breakout-replace-run2`, log
`/tmp/dcsc-breakout-replace-live2.log`.

Native replacement capture39327 terminal0. after.txt/html show three AV22 branches
and one AV23 branch at sameQSFP28:49; 2-derive.json selects ONLY AV23qty1 (AV22 absent).
Capture setup uses native storeCabling restore after import and scripted DOM click;
not a pure pointer/UI-created control. Findings in replacement-run2/replacement-findings.json.
Confirms native per-row replacement inconsistency; MCP physical-cable group behavior
intentionally preserves coherence rather than reproducing it.

Export now returns breakoutBranchesAtRisk count and tool-level breakoutReimportWarning
for observed4-way rows, so actual artifact handoff explains website limitation.
Service computes count from export snapshot; unit test confirms exported rows unchanged.
Focused export/tool13tests and static36841PASS. Maintained gate asserts warning for
breakout exports. Fullcheck45626 PASS946tests/17contracts/81tools before these final
changes. Current fullcheck87649 LIVE `/tmp/dcsc-breakout-replacement-catalog-check.log`.
Frozen69matrix is finished, not live. Only replacement14576/fullcheck87649 remain
active at this observation. Goal active; no global parity completion claim.

## Frozen matrix finished; shared replacement service verified (2026-10-30)

Frozen matrix97956 terminal1:64pass,3fail,2blocked, all69 commands finished; integrity
before/after bothPASS. Last headless suite passed. Frozen failure assessment in
`artifacts/release-2026-10-30/frozen-matrix-assessment.json` maps dependency6,
networkprice21,nestedlocator59 to separate working fixes/live evidence. Blocks13
GB300 and25FCstorage remain. Preserve frozen checkout/artifacts; this predates all
recent breakout changes and does not certify current tree.

Shared replacement service40543 terminal PASS: four native branches AV22->AV23,
three updatedConnections reported, qty1AV23/0AV22, management rows unchanged.
Evidence breakout-audit/replacement-service-report.json and replacement-* captured
native derive. Final endpoint guard static6320 PASS11tests. Maintained script now
supports --create --breakout-replace: create two branches at port60 alongside one
at49, replace both port60 branches atomically, require AV22qty1/AV23qty1, then full
restart/export/MCP recovery and browser check. Package parity:manual-replace:breakout,
workingreleaseinventory75. Static/inventory16029PASS. Added bounded updatedConnections
tool regression; fullcheck45626 running `/tmp/dcsc-breakout-replacement-check.log`.
Live replacement gate23786 queued/running under lock, output
`artifacts/parity-manual-create/2026-10-30-breakout-replace-run1`, log
`/tmp/dcsc-breakout-replace-live.log`. Recovery36795/run4 remains live.

Original native replacement browser capture39090 terminalFAIL due overlay intercepting
click on offered AV23, NOT API rejection. It reached actual edit dropdown; evidence
breakout-audit/replacement/failure.json plus edit/choices files. Followup capture39327
uses dispatchEvent(click) on offered AV23 (scripted DOM action, not physical pointer),
still native storeCabling setup. Script replacement-capture2.ts, output replacement-run2,
log `/tmp/dcsc-breakout-replacement-capture2.log`. Qualify this evidence accordingly.
No production logic based on assumed UI outcome. Poll existing handles, no timeoutrestart.
README describes serviceverified shared replacement and pending complete handoff.
Goal active; website breakout import remains upstream blocked.

## Shared breakout replacement implemented; native proof pending (2026-10-30)

Moved countNativePhysicalCables to src/domain/cableQuantity.ts (re-exported from
nativeManualCabling for existing callers), avoiding a manual/native module cycle.
Existing cable-part replacement now recognizes demonstrated BREAKOUT4 SFP28->QSFP28
100GbE_Copper. It requires offered replacement description identifying 100G QSFP28
to4x25G SFP28 DAC, counts physical destination ports for old/new usage, and stages
all same-destination branches atomically with per-branch compatible-choice checks.
Inconsistent shared metadata rejects. Other ports/cables/spares remain intact.
Related changes commit through existing identity validation and return updatedConnections
(distinct from collision-swappedConnections). Public tool description names this scope.

New reduced fixture breakout-replacement-input.json and planner test cover four
branches->one cable, second physical cable and spares, all MANUAL updates, input
immutability and a branch lacking compatible choice. Focused55tests and static43118
PASS. Added final endpoint-name guard; latest focused/static check running (inspect
process; session returned immediately after this entry). No full latestcheck yet.

Live service replacement probe40543 runs on isolated native auto-breakout workspace,
AV22->AV23, requires three related updates/four MANUAL AV23 branches, native qty1
AV23/0AV22. Evidence output breakout-audit/replacement-service-report.json and
replacement-* captures; log `/tmp/dcsc-breakout-replacement-probe.log`.
Native UI capture39090 and maintained recovery36795 still pending behind headless
lock; frozen matrix69parityheadless still running. Poll existing handles; never
restart on observation timeout. Fullcheck37737 passed944 before replacement changes.
Website import shape defect remains open. Goal active.

## Breakout recovery re-export marker fixed; replacement capture queued (2026-10-30)

Fullcheck37737 terminal PASS944tests/123files,17contracts,build,81-tool startup.
Maintained recovery45838/run3 terminal FAIL at recovered workspace export (call15):
graph/qty2 restoration and second SIGKILL/restart passed, but native quantity configure
left connectionGraphInvalidation set. Current import now removes that marker only
AFTER exact saved breakout graph and accepted physical cable quantity checks pass.
No generic export guard was relaxed. Static/focused68560 pending; maintained run4
LIVE36795, output `artifacts/parity-manual-create/2026-10-30-breakout-recovery-run4`,
log `/tmp/dcsc-breakout-recovery-live4.log`. Do not call recovery handoff complete yet.

Native frontend replacement analysis saved:
`artifacts/breakout-audit-2026-10-30/frontend-select-cable.txt` and
frontend-replacement-findings.json (bundle hash). selectCable changes only the
selected equal row and calls replaceCableSelectSelection; no shared branch expansion
visible. Static evidence only. Controlled UI capture LIVE/queued39090 under headless
lock, script replacement-capture.ts, output breakout-audit/replacement, log
`/tmp/dcsc-breakout-replacement-capture.log`. Imports native automatic control XML,
restores original backend graph via native storeCabling action to avoid known import
shape defect, opens actual cabling Edit and selects AV23. Qualify setup as native
action injection, not a pure UI-created graph. No production replacement changes yet.

Frozen matrix confirmed at69parity:headless, counts before final:63pass,3fail,2blocked.
Failures: olddependency6,staleprice21,nestedlocator59 (all corrected separately in
working tree). Blocks13verifyfixes/GB300 and25storageFC. Matrix completion/integrity
still pending; preserve frozencheckout. Goal active.

## Breakout import graph AND quantity live-verified at service level (2026-10-30)

Quantity recovery exposed two concrete integration gaps, now fixed:
1. CFXML rows omit cableFeature. Import planning resolves the saved part against
   the destination catalog using empty selectionGroups and exact featureCode;
   unique selection-section and quantity guards remain. Original quantity probe
   53942 and maintained run2/8631 failed before commit on missing metadata.
2. #configureDraft native derive prioritizes physical rack features over delta.
   Quantity probe87094 returned AV22qty1 despite delta2, then correctly rolled back.
   Import now stages physical quantities BEFORE configure and again after acceptance.
   Previous failure report preserved as recovery-quantity-before-physical-fix.json.

Probe28307 terminal PASS: five exact native rows incl three MANUAL BREAKOUT/divider4
at two physical ports, accepted AV22qty2. Evidence
`artifacts/breakout-audit-2026-10-30/recovery-quantity-report.json`, recovery-quantity
sessions and captured requests. Log `/tmp/dcsc-breakout-recovery-quantity-probe3.log`.
Static10733 and32focused import/domain tests PASS. Prior fullcheck65429 passed944
but predates these two fixes; do not treat it as final verification.

Final corrected validation LIVE:
- maintained actualMCP recovery45838, `artifacts/parity-manual-create/2026-10-30-breakout-recovery-run3`,
  `/tmp/dcsc-breakout-recovery-live3.log` (full creation,quantity,reimport,restart,reexport;
  website handoff stays blocked only for exact known shape loss);
- fullcheck37737, `/tmp/dcsc-breakout-import-physical-check.log`.
Frozenmatrix still live at63nested-unplace;62nested-detachpassed. Nested locator
fix previously liveverified. Do not restart live handles on observation timeout.
Goal active; website breakout import and physical breakout replacement still open.

## Breakout recovery quantity defect corrected; nested browser gate passed (2026-10-30)

Maintained breakout recovery29615 terminal FAIL at MCP reimport after13calls:
exact graph restored, but selected AV22 quantity became1 instead of2 for three
branches at two physical destination ports. Preserve this finding; earlier
service recovery checked graph only and did not prove commercial parity.
Evidence `artifacts/parity-manual-create/2026-10-30-breakout-recovery-run1/report.json`.

Import now captures plans after initial hydration/before sync, counting physical
ports and retaining imported spares. After sync it restores target quantities via
native #configureDraft, stages accepted physical feature quantities, checks native
selection equality and retains the final exact shape check, all inside atomic
import preparation. No local-only price manufacture. Focused import/domain32tests,
typecheck/lint PASS. Current quantity validation LIVE:
- maintained MCP gate8631, `artifacts/parity-manual-create/2026-10-30-breakout-recovery-run2`,
  log `/tmp/dcsc-breakout-recovery-live2.log`;
- service recovery quantity probe53942, output breakout-audit/recovery-quantity-*,
  log `/tmp/dcsc-breakout-recovery-quantity-probe.log`, explicitly checks five rows
  and AV22qty2, selects returned workspaceId rather than assuming first workspace;
- full check65429, `/tmp/dcsc-breakout-import-quantity-check.log`.
Poll these same handles; do not restart on observation timeout.

Nested browser diagnostics62189 terminal PASS, native17capturedcalls including
chassis/node placement, export200 and freshimport200. Evidence
`artifacts/parity-nested-vlh/2026-10-30-selector-diagnostics/result.json` status
discovery-pass. Working selector whitespace fix and pending-promise error handling
are now verified. Frozen command59 failure remains historical; checkout untouched.
Frozen matrix still live, last62 nested-detach;60nestedstdio/61removechassispassed.

Breakout physical cable replacement remains outstanding: existing replacement
planner counts rows and updates one row, unsuitable for shared branches. No change
made yet; finish quantity recovery validation before native replacement capture.
Goal active; no full website parity or release claim.

## Maintained breakout recovery gate added; nested browser failure investigated (2026-10-30)

Full check66590 terminal PASS: 944tests/123files,17contracts,build,81-tool startup.
Final retention-assertion static99879 also passed. Maintained manual cabling gate
now checks breakout MCP XML reimport, exact graph and two-cable quantity, a second
SIGKILL/restart, and re-export, writing mcp-recovery-report.json. Website import
still runs commercial/graph checks. Only the exact independently captured
BREAKOUT4->P2P1 degradation is classified blocked (exit2); any other mismatch fails.
This is not a website parity pass. LIVE session29615, output
`artifacts/parity-manual-create/2026-10-30-breakout-recovery-run1`, log
`/tmp/dcsc-breakout-recovery-live.log`. Static65248 PASS.

Frozen matrix command59 nested-vlh failed locating [7DD1CTOLWW] Node Non Rack Area
in Add Node cascader. failure.json (under frozen artifacts/parity-nested-vlh timestamp
2026-10-30T14-31-04-810Z) preserves the original locator timeout. An unhandled pending
response promise masked it after browser closed. Working script now handles pending
response rejection, tolerates whitespace/newlines in the node label, and captures
expanded menu text after hover. Native behavior not yet reverified; do not call it
fixed based solely on locator change. Fresh run LIVE session62189 under headlesslock,
`artifacts/parity-nested-vlh/2026-10-30-selector-diagnostics`, log
`/tmp/dcsc-nested-vlh-diagnostics.log`. Static93715 PASS. Frozen checkout unchanged.

Current frozen matrix is live at60 nested-stdio. Known failures olddependency,
stalepriceoracle, and now nested browser locator; inspect report for current counts
rather than assuming no other blocks. Tool creation description now explicitly
states website breakout import limitation and MCP recovery. Goal active.

## Native import defect confirmed; MCP recovery implemented (2026-10-30)

Import capture51630 terminal0. `artifacts/breakout-audit-2026-10-30/import-probe/1.json`
shows cfxml_import itself returns divider1/category absent for original XML Divider4.
Browser customize request passes those degraded rows; response assigns P2P. Automatic
control57033 also terminal0: original four AUTO breakout branches export with Divider4
but cfxml_import returns1. Evidence auto-control-export.json / auto-control-import.json.
This establishes a scoped upstream import defect, not a missing breakout API.

New src/domain/importCabling.ts reads bounded gzip NetworkingInformation in original
CFXML, recovers demonstrated SFP28/QSFP28,100GbE_Copper,4-way DAC shapes only, and
restores category/divider only after all saved rows uniquely match imported identities
(network,topology,part,source/dest IDs/ports,type/subType). No partial mutation on
identity failures. prepareImportFile carries this source metadata; acceptImportPayload
restores before hydration, emits diagnostic, and now verifies shape retention before
atomic import commit. Reduced native fixture breakout-import-native.json and three
unit cases cover exact restoration, unchanged management,missing/duplicate/changed
identities and designs without networking. Focused import/multipart15tests PASS;
typecheck/lint passed before final retention assertion, final static99879 pending.

Live recovery98190 terminal PASS: original failed website XML imported through MCP
service, all5 rows retained incl three MANUAL BREAKOUT/divider4 rows after both native
customize calls and workspace derive. Evidence recovery-report.json/recovery-sessions.json
and recovery-* captures. This service probe predates only the final precommit assertion;
its own identical graph assertion passed. Direct website still degrades; do not claim
website handoff complete. README distinguishes MCP recovery from website failure.

Full check66590 still live, log `/tmp/dcsc-breakout-import-check.log`; it started before
final precommit assertion. Need maintained real MCP import/restart/export gate, final
static result and final full-test result. Original breakout website gate remains a
real failure, not a pass. Frozen matrix live (last59 nested-vlh). Goal active.

## Breakout handoff failure isolated; import capture running (2026-10-30)

Full local check40725 PASS: 940 tests/122 files,17 contracts,build,81-tool startup.
A subsequent additive public inspection change exposes category/divider; focused
manual domain/tool tests16 and typecheck/lint PASS. Discovery continuation test
now verifies connectionType survives paging. Package/release inventory now74
with parity:manual-create:breakout; inventory tests2 PASS.

Breakout transport gate88915 terminal FAIL at native-create-browser-reimport,
after12 successful MCP calls, two branch creations, correct two-cable quantity,
SIGKILL/restart and export. Browser customize rewrites BREAKOUT/divider4 to
P2P/divider1. Evidence `artifacts/parity-manual-create/2026-10-30-breakout-run1/report.json`.
Do not weaken retention to call this pass. XML NetworkingInformation is gzip/base64;
decoding shows each AutoConnectItem DOES contain <Divider>4</Divider>, but no
Category field. Export payload uses full native readConnectionGraph in both
root and networkingInformation autoConnectResults. Need determine import response
versus browser request versus customize response mutation, then compare native export.
README explicitly qualifies breakout handoff as unverified due to observed rewrite.

Isolated reimport capture LIVE session51630 under headless lock, script
`artifacts/breakout-audit-2026-10-30/import-probe.ts`, output import-probe subdirectory,
log `/tmp/dcsc-breakout-import-probe.log`. It reimports existing XML and records raw
request/response for cfxml_import and racks/customize. Request capture uses postData
string (multipart import is not JSON). Check report/process; do not restart for
observation timeout. Maintained gate now writes native-import/layouts before graph
assertions so later failures preserve evidence. Frozen matrix remains running.
Existing manual cable REPLACEMENT uses row-count quantities, not breakout grouping;
this is a separate follow-up before claiming all breakout editing parity.
Goal active. No production deployment/commit.

## Breakout creation wired; service probe passed, transport gate running (2026-10-30)

NativeManualConnectionRequest and both public creation/discovery schemas now accept
optional connectionType=breakout-4 (default behavior remains point-to-point).
Discovery intersects distance and catalog, restricted to 100GbE_Copper DAC - Break Out
with catalog description identifying 100G QSFP28 to 4x25G SFP28. Staging requires
SFP28 source/QSFP28 destination, free source and up to four matching branches at
the destination (same part/network/topology/shape). Other occupied ports reject.
Inspect now skips incompatible individual cable choices inside its per-choice try.

Service-level creation PASS: starting with one AV22 branch at destination49,
create source2->destination50, then source3->destination50, pinning routes. All
three rows retained MANUAL; second branch shares the cable. Evidence:
`artifacts/breakout-audit-2026-10-30/create-report.json`, create-sessions.json and
captured create-* requests. Session27059 terminal0. Existing linked-source100G
quantity regression PASS11calls including restart/export/browser:
`artifacts/parity-manual-create/2026-10-30-physical-quantity/report.json` (29286terminal0).

44 focused domain/service/tool tests PASS; typecheck/lint PASS after maintained gate
changes. scripts/parity-manual-cabling.ts now has --create --breakout: BPPW adapter,
AV22 preference, first SFP28 branch automatic, create second at port60, then third
at same port60; checks three branch rows/two physical cables, shared shape, restart,
export and browser parity. LIVE session88915, output
`artifacts/parity-manual-create/2026-10-30-breakout-run1`, log
`/tmp/dcsc-breakout-live.log`. Poll same handle, do not restart on timeout.
Package/release inventory and README not yet updated pending this end-to-end result.
Full check also still needed for latest feature; existing934 count predates it.
Frozen matrix remains independently running. Goal active, no full parity claim.

## Native breakout support confirmed; quantity planner extended (2026-10-30)

Both breakout probes are terminal PASS. Auto-Connect on BPPW four SFP28 ports,
SN3420,100GbE_Copper and AV22 yields four rows sharing destination QSFP28:49,
category BREAKOUT/divider4, with one selected AV22 in QSFP+_AND_DAC_CABLES.
`artifacts/breakout-audit-2026-10-30/report.json`, request7 and derive response8
are authoritative. The manual replay pins all six rows, moves the four breakout
branches to QSFP28:50, and verifies exact retention including shape: PASS in
`manual-report.json`/`manual-response.json`. This is API evidence, not yet a full
MCP creation/export/browser gate. Downloaded live app/vendor assets in that folder.

Added reduced `test/fixtures/parity/breakout-native.json`. Quantity planner now
uses countNativePhysicalCables: group by physical destination port; allow P2P/1
or demonstrated BREAKOUT/4; reject duplicate source endpoints, overcapacity and
mixed shape/topology/network/part at a destination. Partial branches at different
ports require separate cables. Existing synthetic P2P quantity tests incorrectly
reused occupied endpoints; corrected those fixtures rather than relaxing guards.
36 focused tests, typecheck and lint PASS. Cable-choice filtering and staging still
only enable P2P creation: next implement explicit breakout request/shape and shared
port capacity discovery, then real transport/restart/export/browser validation.

Affected linked-source100G gate running session29286 under headless lock:
`artifacts/parity-manual-create/2026-10-30-physical-quantity`, log
`/tmp/dcsc-physical-quantity-live.log`. Frozen matrix still live (last command51).
Do not restart either merely on observation timeout. Goal active.

## Retention live gate passed; breakout capture running (2026-10-30)

The stricter category/divider/subType retention check passed the live linked-destination
creation gate: 9 MCP calls, four connections, restart and website import. Evidence:
`artifacts/parity-manual-create/2026-10-30-retention-shape/report.json`.

An isolated native Auto-Connect breakout probe is running (session67315, process2107117;
log `/tmp/dcsc-breakout-probe.log`). It copies the verified direct100G workspace into
`artifacts/breakout-audit-2026-10-30/sessions.json`, configures BPPW four-port SFP28,
selects AV22 with SN3420/100GbE_Copper and assigns all four source ports. It records
responses via DcscHttpClient.send. Inspect its report and accepted connection rows;
a successful call alone does not prove correct breakout shape/BOM. Do not restart
on observation timeout. New live SPA assets were also downloaded into that directory;
they did not expose an obvious divider-based cabling handler. No breakout support
has yet been enabled. Frozen matrix remains live at command48.

## Connection-shape retention strengthened (2026-10-30)

The native manual graph retention check now also compares subType, category and
 divider, in addition to endpoints, topology, cable part and ownership type. This
prevents silent native changes to connection kind or breakout shape from being
accepted. Three regression cases verify rejection while existing price-only
changes remain permitted. Focused domain/service suite passed 35 tests; typecheck
and lint passed. This does not enable breakout creation: a native accepted breakout
graph and its BOM accounting still need capture and verification.

Affected live two-member destination regression started with output directory
`artifacts/parity-manual-create/2026-10-30-retention-shape` and log
`/tmp/dcsc-retention-shape-live.log`; inspect the authoritative process/report before
continuing. The frozen release matrix was confirmed live at command47 (unconfigured).
No completion claim.

## Linked switch editing and manual destinations verified (2026-10-30)

This entry supersedes the earlier linked-destination restriction and pending checks.
HPC linked-switch editing now uses the native root-only derive request with top-level
customizingIds and validates/project responses across the linked group. The maintained
switch-edit gate passed 8 MCP calls, including shared quantities, Auto-Connect,
restart, export and fresh browser commercial/physical parity:
`artifacts/parity-switch-clone/2026-10-30-edit-run1/report.json`.

Native manual creation now supports tested linked SN2201 destinations. Cable quantity
is shared per member and covers the busiest member, rather than summing routes across
the group. Divergent quantities and ambiguous physical placements remain rejected.
The two-member gate passed 9 MCP calls, four retained connections, process-kill
recovery and native browser import:
`artifacts/parity-manual-create/2026-10-30-linked-destination-run4/report.json`.
It uses AVFQ (0.75 m), offered for both routes. Earlier runs correctly rejected 3791
(0.6 m) for the longer second route; these are incompatible test input, not evidence
of an API limitation. The maintained gate now follows cable-choice pagination.

Full local validation passed 934 tests in 122 files, 17 offline contracts, build and
81-tool startup (`/tmp/dcsc-linked-destination-check.log`). Working release inventory
is 73 commands. The independent frozen 69-command matrix remains running; its snapshot
predates these changes and cannot certify the current tree. It has known old-dependency
and stale-price-oracle failures, both separately corrected in the working tree, plus
the declared GB300 capability block. Do not restart it on polling timeouts.

Full website parity is not established. Managed storage aliases, breakout creation,
genuine legacy recovery, broader physical shapes and authenticated workflows remain
open or unverified. Tested empty storage graphs and null GB300 power are scoped
upstream observations, not proof that all remaining APIs are unavailable.

## HPC switch Clone Multiple implemented and live-verified (2026-10-30)

Native switch clone capture confirms two customize calls (autoArrange=true,
autoConnect=true,cogValidation=true, full cloneDependency), followed by derive
using root-only configurations, no customizingIds and no entranceFlag. Generic
GP clone wiring produced U22; matching the native HPC switch sequence yields U7,
matching the browser. New cloneHpcSwitch path preserves dependency metadata,
requires the cloned root in derive responses, validates complete target groups
with projectHpcLinkedResponses, and propagates returned updates to members.
Simple product/machine-type maximum checks permit valid ruled placements while
preserving unknown/nested/VLH guards. Reduced native fixture:
`test/fixtures/parity/hpc-switch-clone-native.json`.

Maintained actual stdio gate PASS6calls: six configurations/five physical items,
root/member linked group, clone atU7, undo/redo, immediate SIGKILL/restart, export,
fresh browser commercial equality, complete physical placement and connection
graph equality. Evidence: `artifacts/parity-switch-clone/2026-10-30-run1/report.json`.
Added parity:switch-clone; working inventory71, frozen inventory69 unchanged.
Domain/clone-service focused tests pass including wire-order and shared response
projection. Full local check is LIVE session85967, log
`/tmp/dcsc-hpc-switch-clone-check2.log`; final static check5528 passed.
The earlier full check failed lint only on new gate cleanup syntax; fixed before
this rerun. Prior pre-wire full check passed930tests; do not use it as final proof.

Native linked cable edit also captured, but NOT yet implemented in the MCP:
`artifacts/linked-destination-audit-2026-10-30/native-report.json` and requests.json.
The editor sets3791quantity2 on the root and both root/member physical private
records contain quantity2 after returning to workspace. Both private records have
the SAME _shareDataId, even though shared workspaceBindingIds stays singleton;
do not misclassify linkage from that singleton field alone. Edit request sends
customizingIds at TOP LEVEL for both members, root-only configurations and no
entranceFlag. Response updateConfigurationIds covers both members, with dependent
rack and other independent switch updates. Native clone derive omits
customizingIds; distinguish edit versus clone contracts. Next implement HPC
linked-switch editing and group-owned manual destination quantities, preserving
existing guards until verified. Current creation linked-destination guard stays.

All capture/preparation/network-price/Management/switch-clone gate processes are
terminal. Only full local check85967 and frozen matrix97956 remain
live at this observation. Matrix reached33 storage-placement-reimport, with old dependency
audit and stale-price network failures, plus declared verify-fixes block. Goal
active; no full website parity or release claim.

## Current-price network parity restored; linked destination investigation (2026-10-30)

Frozen matrix command21 parity:network failed on historical r25 prices: current
SN2201 totals6750.51/6760.01 versus the October15 fixture6760.51/6770.01. Working
gate now retains the structural/port oracle but compares current MCP prices to
fresh native browser import, including individual configuration prices and
selected part/quantity equality. Historical prices remain diagnostic evidence.
Rerun PASS, terminal session2842, evidence
`artifacts/parity-network/2026-10-30-current-price-oracle/result.json`.
Do not rewrite the frozen matrix failure or call it an API limitation.

Direct Management creation regression PASS6calls, restart/export/commercial and
completed browser graph parity. Evidence:
`artifacts/parity-manual-create/2026-10-30-shared-source-regression/report.json`.
Session97583 terminal0.

Linked destination preparation exposed a separate MCP restriction: Clone Multiple
rejected SN2201 because productMinMaxRule=0..18. Native frontend
canRackItemPutInRackCount counts existing products/machine types and checks the
remaining max. Working staging now supports valid simple product/machine-type
bounds; malformed rules and nested unsupported contexts still fail, and backend
placement validation remains mandatory. Boundary tests pass16 combined clone/copy
tests. Native UI cloning request and opening its linked editor were captured;
full settled shared-state evidence is still being collected.

MCP clone+export of SN2201 now succeeds (prepare2 terminal11056), evidence
`artifacts/linked-destination-audit-2026-10-30/prepared.json` and tool responses.
No full clone/browser handoff claim yet. Native linked cable-edit capture LIVE
session99511, log `/tmp/dcsc-linked-destination-capture3.log`; don't restart it
on timeout. Full local check LIVE session88410, log
`/tmp/dcsc-capacity-clone-check.log`. Linked destination manual creation guard
remains; HPC linked switch edits are still unsupported until native contract
capture and implementation. Frozen matrix97956 remains live (last command23
storage). Goal active; full parity/release remain incomplete.

## Linked manual source creation implemented and verified (2026-10-30)

New source-port selections now propagate across the entire linked configuration
group, matching captured native shared-topology ownership. Pure staging validates
the connector on every member without mutating input; the service commits shared
selections, cable graph and BOM atomically. Discovery and creation expose
sourceConfigurationIds; creation reports additionalConnectionCount for routes
DCSC adds as a consequence of shared source selection. Destination linked groups,
managed physical aliases and breakout connections remain unsupported/unverified.

First live attempt rolled back correctly: native Auto-Connect added a sibling
route, requiring4 AV1Z cables versus3 predicted from explicit seeds. Captured
request/response and derive evidence: `artifacts/linked-manual-source-audit-2026-10-30/api-probe/`.
Reconciliation now stages quantity from the complete accepted graph before
workspace derive; final quantity and route retention guards remain in force.

Maintained linked-source gate PASS11MCPcalls,5pinned routes,7final connections,
4AV1Z cables; both linked nodes retain QSFP56 ports1+2 and clone ownership is
unchanged. Immediate SIGKILL/restart, export, fresh headless browser commercial
and completed physical connection parity pass. Evidence:
`artifacts/parity-manual-create/2026-10-30-linked-source-run2/report.json`.
Added output metadata assertions were also applied directly to saved call009:
2sourceConfigurationIds and1additionalConnectionCount. Native topology evidence
is reduced into `test/fixtures/parity/linked-source-port-native.json`.

Full check passes929 tests/122files,17contracts,build and81-tool startup. Updated
native-fixture suite12 passes separately; final typecheck/lint pass. Linked-group undo/redo and additional-route
quantity regression tests pass. Live linked source scope is100GbE copper; don't
infer all protocols from this gate. Added parity:manual-create:linked-source;
working release inventory70, frozen release inventory remains69.

Direct Management creation regression is LIVE in exec session97583 (serialized
headless lock), log `/tmp/dcsc-manual-create-regression.log`, output directory
`artifacts/parity-manual-create/2026-10-30-shared-source-regression`. Poll that
same process; do not restart on timeout.

Frozen matrix session97956 remains LIVE at command19 lfo-as-cto. Known audit
failure belongs to its old dependency snapshot; verify-fixes declared blocked2.
No full release or full website-parity claim. Goal active.

## Linked manual source-port ownership captured (2026-10-30)

Native headless import of nested-grouped-native.xml, followed by invoking the
loaded website updateSelectedTopologiesById action through reduxInterceptor,
confirms that selecting Management RJ45 mgmt port1 on one linked SD535 node
updates selectedTopologies for BOTH linked nodes. Exactly one shared database
record changes (id and selectedTopologies); all private binding records are
unchanged. This is native action/state evidence, not a user-interface gesture or
an end-to-end manual cable success. Report assertions pass.
Evidence: `artifacts/linked-manual-source-audit-2026-10-30/` (capture.ts,
capture.json, report.json and frontend action/persistence excerpts).

Next implementation must propagate source topology selection atomically across
the linked group, matching shared ownership, then verify complete cable graph,
commercial quantities, restart and browser reimport. Current public linked-source
new-port guard remains intact pending that implementation and full live gate.
Do not classify this as an unsupported DCSC API.

Dependency remediation live contracts now pass89/89 (session32381 terminal0).
Frozen full matrix session97956 still LIVE: conformance command12 passed;
command13 verify-fixes running at latest observation. Source remains frozen.
No release/full parity claim. No browser probe remains running.

## Dependency remediation after frozen snapshot (2026-10-30)

Working checkout now uses Zod4.6.7, @hono/node-server2.1.5,
body-parser2.4.0, fast-uri3.1.9 and Vite6.4.5. Fresh npm audit passes
with zero findings; evidence: `artifacts/release-2026-10-30/dependency-audit-remediated.json`.
The frozen release checkout remains unchanged and its audit failure remains valid.

Zod migration preserves nested config defaults with `.prefault({})` and declares
string keys for the solution-mode boolean record. Added two config regressions
covering omitted sections, partial overrides and invalid explicit values.
`npm run check` passed924 tests/121files,17contracts,build and81-tool stdio startup;
the two newly added tests pass separately (926 total across these runs).
Final typecheck/lint also pass. Logs: `dependency-remediation-check.log` and
`config-defaults-check.log` in the release artifact directory.

Live contracts for the remediated checkout finished exit0:89 passed,0failed.
Evidence: `artifacts/release-2026-10-30/dependency-remediation-live-contract.log`.
Full frozen matrix session97956 remains LIVE,
last observed at command12 conformance, with earlier audit failure. Do not restart
either run because of an observation timeout. No full parity/release claim.

## Expanded source-frozen release matrix running (2026-10-30)

Preflight exposed an obsolete assumption: review docs are now tracked, while
release-checkpoint required them to be ignored. Fixed the supplemental collection
to include only actually ignored review docs; tracked/untracked docs travel in
the ordinary patch/input lists. Tests cover both states, content tampering and
unexpected source paths. Both tests, typecheck and lint pass. No weakening of
manifest verification was introduced.

Snapshot materialized in `/tmp/lenovo-dcsc-release-2026-10-30` (detached worktree).
Manifest: `artifacts/release-2026-10-30/preflight/manifest.json`.
HEAD `b96632af793ad4f31f0724f2f8486ff411d1611d`; tracked patch SHA256
`8c18f3af8e88b4cd339769f4961445c101a43ec24256d50497b727125e86c930`.
47 untracked inputs,99 literal fixture dependencies, no missing/ignored runtime
inputs. `npm ci` and materialized manifest verification passed. Do not edit this
frozen checkout or manifest while the run is active. The working checkout may
continue to change, but any final new source requires its own verification.

**LIVE runner exec session97956**: copied/audited executor
`artifacts/release-2026-10-30/run-release-matrix.mjs`, master log
`/tmp/dcsc-release-matrix-2026-10-30.log`, authoritative progress/report
`artifacts/release-2026-10-30/results/report.json`. Poll that same handle or inspect
its live process; never restart solely on observation timeout. Runner executes all
69commands serially, records exit0/declared blocked exits/failures separately and
verifies source before/after. At last observation: before-verification PASS,
typecheck/lint PASS, command3 `npm test` running. No release conclusion yet.
Child artifacts live under the frozen checkout's `artifacts/` directory; preserve
that worktree until evidence has been collected. Headless cases use the existing
`/tmp/lenovo-dcsc-headless.lock`.

Install audit found5 current dependency findings (3moderate,2high): @hono/node-server,
body-parser,fast-uri,vite,zod. Details in
`artifacts/release-2026-10-30/dependency-audit-before-matrix.json`. Zod's offered fix
is a major upgrade to4.6.7. No automatic dependency upgrade was applied. The audit
matrix gate is expected to fail until separately tested remediation is completed;
that must not be reported as an API blocker or a passing release.

Goal active. This is baseline integration evidence, not full website parity.
Managed aliases, linked cabling ownership, breakout connections, legacy recovery,
broader physical/product coverage and authenticated flows remain unfinished.

## Copy from linked chassis members implemented and verified (2026-10-30)

Native browser Copy(number1) from the second/member D3 chassis succeeds. All old
workspaceBindingIds groups remain unchanged; the copied chassis and node each get
new singleton bindings. Native requests use the original pre-copy dependency map,
as for root Copy. Evidence: `artifacts/linked-member-copy-audit-2026-10-30/`, including
report.json, requests and before/after browser database captures.

`stageRackedCopy` now preserves source parent/child groups under their original
roots when a selected source is a member. It no longer rejects member sources or
creates a duplicate dependency entry under the member ID. New copies remain
independent. Added reduced native fixture `chassis-member-copy-native.json` and
root/member staging regressions; physical-copy suite9 passes. Existing placement,
identity and nesting validation stays in force.

Actual stdio gate `--member-copy` passes8calls,max6840bytes:8configs,3chassis/3nodes,
all original groups retained, undo/redo, independent copied-node processor edit
without changing other raw configurations, restart and complete browser reimport
with commercial/physical/floor parity. Evidence:
`artifacts/parity-nested-grouped-import/2026-10-30-member-copy-run1/report.json`.
Added `parity:chassis-member-copy`; release inventory now69commands. Tool guidance
and README accept root or member handles. Verified nested scope is D3/SD535;
other shapes, managed storage and VLH require separate evidence.

Full `npm run check` passed923 tests/121files,17contracts,build and81-tool startup.
Final typecheck/lint also pass. All capture/gate/check processes from this increment
are terminal exit0; no live process remains. Full69-command release matrix remains
open. Goal active. Managed aliases, linked cabling ownership, breakout connections,
legacy recovery and broader physical/product coverage remain unfinished.

Unclone investigation: captured frontend defines handlers, but both ordinary rack
and non-rack menu render functions construct then discard the Unclone element.
Do not infer an exposed website operation or API impossibility from those handlers.
Member Copy was confirmed as an exposed working action and implemented instead.

## Native manual cable choices validated against fabric catalog (2026-10-30)

`filterNativeManualCableChoices` intersects calculateDistance choices with current
Lenovo catalog feature/option identity, requested topology and supported point-to-point
categories (ACC, AOC, Cat5E, Cat6, DAC). Unknown, contradictory, wrong-speed and
breakout/splitter categories are excluded. Creation independently repeats the check;
a stale or manually supplied incompatible part cannot bypass discovery. Discovery
rechecks workspace revision after the catalog read. This changes native creation,
not the existing-row editor. Breakout creation remains a separate unimplemented
connection model; excluding it here does not establish website/API unavailability.

The live SN3420 100GbE_Copper distance case previously exposed34 mixed choices.
Current public discovery returns exactly3 eligible DACs: AV1Z, AV20, AV21. AT2R,
AV22 and A1DL are absent. Added reduced native catalog fixture and regressions for
wrong topology, breakout exclusion, option mismatch, immutable input and rejection
before any write request. Tool descriptions now state verified Management/100GbE
scope and unsupported linked/alias/splitter cases accurately.

Both actual stdio creation gates pass crash/restart, cable quantities, export and
completed browser reimport with the catalog filter:
- `artifacts/parity-manual-create/2026-10-30-management-catalog-run1/report.json`:6calls.
- `artifacts/parity-manual-create/2026-10-30-100g-catalog-run1/report.json`:10calls,
  4connections,3pinned routes. Discovery artifact007 records all3 eligible choices.
Maintained 100G gate now also asserts known wrong-speed/breakout parts are absent;
the same assertion was checked directly against this run's saved output.

Full check passed922 tests/121files,17contracts,typecheck,lint,build and81-tool startup.
Final typecheck/lint passed after tool-description and gate-assertion updates.
Logs copied into the100g evidence directory. All three validation processes are
terminal exit0; no live process remains from this increment. Toolcount81 and release
inventory68 unchanged. Full release matrix and broader parity remain open.

## Manual 100 GbE creation: connector and physical quantity preservation (2026-10-30)

Native manual creation now selects the added source port, matching the frontend's
`preserveManualConnectionsInSelectedTopologies` behavior. It also stages an existing
physical cable quantity before configure and restores that quantity after seeded
Auto-Connect before workspace derive. Evidence showed Auto-Connect preserving the
four-row graph while returning the old one-cable physical row; that old row overrode
the accepted two-cable configuration during derive. Do not remove the BOM acceptance
guard or merely relabel a returned row. Linked sources that need a new selected port
remain rejected consistently in discovery and creation pending shared-group semantics.

A live SR630 V3 BPPX adapter + SN3420 switch case now passes in-memory MCP creation,
AV1Z quantity2, export and completed browser reimport with all four routes retained.
Evidence `artifacts/manual-data-network-audit-2026-10-30/report.json`, accepted.json,
endpoint request/response captures and frontend-preserve-source-ports.js.txt.
An earlier SN2201 uplink attempt returned 1GbE_Copper instead of requested
100GbE_Copper and was rolled back. Its catalog supports 1GbE host networking only.
Graph mismatch errors now report unambiguous returned topology/cable changes.
Distance choices can include other speeds/breakout parts; catalog cross-validation
remains a follow-up, not verified merely by inclusion in compatibleCables.

Maintained runner gained `--create --100g`, command `parity:manual-create:100g` and
release inventory entry (68commands). It configures the adapter and catalog switch,
starts from one accepted data cable, creates a second manual route, checks qty2,
SIGKILL/restart, exports and completes fresh-browser import. Actual stdio gate
PASSED10 MCPcalls with4connections and3pinned routes:
`artifacts/parity-manual-create/2026-10-30-100g-run1/report.json`.
Exec session32039 is terminal exit0. All live processes from this increment ended.

Management native creation regression passes all6 MCPcalls, SIGKILL/restart and
browser import at `artifacts/parity-manual-create/2026-10-30-source-ports-run1/`.
Full check passed920 tests/121files,17contracts,build,81-tool stdio startup; subsequent
focused native/service26tests, typecheck and lint pass after final service changes.
Full68-command release matrix has not run. Goal active; other parity gaps remain.

## Linked-node Delete Node encounters native frontend failure (2026-10-30)

Isolated headless browser imported `nested-grouped-native.xml`, right-clicked the
first/root node, awaited its Delete Node menu, and clicked it. The website threw
`Cannot read properties of undefined (reading 'id')` after the click. Before/after
browser configuration and workspace-item databases are identical. No post-click
customize/derive was observed; the two captured requests belong to import.
A dialog accept handler was installed; no confirmation dialog appeared.

Evidence: `artifacts/linked-node-detach-audit-2026-10-30/report.json`, capture.log,
before/after-database.json, requests.json and frontend-delete-node.js.txt. Frontend
helper `deleteNodeInEachChassis` in HPC mode seeks a non-root related node in each
related chassis, then dereferences the result without checking it. This explains
the observed error for this one-node-per-linked-chassis shape. This is a scoped
frontend failure, not proof that the API cannot detach linked nodes. Keep the
existing service guard until a successful native contract is available; do not
simply remove one identity from a linked group. No production behavior changed.
Next candidates: member-node case or independent chassis with multiple linked
nodes, where the helper can find a non-root node, plus remaining managed-alias
cabling and broader protocol parity. Legacy workbook input remains unverified.

## Expanded conformance passed; legacy recovery API reachable (2026-10-30)

Conformance run3 (exec session28766) is terminal exit0: **180/180 checks passed**.
Evidence copied to `artifacts/cabling-recovery-2026-10-30/conformance-run3.log`.
This supersedes the pending run3 status below; the full67-command release matrix
has not been rerun. No remaining live process from this increment.

A direct `DcscHttpClient.send` probe of `/connection_recovery`, using captured
modern rack/configuration inputs and empty `connectionData`, returned HTTP200,
empty connections/errors/cableResults and existing selected topologies. Live
response key is **selectedStorageNetworks** (plural); captured frontend reads
selectedStorageNetwork (singular). Future integration must account for actual
wire behavior rather than blindly copying frontend spelling.

Frontend recovery action requires connectionData, autoConnectSettings,
cloneRackMapping, clusterFloor (floorPreference plus floorArray), clusterPreference,
storageConnectionNetworks, switchMap, rackArea, configurations, powerPreference,
and cloneDependency. It applies returned selected topologies, storage selections
and cableResults to configurations as well as the connection graph. Raw action
extract and request/response controls are in `artifacts/cabling-recovery-2026-10-30/`.
A synthetic modern connection augmented with inferred legacy coordinate/position
fields returned HTTP500. This is not a genuine legacy workbook control and proves
neither successful recovery nor API unavailability. Do not ship guessed recovery
schema. Next requirement: obtain actual successful `/excel_import` connectionData
or a native legacy import capture, then verify recovered graph and cable BOM.
The API is reachable; the missing piece is validated nonempty legacy input.

## Linked-root populated chassis Copy implemented (2026-10-30)

`stageRackedCopy` now accepts group roots, preserves original parent and child
clone groups, and adds independent singleton copy groups. Clone-member sources
still direct callers to their root; member-source native semantics remain unverified.
The native pre-copy dependency request already used by `copyRackItem` is retained.
Matched native physical request in new minimal fixture
`test/fixtures/parity/chassis-linked-copy-native.json`. Before geometry comes from
existing items in the native Copy request, where the frontend has normalized node
size; raw initial import/customize responses contain a different size shape.

`--linked-copy` in `scripts/parity-nested-grouped-import.ts` passes actual MCP Copy,
preserved old groups, undo/redo, independent copied-node processor edit with all
original raw configurations unchanged, SIGKILL/restart, export and completed fresh
browser import with commercial/physical parity. Evidence:
`artifacts/parity-nested-grouped-import/2026-10-30-linked-copy-run1/report.json`
(8calls,max6840bytes,8configs,3chassis/3nodes). Added `parity:chassis-linked-copy`
and release inventory entry (67commands), tool guidance and README support wording.

Full `npm run check` passed917 tests/121files,17contracts,typecheck,lint,build,
81-tool startup. Log copied into that gate's evidence directory. Focused Copy
suite16 tests passes. Scope proven: root-source D3/SD535 linked populated chassis.
Broader shapes and member-source Copy are not claimed verified.

Conformance run2 terminated179/180; only old endpoint-ID test failed. Both fixes
(explicit manual mode and using discovered configurationId) are now in source;
run3 is LIVE via exec session28766, log `/tmp/dcsc-expanded-conformance-run3.log`.
Poll that handle rather than restarting. At last inspection local planning and
native manual creation both pass and no FAIL lines appear, but no terminal
conformance verdict yet. All Copy/local-check processes are terminal. Goal remains
active; legacy workbook recovery, managed-alias cabling, broader physical/protocol
matrix and authenticated workflows remain open.

## Next implementable gap: Copy from linked chassis root (2026-10-30)

Native headless capture completed Copy(number1) from the grouped D3 root. Original
chassis and node shared binding groups both remain intact. New independent chassis
and node singleton groups appear; names Copy_Chassis and Copy_Copy_Node, placement
U5 after originals U1/U3. Native customize request carries pre-copy cloneDependency.
Evidence: `artifacts/linked-source-copy-audit-2026-10-30/confirmed/report.json`,
requests.json, before/after database. Initial capture stopped at Copy's confirmation
dialog; confirmed capture clicks OK and proves the mutation. All browser processes
are terminal.

Implementation remains pending. `stageRackedCopy` currently rejects any linked
source or child; its singleton assignments would break original groups if guards
were merely removed. Preserve original source/child groups and create singleton
copy groups, retaining pre-copy dependency wire as in existing Copy service.
Native evidence is root-source only; clone-member Copy needs separate verification.
Add regression plus a live copied-node independent edit with originals unchanged,
history, restart and browser export parity. Conformance run2 remains live (15801),
with its one already-fixed stale local-planning endpoint-ID failure; poll it before
any rerun. Latest local-planning regression6 tests/typecheck/lint/build/startup pass.

## Linked HPC chassis edits implemented and verified (2026-10-30)

Native browser D3 root POWERSUPPLY C2NC quantity2 capture proves root-only request
configurations/no entranceFlag, full chassis group update, and a dependent node
response targeting only its root. Before/after browser database confirms that
child response updates shareData bound to both child IDs. Evidence:
`artifacts/hpc-linked-parent-audit-2026-10-30/{requests,before-database,after-database}.json`.
Maintained minimal fixture `test/fixtures/parity/hpc-linked-chassis-edit.json`.

Extended linked configure to matching HPC chassis groups. Only explicitly known
child groups of the edited chassis may accept native root-only dependent updates;
the edited group still requires full target coverage. Foreign/partial other
responses remain rejected. Dependent updates require whole-workspace undo.

Both maintained gates pass member-initiated PSU edit, both chassis selections,
unrelated-state preservation, complete undo/redo, SIGKILL/restart and fresh-browser
commercial/physical export handoff:
- Imported group: `artifacts/parity-nested-grouped-import/2026-10-30-parent-edit-run1/report.json` (6calls).
- Fresh Clone Multiple: `artifacts/parity-nested-grouped-import/2026-10-30-fresh-parent-edit-run1/report.json` (9calls).
New command `parity:chassis-parent-edit` accepts `--clone`; added one release gate,
current inventory66. Focused25 tests passed. Full check915 tests/121files,
17contracts,typecheck,lint,build and81-tool startup passed before the small ID
addition below. `/tmp/dcsc-linked-parent-check.log`.

Conformance run1 completed179/180 with all81 tools called successfully, including
native manual creation; only the old local-planning test failed (omitted manual
mode). Run2 is STILL RUNNING via exec session15801, log
`/tmp/dcsc-expanded-conformance-run2.log`; poll this same handle, do not restart.
It exposed the same test's next stale argument: session handles used as endpoint
configuration IDs. `dcsc_session_list` itself omitted configurationId despite the
error directing callers there. Added that field and fixed conformance to consume
it. A focused tool test proves discovered ID -> explicit local link, no HTTP;
6 tests pass, typecheck/lint pass. Run2 loaded the older code and will retain that
one known failure. Do not claim clean conformance; inspect all terminal results
before deciding a further corrected rerun. Browser investigations and both chassis
gates are terminal. Final build/startup after ID addition passed; see `/tmp/dcsc-linked-parent-final-build.log`. The only live process is conformance run2 (session15801).

## Native manual creation with preserved routes: maintained gate passes (2026-10-30)

Added explicit `pinExistingRoutes` (defaultfalse). Opt-in changes only prior AUTO
NETWORK rows to native MANUAL rows before seeding; all endpoints/cables remain
unchanged. Discovery reports `pinnableConnectionCount` and explains ownership;
creation returns committed `pinnedConnectionCount`. No post-response relabeling.
Unpinned rerouting still rejects atomically. Tests cover opt-in only, unaffected
POWER/manual rows, nonmutation and undo restoring AUTO ownership.

Positive direct API pinning probe and public free-port creation passed. The latter
uses unchanged imported rows and the source's free RJ45 port1, alongside its
occupied RJ45 mgmt port1. No private graph clearing. All three rows and commercial
selections/prices survive completed fresh-browser import.

Maintained `npm run parity:manual-create -- --out artifacts/parity-manual-create/2026-10-30-run2`
passes6 actual stdio MCP calls: public import/discovery/create, immediate SIGKILL,
restart with identical persisted snapshot, export, fresh-browser physical graph
and commercial comparisons. Report: `artifacts/parity-manual-create/2026-10-30-run2/report.json`.
Fixture has one AUTO and one already MANUAL row; exactlyone is pinned. Initial
run1 had an erroneous expected count2; run2 derives expected count from starting
rows and passes. Do not count run1 as a production failure.

Added gate to package scripts and release inventory (65commands) and added both
new tools to conformance's public populated-graph creation scenario. Full live
conformance/matrix not rerun. Focused30 tests (4files),typecheck,lint,build and81-tool startup pass;
previous full check911 tests remains prior to the two new pin regressions.
Scope still direct CTO endpoints / Management. Linked destinations, managed
aliases, broader protocols and default-AutoConnect manual retention semantics
remain distinct investigations; default regeneration intentionally clears seeds.
Other parity backlog (legacy workbook recovery, linked chassis parent editing,
storage generation, authenticated flows) remains active.

## Public native manual tools and append evidence (2026-10-30)

Registered `dcsc_manual_cabling_options` and `dcsc_create_cabling_connection`;
server count81. Discovery calculates distance, resolves compatible destination BOM
choices, pages results and guards revisions before/after HTTP without mutation.
Creation uses the atomic service. Updated older tool guidance and README.
Full `npm run check` passes911 tests/121files,17 contracts,typecheck,lint,build,
81-tool startup. Log `/tmp/dcsc-public-manual-check.log`.

Public MCP protocol (in-memory transport), persisted snapshot reload, XML export
and fresh completed headless website import pass for an isolated pre-generation
graph: `artifacts/manual-row-api-audit-2026-10-30/public-create-roundtrip/report.json`.
Browser launch initially failed because the installed Playwright expected missing
Chromium1234; installed browser and resumed ONLY saved XML import using
`resume-public-browser.ts`. No repeated mutation for that recovery.

CRITICAL next evidence: `public-append-roundtrip/report.json` fails safely.
Requested old AUTO Management row source3c3c/destinationport3 + new MANUAL row
sourceac16/destinationport20. Lenovo retains MANUAL20 but regenerates old AUTO
onto port2. The transaction rejects exact retention and does not commit. Thus
seeded AUTO rows are not routing constraints. Investigate explicitly pinning
existing AUTO network rows as MANUAL (with clear returned count/tool semantics)
or a native preserve flag; do not silently accept rerouting or relabel accepted
rows locally. No claim of full populated-graph creation support yet.

Also next: genuine all-public workflow without clearing imported rows. Both source
servers expose free `RJ45` port1 in addition to occupied `RJ45 mgmt` port1, both
1GbE_Copper. Try new connection from free RJ45 with unchanged existing graph;
may need source network connector selection. Current probes clear some/all graph
rows in isolated setup, not through public tools. Actual process-kill/restart,
maintained parity script and conformance coverage for two new tools remain pending.
Conformance dynamically requires all tools; it has not yet been updated/run for
these two tools. All probe/check/install processes are terminal.

## Transactional native manual creation service (2026-10-30)

Implemented `DcscService.createNativeManualCabling` as one workspace transaction:
revision/network assignment/occupancy checks, native distance, cable selection
addition, explicit seeded Auto-Connect, exact row retention and final BOM coverage.
Default Auto-Connect continues dropping prior graphs. Seeded creation skips automatic
switch provisioning because endpoints must already exist. Linked destination groups
and managed aliases remain explicitly unsupported pending ownership evidence.

Live service probe passes export and completed fresh-browser import with selected
parts/quantities/prices parity and previously absent3791 addition:
`artifacts/manual-row-api-audit-2026-10-30/service-create-roundtrip/report.json`.
The probe clears only old graph rows in an isolated imported workspace; it preserves
networkingInformation (cluster preferences and switchMap). Earlier failed probes
had deleted that whole object, causing Lenovo to return no rows. This is corrected.

Distance choices can have source ctoCode and empty selectionGroups; resolve those
against exactly one destination catalog section containing the compatible part.
Native accepted rows have destination ownership metadata. New planner regression
covers that shape. Focused domain/adapter/service suite26 tests passes; the later
service history run14 tests passes, including rollback if the final derive drops
the cable, stale/unassigned requests and workspace undo/redo. Typecheck/lint pass.
Logs copied into the service probe directory. No public create tool is registered
and the current tool count remains79. Next: endpoint/cable discovery plus public
registration, actual MCP-call/live append-to-existing-graph coverage, persistence/
restart and maintained parity gate. No live process remains running.

## Native manual cable BOM addition verified (2026-10-30)

Fresh live probe `artifacts/manual-row-api-audit-2026-10-30/new-cable-roundtrip/report.json`
passes with previously absent cable3791. Explicit configuration derive adds quantity1,
preserving every previous selection; seeded Auto-Connect and workspace derive retain
the constructed MANUAL row on destination port20. XML export and completed isolated
headless website import preserve that row; selected parts, quantities and total
prices match the MCP workspace. This closes the API-feasibility question for the
tested direct-configuration Management case: the missing BOM addition can be
orchestrated through existing APIs. It does not establish arbitrary protocol,
managed alias or splitter support, or public tool completion.

Added `planNativeManualCableSelection`: accepted P2P graph usage determines the
minimum quantity while preserving existing spares. Rejects ambiguous sections,
part ownership, duplicate selections and split-cable quantities. Four constructor/
BOM tests, typecheck and lint pass. Logs: `/tmp/dcsc-manual-bom-tests.log` and
`/tmp/dcsc-manual-bom-static.log`. The planner is not yet wired into the service.

Next: explicit native-create operation with actual occupancy/network validation,
opt-in seeded Auto-Connect (default regeneration unchanged), exact requested-row
retention, BOM reconcile and acceptance in one transaction, tool discovery and
undo/restart/live verification. Probe used empty graph only for constructor
occupancy checks and two separate transactions; it is feasibility evidence, not
the final atomic implementation. Source is `new-cable-roundtrip.ts` beside its
output directory. No running probe process remains.

## Native manual row construction and handoff (2026-10-30)

Added `stageNativeManualConnection` in `src/domain/nativeManualCabling.ts`.
It builds a complete native row from discovered placed ports and an authoritative
calculateDistance response, requiring compatible endpoint topologies, a listed
cable part, matching distance endpoints and free ports. It does not require an
existing connection template. Two focused regressions, typecheck and lint pass.
A bare endpoint-only API row fails HTTP500; the complete constructor shape works.

Live isolated probes: `artifacts/manual-row-api-audit-2026-10-30/roundtrip/`,
`constructed-roundtrip/`, `alternate-cable-roundtrip/`. Full-template and
constructed rows survive derivation, XML export and completed fresh-browser
import. Alternate 3802 cable row also passes selected-part/price parity on
reimport, but 3802 was already selected in the source design.

CRITICAL remaining implementation gap: constructed MANUAL row3791 survives the
graph roundtrip while the destination ETHERNET_CABLE selections omit3791.
Auto-Connect graph acceptance does not reliably add a new manual cable part to
the BOM. Do not expose native creation until service orchestration explicitly
adds the requested part/quantity, preserves existing cable quantities and
verifies graph plus commercial acceptance atomically. Public tool/discovery,
revision/history/restart coverage and a genuinely absent-cable-part live case
remain pending. Probe construction used an empty graph for occupancy checking;
a public operation must validate against actual current connections.

## Native manual connection API path discovered (2026-10-30)

User clarified manual connection creation is the likely complaint. A fresh
positive/negative-control investigation now demonstrates an implementable lead:
`POST /auto_connect` accepts a supplied `connections` graph even though the SPA's
normal regeneration omits it. Starting with a fresh two-row Management control,
a MANUAL row targeting switch port20 is retained exactly. A nonexistent source
is discarded; an impossible port99999 is replaced by an AUTO connection on port2.
The backend therefore does more than blindly echo supplied graph rows, but
silently regenerating invalid rows means any new operation must validate exact
requested endpoint/cable retention before committing.

Evidence: `artifacts/manual-row-api-audit-2026-10-30/summary.json`, requests and
responses. Maintained reduced fixture: `test/fixtures/parity/manual-row-seeding.json`.
All live requests use DcscHttpClient. This was an isolated, nonpersistent probe.
No native manual-create tool is implemented yet. The seed reused an existing
native row shape; from-scratch row construction, compatible cable selections,
BOM/price effects, undo/restart and native export/reimport still need proof.
Next implement and verify an explicit native manual creation workflow without
changing default Auto-Connect regeneration or relabeling local planning links.
The previous blanket uncertainty is narrowed: row seeding is accepted for this
Management case; broad protocol/product coverage and UI Add-row parity remain
unproven. Do not call the remaining gap an API impossibility.

## Manual cabling clarification and mode validation (2026-10-30)

User clarified the complaint was likely manual connection creation. Found and
fixed a concrete tool ambiguity: manual endpoint/cable fields supplied with the
default or explicit auto mode were silently ignored while whole-workspace native
Auto-Connect ran. Such calls now reject before HTTP or state changes, explain
that manual mode is local-only and excluded from Lenovo exports, and point to
existing native row editing. Six focused tests, typecheck, lint, build and
79-tool startup pass. No live requests were needed for this pre-request guard.

Native bundle has a `Manual Cable` networking preference (already supported by
customCableId=manual-cable) and a handler that preserves connector selections
for edited connection rows. These do not establish arbitrary new-row creation.
Legacy workbook recovery consumes imported connectionData; it remains separate
and unimplemented. No conclusion of API impossibility is justified. Evidence:
`artifacts/manual-connection-audit-2026-10-30/`. The original user complaint's
exact website click sequence remains unknown; do not equate local planning
links or fixed cable preferences with native manual connection creation.

## Linked HPC node edits after chassis cloning (2026-10-30)

Implemented native root-only requests without GP entranceFlag, plus ordered
HPC shared-root responses. Each response validates the known product/root and
target subset; the union must cover its complete clone group. The last record
supplies shared data, matching the captured browser database, including null
power data. Only the edited node group and its physical parent chassis groups
are accepted. Parent and child updates commit together; dependent parent edits
require workspace undo rather than a partial configuration-only restoration.

Native captures: `artifacts/hpc-linked-edit-audit-2026-10-30/`, including
`fresh-clone/native-edit-requests.json` and `native-edited-database.json`.
Maintained fixtures: `hpc-linked-node-edit.json`, `hpc-fresh-clone-edit.json`.
Live clone-edit-run4 passes fresh Clone Multiple, member-initiated processor edit
(C2A3), both linked node selections, unchanged unrelated rack/spare, verified
restart and fresh-browser export/reimport with commercial/physical parity:
`artifacts/parity-nested-grouped-import/2026-10-30-clone-edit-run4/report.json`
(eight calls, max6839 bytes). Run5 also passes undo/redo around the linked edit
itself, restoring all parent/node raw configurations before restart and native
export/reimport: `2026-10-30-clone-edit-run5/report.json` (ten calls, max6839 bytes). Domain/service regressions cover ordered native
responses, target coverage/foreign-target rejection and dependent parent undo.
Full offline check passes 895 tests / 120 files, 17 contracts, typecheck, lint,
build and 79-tool startup; final static checks also pass. Logs are retained in
clone-edit-run5. Native parent/chassis editing, linked-source
Copy, broader containers and heterogeneous groups remain separate coverage gaps.

## Populated chassis Copy: confirmed implementable gap (2026-10-30)

Fresh headless native D3/SD535 Copy succeeds in HPC and AI - Systems. It adds
one chassis at U3 and one nested node, prefixes both names with `Copy_`, and
retains the pre-copy dependency map without linking the new identities to their
sources. Both Copy and subsequent summary use rack customize; no post-Copy
autoDerive was captured. The completed response retains both populated chassis,
and native XML/XLSX export succeeds. This is a confirmed MCP limitation, not an
API absence. The implementation now stages independent parent/child identities,
Copy_ names and singleton commercial groups, uses the pre-copy native request
groups, reprices fillers and checks exact nested acceptance transactionally.
Focused domain/service checks pass 22 tests, including dropped-child rollback,
undo/redo and the captured topology. Full check passes 892 tests / 120 files,
17 contracts, typecheck, lint, build and 79-tool startup. Live Copy parity run1
passes creation, selected parts/prices, physical topology, undo/redo, verified
restart and fresh-browser export/reimport (six calls, max6838 bytes). Evidence:
`artifacts/parity-nested-grouped-import/2026-10-30-copy-run1/report.json`.
The extended copy-edit-run1 also passes an independent copied-node processor
change (C2A3, AMD EPYC 9475F): original nested-node raw configuration unchanged,
requested selection retained, separate singleton dependency groups, verified
restart and fresh-browser export/reimport commercial/physical parity. Evidence:
`artifacts/parity-nested-grouped-import/2026-10-30-copy-edit-run1/`
(`independent-edit.json`, `report.json`; eight calls, max6838 bytes).
The maintained Copy gate now always checks this edit. Final typecheck/lint pass.
Linked-source Copy and broader chassis shapes still need implementation or
live coverage. Release inventory has 64 commands.

Evidence: `artifacts/nested-copy-audit-2026-10-30/report.json`,
`copy-requests.json`, `native-copied.xml`. Reduced maintained evidence:
`test/fixtures/parity/chassis-copy-native.json` (now covered by a staging regression).
Native exported oracle: `test/fixtures/parity/xml/nested-copied-native.xml`.
Live command: `npm run parity:chassis-copy`.

## Grouped populated-chassis import (2026-10-30)

Native D3 Clone Multiple was captured creating a second populated chassis at
U3 beside U1, with a separate linked node group. Reimporting Lenovo's export
returns chassis quantity two / two originalIds and node quantity one per
parent / two originalIds. The MCP now expands both levels and assigns child
IDs using the native per-parent ordering. It retains original provenance plus
parent quantity for safe ownership restoration. Unsupported deeper containers,
VLH and malformed child identity counts still reject atomically; existing
singleton imports may omit originalIds.

`parity:nested-grouped-import` run1 passes the real stdio import, all six
configurations, correct two-parent/two-node topology, selected parts/prices,
verified crash restart, export and fresh-browser completed import. Exact
parent-multiplied commercial assertions also pass against both captured native
responses. Evidence: `artifacts/parity-nested-grouped-import/2026-10-30-run1/`.
Fixtures: `nested-grouped-import.json` and `xml/nested-grouped-native.xml`.
Populated-chassis Clone Multiple is also implemented through the existing
`dcsc_clone_configuration` same-rack mode. It creates each child configuration,
extends separate parent/node groups, validates accepted identities/containment,
and commits transactionally. Native capture uses rack customize without
additional auto-derive; the latter produced duplicate derived child root IDs.
The native local filler-price update is reproduced using offered catalog prices
and typed price deltas; missing prices remain explicitly unavailable. Tests
cover identity collisions, incomplete child maps and rollback if Lenovo drops
a cloned child, plus the captured $30 filler reduction.

`parity:chassis-clone` run4 passes real creation, undo/redo, verified crash
restart, export and native completed reimport with commercial and physical
parity. Evidence: `artifacts/parity-nested-grouped-import/2026-10-30-clone-run4/`.
Linked-source Copy and broader multi-node/heterogeneous/VLH/rack cloning still need
implementation or expanded live coverage; do not generalize this D3 case.
Final full check passes 889 tests / 120 files, 17 contracts, typecheck, lint,
build and 79-tool startup; see `2026-10-30-clone-run4/check.log`. This includes
the exact nested acceptance guard and identity collision scan across both
racked and loose-container nodes. Live run4 verifies the native D3 workflow;
it does not establish full parity across the remaining shape matrix.

## Storage regression and cabling creation scope (2026-10-30)

After grouped-import and MGX fixes, `parity:storage-placement` passes all 99
real MCP calls: repeated managed placements, assignment/clearing, physical
moves, undo, controller and SAN edits, network detachment, group unplacement
and exports. Fresh-browser first-placement and detached imports also pass
physical/commercial comparisons. Evidence:
`artifacts/parity-storage-placement/2026-10-30-regression/report.json` and
`browser-reimport/report.json`. These verify storage layout and commercial
handoff, not populated FC/iSCSI cable generation.

The cabling tool title now distinguishes native generation from local planning;
its description identifies Auto-Connect as the only *implemented* native
creation path rather than implying every DCSC API alternative is impossible.
Fresh browser cabling-panel inspection and captured frontend handler review
show two populated Management rows with Edit buttons; the edit panel exposes
source/destination ports, cable choice and Save/Close. No Add/Delete-row action
was present in this tested panel. This is scoped UI evidence, not proof of API
absence. `/connection_recovery` remains a
separate workbook recovery flow, not established arbitrary creation. Evidence:
`artifacts/cabling-actions-2026-10-30/`. Build and 79-tool stdio smoke pass.

## Compressed rack groups: confirmed MCP gap (2026-10-30)

Replayed the October 16 native Customize response for SID0001325 through
current `expandImportedClones`. Its rack contains compressed groups of 18
compute trays, nine NVLink switches and two Ethernet switches. Lenovo supplies
all 29 identities, sizes, grouped U-position codes and an explicit floor grid;
the current loose-only expansion leaves 26 member configurations absent.
This is an implementable MCP import gap, separate from missing GB300 numeric
power. Native `buildWorkspaceImportData` expands each position group by size
in originalIds order. Ordinary clone ownership, managed-storage aliases and
nested chassis expansion must remain distinct when implementing the fix.
Evidence: `artifacts/grouped-rack-audit-2026-10-30/report.json` and the source
capture referenced there. This is a replay of captured native data, not a fresh
live reference-launch pass.

Implementation now expands ordinary rack groups, preserves original IDs and
clone ownership, splits U-position runs using native sizes, and rejects missing
or inconsistent positions atomically. Two regressions verify all 29 devices
against the independent native floor grid and malformed-run rejection; existing
clone/layout tests pass. Fresh browser Customize on October 30 returns the same
shape, and direct expansion matches all identities/positions (31 configurations,
29 racked plus one spare and one rack).
`parity:grouped-rack-import` now passes run6 through fresh native Customize,
commercial selection/price/count parity, all 29 rack-device positions, healthy
SIGKILL/restart, export and fresh-browser import with floor/commercial parity.
Evidence: `artifacts/parity-grouped-rack-import/2026-10-30-run6/report.json`.
Two follow-on MCP defects were resolved: filler projection now follows native
`addRackFiller` catalog gating (MGX offers C6MV power shelves, no standard
fillers), and expanded imports retain singleton rack/spare ownership plus the
native color-member order across restore. New regression fixtures and tests
cover both. Run3 only compared persisted state across restart; run4 exposed
in-memory quarantine on export, and the maintained runner now explicitly
requires healthy restore. No claim is made for live linked edits of these
imported groups or broader nested/managed-storage compressed shapes.
Full `npm run check` passes 883 tests / 120 files, 17 offline contracts,
typecheck, lint, build and 79-tool startup (`run6/check.log`).

## x-config import hydration (2026-10-30)

Resolved the captured missing-floor gap: native `/cfxml_import` routing,
bounded source inspection, explicit hierarchy U-position decoding and local
floor initialization now match the website. Supplied incomplete placement
metadata still rejects. Run4 verifies completed native configurations/prices,
physical layout, restart and export/native import. Floor/U-position handoff
assertions pass against the captured reimport as well. Evidence:
`artifacts/parity-xconfig-import/2026-10-30-run4/`.
Full checks pass (879 tests, 17 contracts, 79-tool startup). One genuine
x-config design is verified; grouped positions and broader shapes remain open.
Saved source cabling and companion workbook recovery are not verified.

## Unconfigured editing investigation

Native `/unconfigured/7DGDCTO1WW` catalog succeeds. Frontend selection edits
are local and bypass hardware derive. Pure catalog hydration and quantity
staging are implemented and pass six focused tests, typecheck and lint.
Now exposed via `dcsc_load_unconfigured` / `dcsc_set_unconfigured`.
Full checks pass (875 tests, 17 contracts, 78-tool startup). The maintained
`parity:unconfigured` run1 passes a real quantity edit, stale-revision rejection,
crash/restart and fresh browser import with expected selections/prices.
Workspace undo and persistence rollback are tested. Run3 additionally verifies the direct native UI edit, $60,759.54 total and
all nine exported commercial rows. Catalog refresh repricing and linked-member
atomic refresh/edit/undo are unit-tested. Native linked-copy behavior and
broader product coverage remain open. Original reference-template download is now integrated as
`dcsc_download_reference_solution`: live eligibility check, bounded byte
stream, validated XML artifact. Maintained run1 verifies exact byte equality
with native Export, matching native/MCP import and crash/restart. Evidence:
`artifacts/parity-reference-download/2026-10-30-run1/report.json`. Broader
reference families remain open. Full checks pass: 877 tests, 17 contracts,
79-tool startup, typecheck, lint and build.
See current context for live browser process and evidence paths.

## Native reference solution increment

Added native catalog browsing/customization, separate from curated blueprints.
Run3 passed 16 MCP calls, native selection/price comparison for SID0000978,
crash/restart and fresh-browser export handoff. Preserves native Unconfigured
software and express/audience metadata; captured commercial rows match native.
Evidence: `artifacts/parity-reference-solutions/2026-10-30-run3/report.json`.
Unconfigured editing, original-template download, legacy connection recovery,
authenticated workflows and broader template coverage remain open. Storage
and GB300 results remain scoped upstream failures, not universal API limits.

## 2026-10-30 expansion addendum

The user's expanded parity goal is active. The dated frozen audit below remains
the record of its original scope, not an exhaustive inventory of website features.

- Cabling now exposes per-requested-network diagnostics. Working Management
  rows cannot conceal an empty assigned storage network. Native manual-edit
  tools are documented and linked from auto-connect. This does not close
  finding 15's upstream storage-row generation gate.
- Added native power settings discovery and transactional Save through
  `dcsc_power_controls` / `dcsc_set_power_controls`. Voltage/policy choices,
  load-factor preservation, native MI export metadata, CAS, failure rollback,
  linked updates and history are covered locally. The native SR630 V3 capture
  and `parity:power-controls` verify Save, immediate SIGKILL/restart, undo/redo,
  subsequent hardware derive and fresh browser import.
- Native and MCP CFXML exports saved at load factor 100 both import at 70;
  230 V and policy 5 survive. A fresh browser importing the native XML proves
  this reset occurs upstream, before MCP reconciliation. The tool warns;
  explicit reapplication is verified. This limitation is not counted as
  successful load-factor round-trip preservation.
- Current local gate: 857 tests / 116 files, 17 offline contracts, typecheck,
  lint, build and 74-tool startup passed. Live evidence:
  `artifacts/parity-power-controls/2026-10-29-run3/report.json` (15 MCP calls
  and two fresh-browser imports). Maintained native fixtures:
  `test/fixtures/parity/power-controls.json` and `xml/power-controls-native.xml`.
  Distinct power-policy changes, native linked-clone Save, managed storage and
  chassis power controls still need broader native/live coverage.
- Added direct Excel-file import through the website's `/multiple/cfxml_import`
  flow. Binary multipart uploads preserve bytes; empty native catalog slices
  no longer cause a false conflict; legacy companion-recovery requests warn.
  `parity:workbook-import` run 7 passed five real MCP calls (max 6,711 bytes),
  four-unit clone expansion, immediate SIGKILL/restart, export and independent
  browser workbook/XML imports. All 22 selected section/part/quantity rows
  match native results for all four units. Evidence:
  `artifacts/parity-workbook-import/2026-10-30-run7/`.
  Final local checks passed 862 tests / 117 files, 17 contracts, typecheck,
  lint, build and 74-tool startup. A tested mixed rack/server Excel export is
  rejected by both the website and API as unsupported multiple hardware
  products (`artifacts/gap-audit-2026-10-30/workbook/browser-rejected-control.json`).
  Do not infer a universal mixed-workbook prohibition from this one design.
  Modern direct Excel import does not close legacy `/excel_import` plus
  `/connection_recovery`; a working populated-cabling recovery still needs
  native capture. Legacy `.xls` files also need live coverage.
- Next implementation gaps: legacy cabling-workbook recovery, native reference
  solutions and additional frontend workflow audit. Authenticated workflows
  and the documented storage/GB300 limitations remain open.

## Original frozen audit

**Date:** 2026-10-16
**Status:** Final frozen evidence audit for the implemented scope; full website-parity closure remains blocked by finding 15's populated-storage requirement.
**Baseline:** Materialized snapshot `20261016T041423Z`, verified unchanged before and after its terminal 54-command run.

`Closed` means the defect described in the original review has a focused
regression and applicable functional evidence. It does not silently close a
broader product matrix. `Partial` names the exact remaining acceptance gate.

| # | Current status | Current evidence and residual gate |
| --- | --- | --- |
| 1 — BOM loss/warranty | Closed | `test/dcsc-wire.test.ts`, `test/software-configure-tool.test.ts`, `artifacts/implementation-2026-10-15/software-differential-run4/report.json` and `artifacts/implementation-2026-10-15/controls-locale-de-final6/report.json` cover canonical hardware/software/service state, prices and real edits. |
| 2 — Rack export | Closed for the verified physical shapes and workbook content | `rack-lifecycle-workbook-run4/result.json` and `rack-power-workbook-run2/result.json` in `artifacts/implementation-2026-10-16` inspect all eight sheets, commercial quantities/prices, floor/rack positions, positive power, diagnostic history and resolved rack images, with fresh-browser reimport. Native-style HPC action history commits atomically. Final frozen command 45 passes the strengthened 291-call lifecycle, including exact COPY descriptions, duplicate history multiplicity in CFXML/workbooks, undo/redo and SIGKILL recovery. Frozen commands 32 and 36 verify all eight workbook sheets. Rack images convey physical layout and are not pixel-identical to the website. |
| 3 — Failed edit/undo corruption | Closed | `test/configure-state.test.ts`, `test/service-atomicity.test.ts`, `test/session-transaction.test.ts` and subprocess crash cases require draft rollback and consistent raw/index/reduced history. |
| 4 — False validation success | Closed with final frozen terminal-valid/invalid evidence | Final command 53 repeats valid and deliberate-invalid cases, canonical payload/revision/scope, stale-job invalidation, bounded output and executable public continuation reconstruction. Development evidence in `corrected-validation/report.json` and `corrected-validation-paged/report.json` records the 4,164/4,642-byte direct responses and 57-call complete inspection with maximum response 7,283 bytes. Earlier HTTP 500 evidence remains historical. |
| 5 — Persistence loss | Closed | v2 persistence, shutdown, deletion and 48 immediate-SIGKILL scenarios are covered by `test/persistence-*.test.ts`, `test/session-lifecycle.test.ts` and helpers under `test/helpers/`. |
| 6 — Missing export groups/quantities | Closed for verified ordinary and managed-storage handoffs | Final frozen command 54 passes strict quantity-four/eight identities, disjoint ownership, commercial values and XML. The managed-storage export correction retains separate loose physical aliases; frozen commands 24 and 31 repeat placement and reimport. `storage-singleton-hierarchy/report.json` and `storage-singleton-hierarchy/reimport/report.json` preserve the earlier exact controller/SAN identities, commercial quantities/prices and usable workspace actions. Original grouped-alias failures remain preserved. |
| 7 — Rack power used sales quantity | Closed | `test/scope-and-power.test.ts`, `test/power-report.test.ts` and `artifacts/implementation-2026-10-15/rack-power-green-run4/result.json` separate physical placement from unplaced sales quantity. |
| 8 — Invalid scaled scenario rack metrics | Closed | `test/tools-scenarios.test.ts` and `dcsc_compare_scenarios` omit physical rack totals for uncalculated scaling, retain explicit fixed products and direct users to real scale-out/layout calculation. |
| 9 — Mixed-currency ranking | Closed | `test/tools-scenarios.test.ts` requires currency per scenario and rejects cross-currency ranking. The DE/EUR live differential supplies the second priced context. |
| 10 — Revision race | Closed | Transaction CAS is inside the workspace lock; `test/tool-cas.test.ts`, transaction/service atomicity tests and concurrent mutation cases require one accepted commit. |
| 11 — Option pagination gaps/context loss | Closed | `src/model/project.ts`, `test/discovery.test.ts` and conformance execute returned continuations after byte trimming with the original query/context. |
| 12 — Dangling deletion references | Closed for implemented physical shapes | Workspace reference validation/cascade/history tests cover rack, floor, cable, PDU and managed-storage references. Supported chassis/node add, export/import, unplace/re-place, detach, populated-chassis removal with explicit child disposition, history and crash recovery pass the 291-call real-MCP lifecycle and all three native action gates. Native Delete Node keeps commercial data but Lenovo drops the detached node on reimport; the MCP warns and directs roundtrip users to unplace. Broader VLH/container shapes remain future matrix growth. |
| 13 — Clone identity/workspace boundaries | Closed with frozen handoff and legacy ownership migration evidence | `test/configuration-identity.test.ts`, `test/physical-clone*.test.ts`, lifecycle/CAS tests and source/member linked handoffs cover canonical IDs, membership, placement and restart. Distinct Copy passes real MCP export and fresh-browser reimport in `rack-copy-mcp-live-run2/result.json`. Canonical v2 migration repairs proven older imported singleton ownership in active state and undo/redo snapshots, with archive-before-rewrite and unchanged revision/history. `q4-persistence-migration-result.json` verifies the captured response and second restart; ambiguous independently edited members remain read-only with re-import guidance. Final frozen clone commands 38–43 and headless command 54 pass. |
| 14 — Missing standalone/global lookup | Closed for the verified MCP flows; native Save limitation disclosed | Standalone software/services have catalog, selection, software quantity/covered-product count, refresh, export/import/restart and base-plus-add-on evidence. Native service selection is quantity one; imported non-unit service quantities are supported data. `parity-services-quantity-run4/report.json` verifies product-three/service-two → product-four/service-two at USD 13,096, rejected quantity rollback, MCP export/fresh-browser import and real-stdio SIGKILL/restart. Native product +/- preserves imported service quantity locally. Native Save after import and resize posts an empty service list and returns HTTP 500; the MCP export retains the service and reimports correctly. This is a qualified website limitation, not a successful native export claim. Global find-part pagination bounds the website-equivalent single-array response; Lenovo exposes no cursor or total, so upstream exhaustiveness remains unknown and is disclosed. |
| 15 — Incomplete fabric/storage networking | **Partial** | Catalogs, preferences, setters, managed storage placement/derive/unplace, controller/SAN management and nonzero Management graph handoffs pass. Existing-row endpoint and cable-part edits have native browser wire/export evidence plus atomic derive, crash recovery and export. The quantity-preserving shared-part adapter and same-component occupied-port swap both pass live import, export and immediate SIGKILL/restart. Distributed main/leaf preference Close, exact three-row graph, SIGKILL recovery, lossless public projection, export and fresh-browser import pass in `network-leaf-mcp-live-run8/report.json`. The historical Direct Attached FC gate and clean FC/optical-iSCSI post-import controls receive HTTP 200/no errors but return zero storage rows. The historical input retains a prior SAN configuration; the clean imports collapse the managed template root into the physical alias and omit the definition controller ID. A fresh optical-iSCSI pre-export control preserves the distinct root/alias, controller ID, assignment and compatible connector/cable groups without switches, but also returns HTTP 200/no errors and zero connections. This is a bounded tested-design result, not a global outage claim. The 2026-10-16 diagnostics (`artifacts/storage-diagnostics-2026-10-16/README.md`) replayed the native iSCSI and r49 DS3200/DB710S SAN requests in 22 variants across nine storage hypotheses; storage rows stayed at zero and `switch_calculation` never requested a SAN switch. With native identities Lenovo cabled the managed DB710S alias on Management, so alias resolution is not the cause. Lenovo's reference designs with DM/DE/DG storage contain no storage definitions or rows. Remaining, blocked upstream: a website design that yields a storage-network row, then managed-storage physical-alias cable replacement. Local planning links remain distinct from website connection rows. |
| 16 — Expert/Auto-Correct unavailable | Closed | `dcsc_set_configuration_controls`, focused tests and `controls-locale-de-final6/report.json` cover Guided/on, Guided/off, Expert/off and local Expert/on rejection. |
| 17 — Product discovery truncation | Closed at the available upstream boundary | `test/catalog-tools.test.ts` and `artifacts/implementation-2026-10-15/catalog-continuations-final3/report.json` enumerate product/rack/fabric/software pages without local gaps, bind continuations to fingerprints and keep responses below 8 KB. |
| 18 — Invalid solution fallback | Closed | `src/domain/context.ts` and `test/discovery.test.ts` reject an explicit unknown mode and retain fallback only when the mode is omitted. |
| 19 — Blueprint/docs drift | Closed for current claims | Blueprint availability is checked against current catalogs; maintained blueprint gates and README now qualify dates, catalog presence, blocked GB300 power and current rack/network behavior. |
| 20 — Broken/inadequate gates | Closed for the complete advertised inventory | Final snapshot `20261016T041423Z` completes all 54 commands with **52 passed, 0 failed and 2 declared capability blocks**. Exact manifest/source verification passes before and after. It includes 846 unit tests / 114 files, 17 offline contracts, 89 live contracts, 170 conformance assertions / 72 tools, the 291-call nested lifecycle, strict validation pagination and headless 15/15 with 99 wire entries. The blocks are the documented GB300 numeric-power/dependent-DWC capability and FC zero-storage-row case; neither is counted as a pass. The source-bound map is `artifacts/release-results/20261016T041423Z/final-completion-evidence-audit.json`. |
| 21 — Missing rack/option discovery context | Closed | Discovery now accepts relevant context, exposes stable tab/section identifiers, compatible racks, detail paths, fingerprints and executable continuations; covered by discovery/catalog registered-tool tests. |
| 22 — Download/retention limits ignored | Closed | `src/files/artifactStore.ts` and `test/artifact-store.test.ts` enforce streaming download limits, atomic storage, confined cleanup and retention. |
| 23 — Missing layout lifecycle | Closed for supported direct and nested shapes | Move, unplace, detach, remove/cascade, arrange, undo/redo, export/reimport and restart pass for direct items and the supported nested lifecycle. Distinct Copy, item/space lock persistence and allowed multi-code PDU behavior have maintained MCP/browser evidence. `rack-lock-reserved-native-run3` verifies authoritative correction from reserved U42 back to U1 with the source unlocked; `rack-lock-reserved-mcp-run2` verifies fail-closed rejection and full workspace/revision/history preservation. Final frozen commands 32–48 pass, including the 291-call lifecycle and all three native nested actions. Delete Node has a verified Lenovo handoff limitation: export retains its commercial configuration while reimport drops it, so the MCP warns and offers roundtrip-safe unplace. Broader VLH/container shapes remain future matrix growth. |
| 24 — Vulnerable dependency snapshot | Closed; frozen audit gate passes | A clean-install audit initially reported 14 vulnerable packages: 4 moderate, 7 high and 3 critical. Direct minimums now require `@modelcontextprotocol/sdk` 1.32.1, `undici` 7.30.1 and Vitest 4.1.12; Vite 6.4.4 satisfies Vitest while preserving the repository's Node >=22 engine range. The refreshed lock resolves patched transitives, including Hono 4.13.13, `fast-uri` 3.1.8, `ip-address` 10.7.4, `proxy-addr` 2.0.8, `qs` 6.16.1, `js-yaml` 4.3.2 and both patched `brace-expansion` lines. Final frozen command 6 passes `npm audit --audit-level=moderate`; typecheck, lint, 846 unit tests / 114 files, 17 contracts, build and all three compiled smokes pass from the same materialization. Audit severity alone does not establish code-path reachability. |

Additional defects found while planning are covered by the same foundations:
complete import hydration and identity normalization; v2 quarantine/recovery;
scope-aware reconciliation trust; typed remote-success/local-write-failure
diagnostics; priced CAL quantity; and bounded workspace projections all have
focused tests and maintained evidence described in the progress ledger.

## Exact release-gate disposition

1. **Manufacturing verdict — closed for the verified workflow:** final frozen command 53 passes terminal valid/invalid, canonical provenance, bounded public output, exact counts and complete executable diagnostic continuations.
2. **Storage:** corrected placement and first/detached fresh-browser reimports now pass, preserving identities, commercial values and a usable workspace. Clean FC and genuine optical iSCSI cases both return HTTP 200/no errors with zero rows after import, but import has already collapsed the distinct managed template root. A fresh distinct-root optical-iSCSI pre-export control also returns zero connections with intact ownership, assignment, compatible media/cable groups, P2P enabled and no switch present. Keep the conclusion scoped to that exact design; a populated storage graph and managed-alias connection-row mutation remain open. Expansion remains upstream-unavailable while both current catalogs advertise zero expansions.
3. **Network parity:** existing-row endpoint and cable-part edits pass native
   browser wire/export capture and maintained MCP derive, SIGKILL/restart and
   export. Shared old-part usage and same-component destination-port swapping
   also pass maintained live gates. The captured Distributed leaf preference,
   P2P graph, export/restart and fresh-import workflow passes. Capture
   managed-storage physical-alias cable replacement. Source-side/cross-component occupied-port swaps remain
   fail-closed. The website has not exposed Add/Delete for existing connection
   rows. Evidence: `manual-cable-browser-edit/`,
   `manual-cable-browser-part/`, `manual-cable-browser-shared/`,
   `manual-cable-browser-collision/`, `manual-cabling-mcp-shared-live-run3/`
   and `manual-cabling-mcp-collision-live-run2/`.
4. **Physical edge matrix — closed for supported shapes:** final frozen commands 32–48 pass, including native remove-chassis, detach
   and unplace plus the 291-call MCP lifecycle. Native Delete Node's commercial export cannot be
   round-tripped by Lenovo; retain the explicit warning and unplace alternative.
   Broader VLH/container shapes are future compatibility-matrix growth rather
   than an unresolved finite gate in this audit.
   Distinct Copy,
   item/space locks and website-allowed multi-code/non-unit PDU behavior now
   have maintained evidence; Lenovo-native CFXML drops item locks while
   retaining empty-U reservations, which the MCP matches.
5. **Qualified unavailable/unknown capabilities:** keep GB300 numeric power and
   its dependent DWC check blocked. On 2026-10-16 the website's exact
   power-panel request returned null GB300 power while an SR630 V3 control
   returned its numeric report, and Lenovo's GB300 NVL72 reference design also
   has no report; keep storage expansion unavailable; keep
   global part-search exhaustiveness unknown because the website endpoint has
   no total/cursor. Correct unavailable-result behavior is a pass, the missing
   capability is not.
6. **Single-snapshot release — closed:** snapshot `20261016T041423Z` was materialized in a detached worktree, installed from the lockfile, verified against tracked/untracked/ignored-document hashes before and after, and ran all 54 commands serially. The terminal result is 52 passed, zero failed and the two declared capability blocks described above.
