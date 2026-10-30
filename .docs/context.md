# Current project context

Updated 2026-10-31. This is the current acceptance checklist and handoff. Detailed
investigations are preserved in [historical context](context-2026-10-30-history.md).
Do not infer current limitations or live processes from historical entries.

## Objective and working method

The active user goal is the closest achievable functional parity with the Lenovo
DCSC website, including gaps beyond the original review. Do not mark complete from
unit tests or one passing topology. The user explicitly asked to control the whole
development flow and work more efficiently: batch related changes, run focused
checks during iteration, use full checks only at stable checkpoints, and prioritize
remaining acceptance gaps. Do not repeatedly restart quiet processes or duplicate
completed probes. No subagents unless explicitly authorized by user/AGENTS/skill.

This is a local anonymous stdio MCP: 85 registered tools (PCI and storage wizard tools added after the frozen baseline); list prices, not partner
quotes. Implementation/tests are committed as `4e40425` on `feat/dcsc-website-parity-20261031`.
Private repository creation/pushing was authorized (historical context, Private distribution section).
Follow CONTRIBUTING: deliver through a PR to main; do not publish to npm. Headless browser lock:
`/tmp/lenovo-dcsc-headless.lock`. CONTRIBUTING.md applies. All HTTP goes through
DcscHttpClient.send. Public mutations must preserve revision, history and persisted
state on rejection. Native errors and unavailable values must remain explicit.

## Current verification checkpoint

The 90-command frozen run is **finished**: 85 passed, 4 expected upstream blocks,
1 native Add Node menu timeout. An unchanged rerun of that failed check passed
placement/export/fresh import. Original failure remains in the matrix. Source
integrity passed before/after. No live jobs remain. The current runtime matches
the frozen snapshot; the subsequently added populated-RAID regression passes
14/14 storage tests with typecheck/lint. The isolated production package starts,
exposes85 unique tools and passes health without Lenovo requests.

Authoritative local reports: `artifacts/release-2026-10-30-wizards-source-swap/results/report.json`,
`nested-vlh-recheck/resolution.json`, and `working-tree-differences.json` in the same
release folder. Packaged artifact: `/tmp/dcsc-delivery-20261031/lenovo-dcsc-mcp-0.1.0.tgz`.
Broader parity remains unproven. Follow the roadmap action inventory and Claude
advisor stop rule: no speculative features or new variant suites.

## Historical verification checkpoints (superseded by the current result)

| Check | Evidence and current disposition |
|---|---|
| Full local suite | Session16118 terminal PASS:970 tests/124 files,17 contracts,typecheck,lint,build,81-tool smoke. Log `/tmp/dcsc-shared-replacement-final-check.log`. |
| Fresh shared-storage replacement | Maintained public gate36654 PASS22 calls, two crashes, export/import, recovered export and website graph/commercial parity. `artifacts/parity-manual-create/2026-10-30-replace-storage-run1/report.json`. |
| Imported linked-storage replacement | Service66974 PASS, including unused spare quantities2, zero cable errors and another export/reimport. `artifacts/imported-linked-replacement-2026-10-30/run5/report.json`. |
| Invalid paired quantities | Live56374 PASS: native errors returned; graph/configuration/history/revision and persisted file unchanged. `artifacts/managed-replacement-negative-2026-10-30/report.json`. |
| Combined public lifecycle | **PASS24 calls, session40223**: `/tmp/dcsc-shared-replacement-gate2.log`; `artifacts/parity-manual-create/2026-10-30-replace-storage-run2`. Replaces before AND after import, retains unused spares, restarts/re-exports, compares website graph/prices. Terminal report confirms graph,spares and website commercial parity. |
| Release inventory correction | **PASS2 tests, session40303** focused test: `/tmp/dcsc-release-inventory-check.log`. Only exact native breakout-loss exit2 is declared blocked; obsolete blanket managed-storage blocker removed. This metadata edit followed the full suite. |
| Final frozen matrix | **TERMINAL12756 exit2:78 passed,0failed,4 declared capability blocks** frozen matrix: `/tmp/dcsc-integrated-release-matrix.log`; authoritative `artifacts/release-2026-10-30-integrated/results/report.json`. Isolated checkout `/tmp/lenovo-dcsc-release-2026-10-30-integrated`; npm ci and manifest verification passed, zero dependency findings. 82 commands in scripts/release-checkpoint.ts. Previous69-command result64pass/3fail/2blocked certifies an older source only. |

## Implemented cabling behavior and evidence

- Public native manual creation supports verified Management,100GbE,managed source,
  DAC storage destination,fresh/shared controller and linked endpoint cases. Explicit
  pinning retains preexisting AUTO routes. Four-way breakout is separately modeled.
- Existing-row inspection can refresh native choices with a required workspace
  revision without mutating the design. Replacement refreshes missing choices.
- Shared replacement resolves template/physical ownership, preserves unrelated
  routes, and validates every physical product. Optional
  `cableQuantities:{oldPart,newPart}` gives per-product quantities including spares;
  native paired rules are not guessed/rounded from error prose.
- Materialized linked storage uses native root-only configure plus all member
  customizingIds. Related containing-rack updates are accepted with strict identity
  checks and require workspace undo. Managed templates are excluded from that path.
- Import preserves explicit manual cable quantities before layout-derived values
  can reduce them to route counts. Missing P2P category/divider1 is normalized only
  in the planner. Rooted materialized storage clone ownership survives re-export.
- A last-route replacement clears the obsolete forAutoConnect ownership flag on
  explicitly retained spares. Native control confirmed that leaving it true drops
  the spare. Restaging can restore only the exact pre-call physical record.
- Maintained regression inputs include manual-import-cable-spares.json,
  storage-materialized-clone-import.json and the existing native cabling fixtures.
  Historical context contains precise bounded captures and failed-control history.

## Remaining acceptance queue

| Priority | Work | What establishes completion |
|---|---|---|
| Complete | Combined public cabling gate | PASS24 MCP calls; exact graph/spares and commercial comparison after both replacements/recovery. |
| Complete | Frozen82-command matrix | 78passed,0failed,4declared blocks; manifest integrity passed before/after. The pre-PCI working tree matched frozen source (481matching files;5documentation differences); subsequent PCI work requires its own verification. |
| 3 | Reconcile all original findings and current website capabilities | Evidence table distinguishing implemented, verified, API limitation and unverified; no percentages inferred from tool count. Audit/roadmap history remains evidence, not current blanket blockers. |
| 4 | Remaining functional coverage | Genuine legacy companion-workbook recovery input; additional FC/optical/storage hardware,expansion catalogs,breakout shapes and complex physical/container cases. Check native contracts before implementation. |
| 5 | Authenticated workflows | Account saves and partner pricing remain unverified and require applicable access; do not represent them as supported or universally unavailable. Progress anonymous scope first. |

Known scoped upstream limitations: website CFXML import changes captured BREAKOUT4
to P2P1 (MCP own recovery retains it); tested FC/optical combinations expose empty
or incompatible native catalog/graph results; GB300 numeric power values were null;
native Delete Node exports but loses the detached commercial node on import (unplace
is the retention workflow). These are bounded observations, not universal endpoint
absence. Current10GbE DAC storage is supported and must not inherit old FC blockers.

Frozen matrix command37 also passed the combined shared-storage replacement
lifecycle:24 calls, replacement before/after import, spares, recovery and native
browser handoff. Current source evidence in frozen checkout:
artifacts/parity-manual-cabling/2026-10-30T18-23-48-053Z/report.json.
Shared and mixed creation gates passed20 and21 calls respectively. The full matrix
is now terminal with78passes/0failures/4declared blocks; broader website parity remains unproven.

## Production-package acceptance

The frozen build was packed with prepack skipped only because its matrix build
already passed (no dist rewrite during live tests). The tarball allowlist excludes
sessions/captures/source tests. Isolated production-only install and81-tool offline
startup PASS40459 on Node24. Node22.17.1 startup check37869 also terminal PASS81 tools. Evidence
`artifacts/release-2026-10-30-integrated/package/report.json`,pack-metadata.json and
smoke logs. No Lenovo requests. This supplements the82-command matrix and uses the
same frozen runtime sources. Current working-tree documentation may be reconciled
while the frozen checkout remains unchanged.

## Current-source finding audit

The executable evidence map is
`artifacts/release-2026-10-30-integrated/audit/coverage.py`; it reads the frozen
manifest/report and verifies regression paths in that isolated checkout. Run it to
refresh `audit/current-coverage.json`. All23 original findings have mapped existing
regressions and release gates. Pending/blocked/failed gates are not closure; the
map explicitly excludes unverified website expansion from its denominator. No
website parity percentage follows from these counts. Live counts and the current command come from results/report.json, not this handoff.
Real-transport conformance passed180/180 checks across81tools. Software configuration,
export and mixed hardware/software browser gates passed. GB300 numeric power and its
dependent DWC check produced a declared capability block. Matrix session12756 is terminal exit2; do not poll/restart it. All82 commands completed.
Headless suite15/15passed with99wire entries; nested stdio291calls passed. Original
23-finding evidence map:22pass,1blocked (the all-gates requirement),0pending. The
blocked matrix commands are verify-fixes (GB300/DWC),storage-fc,and both breakout
creation/replacement website handoffs. Before/after source verification passed.
That matrix is terminal. The historical pre-PCI comparison found only5doc differences; current runtime has a new PCI increment.
The map is a regression/gate audit, not proof of all website functionality.

## Active next feature: PCI-slot wizard

Post-matrix audit found an enabled native PCI wizard in SR650 V4 code7DGDCTO1WW,
referenceSID0000978/category57d87668ec5695ab80433cf8866bf525. Current reference
captures contain pciWizardUI=true and one active option1P Rear5-a, networkBK1H
in REAR_SLOT5/C62D and RAIDB8NY in REAR_SLOT3/C3R4, with optional rear slots.
The live website PCI -> Riser Card view confirms a wizard table with optional
checkboxes. This is an actionable API integration lead; do not mark the goal
blocked solely on account/workbook inputs while this work remains.

Artifacts: artifacts/pci-wizard-audit-2026-10-30/. Native inspect87603PASS,
pci-tab31380 failed only due an overly strict locator; corrected40520PASS;
riser-tab33834PASS. Select-slot85530 failed a Playwright immediate checked-state assertion; corrected
25548 terminalPASS uses the actual checkbox click then awaits native validation.
Native payloads/final editor are in select-slot/. Native roundtrip94135 PASS: export/reimport retains the four-slot arrangement. Generic configure comparison85060 confirmed a real gap (two original slots retained). The82-command matrix certifies the pre-PCI baseline only.

Frontend source: pci-functions.js.txt,frontend-contracts.txt,selection-contracts.txt.
The native buildQueryPciWizardSelectedSolutionSlotsResults adds pciWizardOption,
pciWizardOptionConfigIds,adapterCodeAndPhysicalSlotMap,lastPciWizardSelectCondition,
and optional lastPciWizardAutoFixAllDisabledSlotFcSet to configuration requests,
plus selected slot section results. Native optional-slot validation is POST
/pci_wizard/validate/additional/slot with ctoCode query and body containing
pciWizardOption,sections,operate,language. Do not guess operate or option mutation;
use the current native capture. Generic dcsc_configure can address raw riser
sections, so compare before declaring every wizard action a missing capability.
Captured validation body operate="add", HTTP200,response code1,pciWizardOption.
The website then posts /ctos/autoDerive with pciWizardOptionConfigIds,pciWizardOption,
lastPciWizardSelectCondition and storageWizardOption in the configuration. Initial
selected slots:C3R4(RAIDB8NY),C62D(NICBK1H). Validation addsC3R9 and reallocates
adapters; final autoDerive additionally selectsC4U8, leaving C62D/C3R4 as spares,
B8NY atC3R9 andBK1H atC4U8; UI option price288. Do not assume the change adds
only one part or treat validation response as final BOM. report.json summarizes
the native result; fullrequests.json is authoritative. New implementation in domain/pciWizard.ts, service.ts, reduce.ts and mcp/pciWizardTools.ts uses native validation, derives without adapterCodeAndPhysicalSlotMap, and exports with it. Ordinary riser edits now guide users to the wizard tools. Live service76077 PASS matches native four-slot arrangement. New fixture and9focused tests pass, including linked non-root success, linked rejection, persistence failure and native cancellation rejection. Full local suite51909 PASS975tests/125files before four additional PCI tests;17offlinecontracts PASS. Public lifecycle80313 PASS12calls/max6146bytes: crash/restart, stale revision, undo/redo, unrelated derive, export/import and fresh website import. Evidence artifacts/parity-pci-wizard/2026-10-30-run2/report.json. First run12160 failed only because its test used another model’s UEFI code; corrected harness reads this configuration’s selected code. Native cancel80061 PASScapture: code3/massage slot required for adapter; MCP93651 returned that same expected rejection (probe exits1). Final source lifecycle12189 TERMINAL PASS12calls/max6146bytes in artifacts/parity-pci-wizard/2026-10-30-final/report.json, /tmp/dcsc-pci-final.log, after final rejection guards. Offline smoke32527 PASS83unique tools. No live job remains from this increment. Typecheck/build/targetedlint passed. Remaining bounded coverage: other PCI option families, successful cancellation/alternative slots, live linked wizard lifecycle. Do not claim these broader scenarios from the single verified addition. The release inventory now has83commands; frozen82 remains historical. Conformance script now discovers both new tools and checks invalid selection; the full updated conformance has not yet run.
Requirements: native option/slot discovery, validated selection, preservation
through derive/export/import/recovery and atomic rollback. Assess actual capture
before choosing implementation/tool surface. Storage wizard also appears in the
frontend query builder but has not yet been audited for an enabled website case.

## Remaining API audit leads

Read-only frontend/API comparison identified memory wizard routes absent from MCP.
Anonymous probe3793 returned launch MEMORY/PROCESSOR catalogs, but productCode
availability=false for7D73CTO1WW. This is an API-present, product-coverage-unverified
candidate, not yet a user-visible supported flow. No production changes. Evidence
artifacts/memory-wizard-audit-2026-10-30/report.json and frontend-contracts.txt. Find
one catalog-supported native website case before implementation. Followup22961
used the website's exact category_hierarchies?type=purley discovery and returned[]
in US/GeneralPurpose, so defer wizard implementation rather than guess inputs. Static path
absence alone is not a missing-feature count (dynamic routes and UI routes differ).

The downloadable native Excel template was fetched through DcscHttpClient (HTTP200,
11,491 bytes) and inspected. It contains only Sheet1 with Part number/Qty columns and
placeholder CTO/feature codes; no cabling connection data. It therefore does not supply
the genuine legacy recovery input. Evidence:
artifacts/gap-audit-2026-10-30/workbook/native-template-report.json and
native-template-inspection.json. Probe50584 terminal PASS; initial21495 failed locally
for missing solution context before HTTP, corrected in the probe only. Runtime source
remains unchanged. Do not re-probe this template as a cabling recovery lead.

A second asynchronous clarification asks for the local path of a genuine legacy
x-config companion Excel workbook containing cabling connections. No answer yet.
Modern DCSC workbook import has passed the frozen gate, but this does not supply
legacy connectionData or prove legacy recovery. Do not repeat the template probe.

Account-access clarification is pending via an asynchronous user question: whether
an existing test account/authenticated environment is available and where its local
setup instructions live. No answer has arrived yet; do not interpret elapsed time
as access or approval. Anonymous release validation continues independently.

Current frozen breakout replacement gate completed17 calls and MCP recovery passed
with5 connections/cable quantity2; native website import again changed BREAKOUT4 to
P2P/divider1, so its overall result is declared blocked. Evidence in the frozen
checkout: artifacts/parity-manual-cabling/2026-10-30T18-04-18-326Z/{report,mcp-recovery-report}.json.
This is not an MCP recovery failure. Current matrix counts/stage remain in report.json.

## Post-matrix remaining-guard audit

Session77810 terminalPASS captured Delete Node on a verified NON-ROOT linked
member in nested-grouped-native.xml. Native website threw the same undefined.id
JavaScript error as the historical root attempt, made0post-click customize/derive
requests, and left both browser databases unchanged. Evidence:
artifacts/linked-node-member-detach-audit-2026-10-30/report.json,requests.json,
before-database.json,after-database.json,capture.log. No runtime code changed.
The guard at service.ts linked nested detach remains justified for this shape;
API support is still unverified, not disproven. A successful native contract for
other shapes (e.g. multiple linked nodes in an independent chassis) remains absent.
Do not repeat the same root/member linked-chassis attempts.

The remaining explicit runtime guards also include combined independent-service
plus hardware export and deeper nested containers; these lack a verified native
combined contract, and must not be described as universal API absence. Modern
workbook and normal unplace/recovery flows already passed; do not rerun them as
substitutes for the missing legacy/linked-delete contracts. No live job remains.

## Release execution

Use scripts/release-checkpoint.ts to generate/verify the source manifest. Existing
executor: artifacts/release-2026-10-30/run-release-matrix.mjs; audit before reuse.
It runs commands serially and locks headless cases, records live progress
in its report and separates declared blocked exit codes from failures. Historical
frozen checkout `/tmp/lenovo-dcsc-release-2026-10-30` must not be overwritten; create a
new isolated checkout/output directory. No credentials are needed for these gates.
Dependencies were remediated; the completed frozen matrix audit found0vulnerabilities.

User-facing percentage: all5 cabling verification checkpoints now pass (previous
update4/5). This is NOT a website-parity estimate. Do not reuse that number as
overall completion. Keep the goal active until its full completion audit.


## PCI follow-up: native verdicts and linked coverage

2026-10-30 continuation: previous turn was progress. Current native browser
slot-sequence43246 terminal PASS captured add followed by successful spare-slot
removal: validator returns code4 with empty massage and website derives three
slots C3R4(empty),C3R9(B8NY),C4U8(BK1H). Initial strict code1-only handling was a
real MCP defect; fixed to accept code4 only for cancel. Service83338 PASS matches
the native final three-slot arrangement exactly (spare-comparison.json).
Native alternative-slot28795 terminal PASS selects C3R7 (500W) then enables row4;
validator returns code2/no warning, retaining original adapter slots plus C3R7.
Initial MCP75735 correctly exposed another code1-only gap; implementation now
accepts code2 for add, while rejecting code2.1/warnings. Fixed live85496 terminal PASS: verify-alternative-fixed.log and alternative-comparison.json exactly match native results. Native fixtures and11focused tests
PASS48808; typecheck passed. Do not rerun initial failing probes unchanged.

Live linked service15505 terminal PASS: native rack placement/Clone Multiple then
PCI change through non-root member updates both members to the four-slot result.
Evidence artifacts/pci-wizard-audit-2026-10-30/linked-report.json. Public linked
lifecycle1692 running at this update in artifacts/parity-pci-wizard/2026-10-30-linked-removal;
log /tmp/dcsc-pci-linked-removal.log. Maintained script now includes spare removal,
a second crash/restart, and --linked mode which checks both configurations after
MCP and website XML import. Release inventory now84commands (including linked PCI);
prior frozen82 and post-increment source evidence remain historical.

Two-processor catalog probe66035 terminal PASS: existing selected C5QR supports
quantity2. Standard configure changes the native active option from1P Rear5-a to
2P Rear10-a, still only one available option. Saved two-cpu.json / two-cpu.log;
this does not provide evidence for switching between multiple offered options.
Final focused check29610 PASS13tests (11PCI+2releaseinventory), build, targetedlint,
and diffcheck. No need to rerun completed captures to prove the same cases again.


PCI follow-up terminal results and live handoff:
- Public linked lifecycle1692 completed17MCPcalls, including both process crashes,
  undo/redo, non-root add/removal, subsequent derive and both-member MCP reimport.
  It exited1 only at browser response capture: Chromium inspector evicted the
  large response. Preserve its failure report; do not call this one full-run PASS.
- Browser-only95065 repeated the capture failure despite immediate response reads
  and enlarged CDP buffers. Replaced inspector body reads with an init-script
  listener that captures the website's own XHR response (no extra HTTP request).
- Corrected browser-only6233 TERMINAL PASS: both members retain three slots after
  native import of the exact exported XML. Evidence:
  artifacts/parity-pci-wizard/2026-10-30-linked-browser-xhr/report.json and
  mcp-browser-import.json. This establishes split-run linked lifecycle acceptance;
  the next frozen matrix should execute the corrected complete gate once.
- Maintained parity script supports --browser-only <xml> to repeat only handoff,
  without repeating live setup/clone/history/recovery. Default and --linked full
  flows remain in the84-command inventory.
- Full conformance66110 was intentionally stopped early (exit130): review found
  that the new setter had only an error-path call, which would inevitably fail
  the every-tool-success criterion. Added a real validated PCI edit to the
  existing reference workflow. Corrected conformance67221 RUNNING now, log
  /tmp/dcsc-pci-conformance2.log. Do not restart without checking this exact handle.
  Typecheck and lint passed before its launch. This is the only live job at handoff.


## Storage wizard lead and linked reference fix (current next work)

PCI conformance67221 TERMINAL PASS183/183checks, all83registered tools have a
success call. Log /tmp/dcsc-pci-conformance2.log. This covered the PCI increment
before the subsequent small export-group comparison fix described below.

A search of existing captures44683 found enabled storage wizards in historical
SID0001064 (7DJRCTO1WW/SR860V4) and SID0001066 (7DJUCTO1WW/SR850V4). Do not infer
storage-wizard absence from the earlier disabled SR650V4 example.
Native current inspect99848 PASS and select99331 PASS for SID0001064, category
1413a409a7cafabada4ac7c39a15a6e4. Native Storage -> Controller and Backplane has
options1-2,4-2,9-2,33-2. Radio select4-2 chooses twoC3RT backplanes and oneBM50
controller, userSelected=true. Adding B8NZ via its card retains BM50 as well,
produces a native storage-combination error, and sets delta; this is an accepted
editable state, NOT a valid controller replacement or manufacturing-ready design.
Reference also has preexisting missing-CPU/power errors. Preserve native diagnostics.

All new evidence is artifacts/storage-wizard-audit-2026-10-30/:
- inspect/, select/, frontend.txt, report.json summarize exact native contracts.
- roundtrip72834 TERMINAL PASS: native option/feature state exports and reimports
  with4-2/userSelected=true. Full export-data.json includes all four linked servers;
  native import returns the clone root and ownership data. XHR capture avoids
  Chromium inspector eviction; do not reuse failed inspector-body capture approaches.
- Native selection requests modify the root's storageWizardOption and customizingIds
  lists all four clones. Response root carries updateConfigurationIds for all members.
- request6 is option change: active=true,userSelected=true,solutionPrice=693.5,
  solutionPriceNum=693.5,delta:null. request7 adds B8NZ defaultValue1 alongside BM50=1;
  option price remains693.5 in that outgoing request; delta is copied to config.delta:
  {section:SAS_SATA_RAID_CONTROLLER,productNumber:7DJRCTO1WW,featureCode:B8NZ,
  quantity:1,isClear:false,mergeCtoCode:'',type:'hardware'}.
- buildQueryStorageWizard in frontend.txt removes Controller and Backplane sections,
  sets selected storageWizardOption, emits selected defaultValue features with
  storageWizardDerived=true/storageWizardDerivedQuantity. Drive-selection changes
  have extra semantics when userSelected=false; LFO/RAID-type changes have additional
  clearing/fixed-feature behavior. Inspect source before integration; don't guess.
- Ordinary configure72114 initially rejected before HTTP because a priced selected
  service on the clone root omitted priceNotAvailable while copies had false.
  Products/prices were otherwise equal (shippingStatus is already ignored).
  workspace-before.json and commercial-groups.json capture the exact mismatch.
- Fixed commercialCloneComparable in src/domain/exportGroups.ts to treat absent
  unavailable flag as false ONLY on a finite numeric price. True flags, unknown
  price and actual price/selection divergence remain significant. Regression verifies
  source immutability and genuine divergence rejection.
- Focused16415 PASS42tests (export groups+linked service), typecheck, targetedlint;
  corrected live compare-configure-fixed.log PASS. It reproduces native4-2 parts
  but userSelected=false, unlike the website true. Storage wizard tools/intent
  preservation are NOT implemented yet. No new tool count beyond83.

Next: implement native storage option/feature discovery and explicit selection,
including intent through derive/export/import, native diagnostics, linked ownership,
rollback and recovery. Retain ordinary generic feature editing where it already
works; do not claim it cannot configure these parts. Native feature additions do
not automatically replace another controller; featuresCombination is guidance,
not evidence that the UI automatically applies an entire combination. No live
process remains from this audit or conformance at this update.


## Storage wizard implementation and current verification

2026-10-30 continuation implemented src/domain/storageWizard.ts and
src/mcp/storageWizardTools.ts, integrated reduce/export and service transactions.
Public tools dcsc_storage_wizard and dcsc_set_storage_wizard bring the registry to85.
Select an exact optionId, or edit one offered feature quantity in the active option
with feature:{groupIndex,code,quantity}. Native option/userSelected intent, computed
UI pricing metadata, feature delta and wizard-derived section results are preserved.
Edits fan out to linked members; authoritative derive output and diagnostics are
retained. Saving an invalid editable combination is not manufacturing validation.
Mutation output includes requested/accepted component quantity and storage error counts.

Ordinary Controller and Backplane/RAID_CONFIG edits continue to send a null wizard
option so existing part editing remains possible; explicit wizard calls pin intent.
For drive changes, automatically selected options omit wizard-derived components,
while explicit userSelected choices remain in the request. Captured native payloads
are regression inputs in test/fixtures/parity/storage-wizard.json (trimmed catalogs,
exact storage options and controller sections retained).

Verification:
- Native option live91273 PASS, 4-2/userSelected=true matches website.
- Full suite66118 TERMINAL PASS987tests/126files before two additional storage tests.
- Focused88523 PASS9tests (7storage+2release inventory), typecheck/build/targetedlint.
  Tests cover exact option and feature payloads, native invalid-combination messages,
  offered quantities, drive-change semantics, CAS, failed derive, undo, lost explicit
  intent, failed durable write, and continued ordinary controller editing.
- Ordinary live36523 TERMINAL PASS after integration: same4-2 selected parts,
  userSelected=false, in compare-configure-integrated.log/configure-after.json.
- Maintained public lifecycle28006 TERMINAL PASS14calls,max2403bytes:
  artifacts/parity-storage-wizard/2026-10-30-run1/report.json. Four linked SR860V4
  servers edited through a NON-root member; option selection, two crash/restarts,
  stale revision, undo/redo, B8NZ addition with native error then BM50 removal to
  clear the storage error, unrelated UEFI derive, MCP and fresh website XML import.
  Native import root is collapsed but commercial server quantity remains4; MCP
  import expands and verifies all4members. This complete run passed in one invocation.
- Static/smoke/contracts50384 TERMINAL PASS85tools/17contracts, diffcheck clean.
- Updated release inventory85commands includes parity:storage-wizard. Frozen82
  remains historical. Updated conformance script now includes successful calls
  to both storage tools on SID0001064; conformance80954 RUNNING now in
  /tmp/dcsc-storage-wizard-conformance.log. Poll this handle before restarting.

Remaining storage-wizard coverage/work: native deselection when no HDD remains
(the current setter does not expose clearing the whole option), RAID-mode changes
and their native clearing rules, LFO fixed/preselected components, and other option
families. Generic RAID_CONFIG currently retains the previous generic behavior,
not a claim of the full frontend clearing contract. Native source confirms a
no-HDD deselect action; capture it before implementing. Other broader user-goal
items remain in the acceptance queue; do not mark complete from these85tools.

## 2026-10-30 storage whole-option clear increment

Conformance80954 TERMINAL PASS186/186 checks across85tools. Durable copy:
artifacts/storage-wizard-audit-2026-10-30/conformance-85.log. It certifies the
storage option/component core before the clear increment, not all website actions.

Native interactive97865 TERMINAL exit0; browser lock released. Captures in
artifacts/storage-wizard-audit-2026-10-30/clear/requests.json:
index6 removes BYLR drives, index7 clears the active option with
storageWizardOption:{activate:false,userSelected:false}; no controller/backplane
results remain. Restoring BYLR2 and clicking the active option produces the native
HDD warning with zero requests (guard.json). Index9 switches RAID5977→5978 after
native confirmation, clearing previous storage selections and sending null wizard.
raid-switch-contract.json records this as captured, NOT implemented. LFO handling
is still unverified; do not label this workflow API-unavailable.

Clear implementation: StorageWizardChange.optionId is string|null; null disallows
feature edits and configured drives, stages every catalog option inactive, and
requires native derive to retain the cleared state before commit. Native drive
selection comparison uses Internal Storage/NONRAID_HDD,CXL_MEMORY exactly, replacing
the broader RAID-name heuristic. New regression fixture includes native clear wire
and response; storage tests8PASS, release-checkpoint tests2PASS, typecheck/targeted
lint/build/85-tool smoke and diffcheck PASS. README describes the null action and
explicit remaining RAID-mode clearing gap. Release inventory now86commands with
parity:storage-wizard -- --clear; no new full frozen86-command claim.

Maintained clear live gate38355 RUNNING at this checkpoint, log
/tmp/dcsc-storage-clear.log, output artifacts/parity-storage-wizard/2026-10-30-clear.
It has passed drive guard and accepted clearing across four linked members.
Remaining history/restart/derive/export/MCP import/browser checks must reach terminal
before claiming complete. Poll this exact handle; do not restart a quiet run.
Broader objective remains active. Updated current gap classification is near the
top of .docs/roadmaps/2026_10_15_dcsc_parity.md; no defensible overall parity percent.

Clear gate38355 TERMINAL PASS21 public MCP calls,max2403bytes; fresh website import
also passed. All four linked SR860V4 members retain clearing through undo/redo,
third SIGKILL/restart, unrelated derive, XML export and MCP import. Native website
import retains no active option and commercial quantity4. Report and source hashes:
artifacts/parity-storage-wizard/2026-10-30-clear/{report,acceptance}.json.
No live jobs remain from this increment. Next concrete MCP work is the captured
RAID-mode clearing contract (CTO first; LFO remains separate), followed by the
remaining bounded family/access/legacy-input gaps. Goal active; no full parity claim.

## 2026-10-30 RAID-mode clearing increment (acceptance running)

Previous goal turn was progress: whole-option clear completed live acceptance.
This increment implements CTO RAID mode clearing through ordinary dcsc_configure.
Native contract is clear/requests.json index9 and raid-switch-contract.json.
isStorageRaidModeChange maps5978 separately from5977/2212 and requires native
storageWizardUI plus Storage/RAID Type/RAID_CONFIG. Actual transitions clear the
native subtab set and DERIVE_CABLE, including wizard components reduced without
subTabTitle; unrelated M.2 boot selections remain. Same-mode edits now preserve
wizard intent instead of nulling it. Transitions must be submitted alone so a
batch cannot silently discard newly requested storage parts. LFO transitions are
explicitly rejected pending verified fixed/preselected restoration; ordinary LFO
and nonwizard edits are unchanged. Tool description explains destructive semantics.

Native fixture now includes afterRaidMode and raidModeRequest plus actual offered
RAID_CONFIG features. Tests verify captured wire, undo, equivalent mode groups,
boot preservation, mixed-batch rejection, same-mode intent and LFO rejection.
Focused74547 TERMINAL PASS50tests/typecheck/build; static55262 TERMINAL PASS targeted
lint,85-tool smoke,2release-checkpoint tests,diffcheck. Full unit40382 TERMINAL
PASS993tests/126files, /tmp/dcsc-raid-unit.log. Registry remains85tools; maintained
release inventory now87commands with parity:storage-wizard -- --raid.

Live gate19115 RUNNING, /tmp/dcsc-storage-raid.log, output
artifacts/parity-storage-wizard/2026-10-30-raid. Passed forward5977→5978 switch
across four linked SR860V4 servers and undo. Pending redo/restart/derive/export/
MCP import/fresh website import. Poll exact handle; no full frozen87-command claim.

RAID live19115 TERMINAL PASS19calls,max2403bytes, including fresh website import.
Report and source-hashed acceptance in artifacts/parity-storage-wizard/2026-10-30-raid/;
unit-tests.log is a durable copy of the993-test full unit result. Native import
retains RAID5978 with no selected storage parts, no active wizard, and commercial
quantity4. All four MCP linked members retain the same state. No jobs remain.
Current gap table now marks this CTO workflow implemented; LFO fixed/preselected
restoration, reverse-direction live comparison and other families remain additional
work. The goal remains active. No full frozen87-command claim or new deployment.

## 2026-10-30 LFO availability survey and reverse RAID acceptance

Previous goal turn was progress: CTO forward RAID switch implemented/verified.
Current LFO survey46385/16806 TERMINAL PASS. Fresh General Purpose catalogs contain
12US server LFOs (3machine types) and21DE server LFOs (8machine types). One current
LFO per machine type per locale launched and primed successfully:11 configurations,
all storageWizardUI=false. Evidence artifacts/storage-lfo-audit-2026-10-30/report.json,
catalog-US.json,catalog-DE.json and per-product raw captures. No enabled LFO case;
NOT universal API absence. Fixed/preselected restoration remains unverified.

Native reverse browser85566 TERMINAL PASS: source capture in
artifacts/storage-wizard-audit-2026-10-30/reverse/requests.json. Native5977→5978→5977
uses null wizard for both transitions; reverse returns four inactive/unselected
options. Reverse begins with empty storage after forward clearing, not a separately
populated configured-RAID array. Updated regression fixture includes native reverse
request/response; dedicated regression tests the transition with zero current wizard
options. Focused34044 PASS14tests (12storage+2release),typecheck,targetedlint.
No production behavior changes needed in this increment.

Maintained public script now supports --raid-reverse. It switches forward then back,
checks5977/no storage/no active option, undo/redo,crash,unrelatedderive,export,MCP and
fresh website import. Live36764 RUNNING, log/tmp/dcsc-storage-raid-reverse.log,
out artifacts/parity-storage-wizard/2026-10-30-raid-reverse. Poll exact handle before
new runs. Release inventory now88commands,registry85tools; no full88-command claim.

Reverse live36764 TERMINAL PASS20calls,max2403bytes; fresh website import included.
Both MCP linked members (all4) and website handoff retain5977 with cleared storage
and no active wizard option; commercial quantity4 retained. Report/source hashes:
artifacts/parity-storage-wizard/2026-10-30-raid-reverse/{report,acceptance}.json.
No live jobs remain. Scope caveat: reverse follows a forward clearing; a separately
populated configured-RAID array remains untested. Next work can cover additional
wizard families (e.g. SR850V4/SID0001066), populated reverse clearing, or another
remaining API-supported gap. LFO implementation must wait for a genuine enabled
native case rather than infer fixed/preselected behavior from disabled catalogs.

## 2026-10-30 SR850 V4 mixed-backplane acceptance

Previous turn was progress: LFO survey and reverse RAID lifecycle completed.
Current SR850 probe29388 TERMINAL PASS SID0001066/7DJUCTO1WW,four linked servers,
12storage options. Native browser65441 PASS common4-2/B8NZ edit; native5686 PASS
mixed13-4/B8NZ edit. Evidence artifacts/storage-sr850-audit-2026-10-30/ with raw
probe and native/mixed requests. Option13-4 uses C3RT2+C3RU1 backplanes and BM501;
adding B8NZ preserves BM50 and produces native combination diagnostics, matching
existing editable-state semantics. Exact native option/section/feature-delta fixtures
added in test/fixtures/parity/storage-wizard-sr850.json. Regression verifies both
backplane results survive as distinct entries of the same section.

Maintained parity:storage-wizard now accepts --sr850, selecting13-4 on SID0001066
and replacing BM50 with B8NZ. Product/reference/option recorded in report. Unsupported
combinations of --sr850 and clear/RAID modes reject rather than imply unverified
coverage. Focused21703 TERMINAL PASS15tests (13storage+2release),typecheck,targetedlint.
Registry85tools; inventory89commands includes --sr850. No runtime fixes needed for
this family so far; no full89-command claim. No source deployments this increment.

Live98433 RUNNING, /tmp/dcsc-sr850-parity.log, output
artifacts/parity-storage-wizard/2026-10-30-sr850. Passed option/component edits,
linked4-member state,CAS,history,two crash/restarts,unrelatedderive and export.
MCP/fresh browser import pending. Poll exact handle; all other jobs terminal.

SR850 live98433 TERMINAL PASS14calls,max4481bytes,including MCP and fresh website
XML import. All4linked configurations retain13-4/userSelected=true,C3RT2+C3RU1,
B8NZ1; commercial quantity4 preserved. Acceptance/source hashes and report:
artifacts/parity-storage-wizard/2026-10-30-sr850/{report,acceptance}.json.
No jobs remain. README/current gap table updated. This closes the selected mixed
SR850 layout workflow, not every option or SR850 RAID-mode/clear variant. Broader
goal remains active; next work should target another remaining functional gap or
stronger populated RAID reverse evidence, not repeat these completed gates.

## 2026-10-30 memory survey and native source-port collision

Previous goal turn was progress: SR850 mixed storage lifecycle completed.
Memory survey76075 TERMINAL PASS: fresh US General Purpose catalog contains44
current server CTO entries; every /memory_wizard/productCode response is false.
Evidence artifacts/memory-wizard-audit-2026-10-30/survey.json. Existing launch/API
routes still exist. This is scoped availability, not universal API absence.

Native interactive browser54177 TERMINAL exit0,headless lock released. Imported
existing manual-data 100GbE XML containing source QSFP56 ports1+2 to switch ports49+60.
Website connection editor located via Floor and Cabling .anticon-retweet (a POPOVER,
not modal), then its .anticon-up-square rack selector. Edit row QSFP56-1; source
selector offers occupied QSFP56-2. Its dropdown was overlaid by native To card,
so DOM click was used (record this qualification). Save updates edited row to2
but leaves conflicting row2 unchanged. Native export form confirms duplicate
source endpoints in BOTH autoConnectResults/networkingInformation.autoConnectResults.
No actual atomic source swap. Captures/report/export-data.json/current.html in
artifacts/manual-source-swap-audit-2026-10-30. Source component location also displays
native 'Rack A1 undefined'; not repaired by this probe.

Keep MCP occupied-source rejection: error now explains native duplication and asks
for an unused source port. Added native before/export fixture and regression proving
rejection without input mutation. Focused62113 TERMINAL PASS12manual tests,typecheck.
Additional63259 lint/service/tool tests RUNNING at this checkpoint; poll handle.
README/current gap table distinguish native defect from API impossibility. No new
registered tools or release commands;89inventory remains historical/incremental,
not a new frozen result. Goal active. A separately constructed atomic source swap
might be implementable using seeded graph APIs, but has NOT been verified here.

Additional63259 TERMINAL PASS32service/tool tests,targetedlint,diffcheck. Total44
focused manual-cabling tests passed across3files. No live jobs remain. Next step
should pursue another functional gap or independently verify a safe atomic source
swap via native seeded graph APIs; do not imitate duplicate-port website output.

## 2026-10-30 correct atomic source-port swapping implemented

Previous goal turn was progress: native duplicate-source defect and memory survey
captured. Source API probe51766 TERMINAL PASS: constructing both rows as a swap
and submitting seeded /auto_connect retains exact graph/cardinality. Evidence
artifacts/manual-source-swap-api-2026-10-30/{request,response,report}.json. Thus native
UI defect was NOT an API limitation. Supersedes previous occupied-source rejection.

Runtime now allows same-component, same-connector-name, same-assigned-network and
same-topology source swaps via dcsc_edit_cabling_connection. Existing symmetric
collision planner moves both endpoints atomically; output reports swappedConnections.
Cross-component/side/network/connector mismatches, multiple occupants and changed
collision rows remain rejected. Cable selections/quantities/destinations/distances
are unchanged. Native collision fixture now also includes API-accepted correct
swap; regression distinguishes duplicate UI behavior from correct MCP behavior.

Maintained scripts/parity-manual-source-swap.ts plus native exported seed XML;
package command parity:manual-source-swap,release inventory90commands,registry85tools.
Live24436 TERMINAL PASS9calls,max1851bytes: inspection ID,atomic swap,stale rejection,
undo/redo,SIGKILL/restart,XML export,MCP import,fresh website graph and commercial
parity. artifacts/parity-manual-source-swap/2026-10-30-run1/{report,acceptance}.json
contains source hashes. Focused91639 PASS46tests/typecheck/build/85toolsmoke;
79342 targetedlint/diffcheck PASS;2091 rerun12domain tests PASS after native API
endpoint comparison was added. No live jobs remain. No full frozen90-command or
all-topology claim. Broader goal active; no deployment this increment.

## 2026-10-30 immutable90-command integration checkpoint RUNNING

Previous goal turn was progress: atomic source-port swapping completed live acceptance.
Current preflight34422 TERMINAL PASS:90commands,78untrackedinputs,114fixturedependencies,
no missing or ignored runtime dependencies. Manifest:
artifacts/release-2026-10-30-wizards-source-swap/preflight/manifest.json.
Tracked patch SHA256 c130450c90603d1f2dc42ed8be26fca727e4d13f70f111aee4363fbf7c0f9819.
Detached checkout /tmp/lenovo-dcsc-release-2026-10-30-wizards-source-swap materialized
from HEADb96632a plus exact patch/untracked/ignored docs. Clean npmci74916 TERMINAL
PASS270packages,0vulnerabilities. Existing82-command runner copied unchanged (hash
recorded in report), then started new full matrix. No snapshot mutations permitted.

LIVE EXEC SESSION79661: full90-command release run. Report/active handle under
artifacts/release-2026-10-30-wizards-source-swap/{results/report.json,active.json}.
Manifest-before verification PASS. Commands1typecheck and2lint PASS;3fulltests RUNNING
at this checkpoint. Poll79661, never restart merely because quiet. Headless commands
serialize with /tmp/lenovo-dcsc-headless.lock. No other live jobs. Known declared
blocked exits remain GB300 power/DWC,tested FC routing,and two breakout handoff gates;
these are not automatically failures or successes and must be checked in final logs.
Goal remains active: account-only features, genuine legacy recovery input, enabled
LFO/memory cases and broader physical/topology coverage remain unresolved. This
snapshot proves only its actual passing scope, not whole website parity.

Checkpoint update:79661 remains LIVE,10/90commands PASS,0fail/0blocked so far.
Full unit command3 PASS996tests/126files;offlinecontracts4,build5,audit6(0vulnerabilities),
compiledlive smoke7,exportsmoke8,MCPsmoke9,offlineparity10all PASS. Command11live
contracts RUNNING. Progress is11.1% by command count, not elapsed-time or website
feature parity. Poll79661 on continuation; do not rerun completed commands.


### Service export boundary audit (2026-10-30)

Previous status turn was a verified wait: polled live release session79661. Current frozen90-command matrix has11pass/0fail/0blocked and command12 conformance running. Do not restart it. Static inspection of the captured native bundle confirms independent service export builds service-only covered-product/service summary and uses `/service_pacs/export`; evidence `artifacts/service-export-boundary-audit-2026-10-30/report.json` records source hash and excerpts. Keep the current separate-export guard; no mixed-export API absence claim is justified by this inspection. No runtime changes made during this audit.


### Populated RAID reverse-switch capture in progress (2026-10-30)

Release session79661 remains live:14/90 completed,13pass/0fail/1declared blocked (GB300 missing power and dependent DWC); command15 software-export started. The native conformance command12 passed. No frozen source modifications.

Additional native audit script `artifacts/storage-wizard-audit-2026-10-30/populated-raid.ts` is live as exec54244 under the shared headless flock. Poll that exact handle; no duplicate restart. Earlier captures72480/6558/49283/6879 terminal successful;20553/30265 terminal UI-selector failures, now corrected. It launches SID0001064, switches5977→5978, sets B8NZ1/C3RT2, selects RAID1 B9XD, then is intended to select AUM1 drives2 and reverse5978→5977. B8NZ/C3RT/B9XD native selections already captured; drives/reverse not yet verified.

Native controls: use `[name=CONTROLLER_1_ARRAY_1_FOR_SAS_SATA]` click/evaluate to expand custom section; outer `.ant-collapse-header` did not work. Exact text `Controller 1 HW RAID Array 1 RAID 1` selects radio. Drives section `[name=CONTROLLER_1_ARRAY_1_SAS_SATA_HDD]`; select AUM1 radio in `.testFeature` first, then its quantity selector should appear. Audit outputs in `artifacts/storage-wizard-audit-2026-10-30/populated-raid/`; current.txt may reflect intermediate stage. Failure files are historical unless script exits nonzero. Next: inspect54244 result, compare populated reverse wire contract with MCP, add focused regression/maintained lifecycle if warranted. Production source unchanged this turn.

Update: native capture54244 terminal PASS (`POPULATED_REVERSE_COMPLETE`). report.json asserts actual RAID1 B9XD1 + AUM1 drives2 + B8NZ1 + C3RT2 before reverse and only RAID_CONFIG5977 afterward across these storage tabs. Captured request/response ready for MCP comparison; that comparison and lifecycle remain pending. No native audit job remains live.


### Claude advisor checkpoint — scope correction (2026-10-30)

User explicitly requested `$claude` before next change to avoid overengineering/endless tests. Read /home/miquel/.agents/skills/claude/SKILL.md; consult completed via documented temporary argv terminator fix. Exact resumable output /tmp/codex-claude-dcsc-scope-20261030/answer-retry.md, session1e68a66d-031c-4272-a7f0-77c3b8608f00, copy artifacts/claude-scope-review-2026-10-30/answer.md. Advisor: delivered real features but recent variants drift; finish current release, make website user-action inventory, don't add another populated RAID lifecycle. Candidate manual connection deletion needs native/MCP verification (not confirmed missing). Accepted: no extra RAID gate or broad product availability surveys; prioritize concrete missing actions/defects. Overall objective remains active and full parity unproven; unavailable/access-dependent cases stay qualified. Advisor's suggestion to tag/publish is advice, not new user authorization.

Populated RAID comparison: added test/fixtures/parity/storage-raid-populated.json (native Storage-tab projection) and14th test in test/storage-wizard.test.ts. 14/14 pass12775; typecheck/lint38934 pass, diff-check pass. Native target must be matched by id in multi-config request, not configurations[0]. MCP delta includes previous5978/quantity1 in addition to native fields; exact storage selection clearing and atomic undo pass. Full captured configuration live replay6911 PASS, artifacts/storage-wizard-audit-2026-10-30/populated-raid/mcp-live-report.json. Initial reduced Storage-only live replay83770 cleared correctly but had no wizard catalog because omitted Base; superseded by full native replay. No production fix needed. Do not add another lifecycle/matrix command for this case. New test/fixture are outside frozen90 snapshot; runtime is unchanged.

Release79661 last confirmed live,17/90 done16pass/0fail/1expected upstream block,18 services running. Continue exact handle, never restart on silence. Next actionable work: concise screen/action inventory, first settle manual deletion candidate, while current frozen release completes.


### Action inventory after Claude review (2026-10-30)

Manual deletion candidate was checked against captured native connection table/editor DOM and renderer in current captured app bundle. Table has Edit; editor Close/Save; no native Delete action established. Scoped evidence artifacts/manual-delete-audit-2026-10-30/report.json. Do not infer API absence or implement speculative deletion. README already documented this limitation; advisor's candidate was not a newly proven gap. Added concise audited user-action inventory and stop rule to roadmap before gap table. Inventory explicitly incomplete, no full parity percentage. Next milestone finish existing release and prepare delivery; new code only for demonstrated user action/defect, not endless variant gates.

Release79661 verified live:19/90 completed18pass/0fail/1expected upstream block, command20 controls-locale running. Runtime unchanged; only populated RAID test/fixture and documentation outside frozen90 snapshot. No new runtime gate added.


Delivery documentation update: README Status now includes PCI/storage wizards, power controls and native reference solutions. Explicitly identifies82-command snapshot as predating wizard additions and90-command run as ongoing; links action inventory. No runtime changes/tests added; diff-check passes. Release79661 remains live:20/90 completed19pass/0fail/1expected block;21 network running.


### Release first unexpected failure — native nested menu (2026-10-31)

Release79661 still LIVE: command80 `parity:nested-vlh` failed exit1 after125314ms, counts75pass/1fail/4expected blocks (80/90 finished);81 `parity:nested-stdio` running. Failure waits15s for Already Configured Nodes submenu `[7DD1CTOLWW] Node ... Non Rack Area` at scripts/parity-nested-vlh.ts205. Native body still lists loose node; captured initial menu Servers/Already Configured Nodes, but post-hover menu snapshot is[] (menu disappeared). Evidence frozen artifacts/parity-nested-vlh/2026-10-30T23-14-27-912Z/{failure.json,move-options-7DD1CTOLWW.json,move-expanded-options-7DD1CTOLWW.json}. No runtime fix justified yet.

Targeted unchanged-frozen-script rerun is LIVE exec64860 under shared headless flock: `npx tsx scripts/parity-nested-vlh.ts --out=/home/miquel/projects/lenovo-dcsc/artifacts/release-2026-10-30-wizards-source-swap/nested-vlh-recheck`, cwd frozen checkout. Poll64860 separately, don't duplicate. Original failure must remain in release report; recheck supplements it. Both79661 and64860 must be tracked. No source mutation this turn.

Nested menu recheck64860 terminal PASS exit0: unchanged frozen script completed native placement/export/fresh browser import,17captured calls, nodeCount2, import200. Evidence artifacts/release-2026-10-30-wizards-source-swap/nested-vlh-recheck/{result,resolution}.json. Intermittent native UI interaction failure supported; no source/runtime change. Preserve original command80 failure in matrix; report separate passing recheck. Only79661 remains live (81 nested-stdio last observed).


### Frozen90 release finished (2026-10-31)

Exec79661 TERMINAL exit1 because original matrix retains command80 native nested-menu failure. All90commands ran:85pass/1fail/4declared upstream blocks. Final headless passed; beforeVerification and afterVerification both pass. Dates21:14:39→23:35:01UTC (~140min). Command80 unchanged frozen rerun64860 terminal pass, nested-vlh-recheck/result.json and resolution.json; no other live jobs. No runtime defect found or fix applied. Do not restart matrix.

Authoritative working-tree comparison against frozen checkout: only README, context, roadmap and test/storage-wizard.test.ts + new test/fixtures/parity/storage-raid-populated.json differ. Runtime/package/scripts byte-identical. Evidence working-tree-differences.json in release artifact folder. Added regression14/14pass and typecheck/lint previously pass; documentation updated to90-run qualified result, not falsely green. Next: package/deliver reviewed changes within existing authorization; inspect git state/history and publication authorization first. Broader goal still active, access/legacy gaps unresolved; no new variant suite.
