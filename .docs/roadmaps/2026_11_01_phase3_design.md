# Phase 3 design: target surface, structure and fix list

**Date:** 2026-11-01 · **Plan:** [2026_11_01_review_cleanup_plan.md](2026_11_01_review_cleanup_plan.md)
**Inputs:** website inventory [.docs/website-actions.md](../website-actions.md) (111 actions, 97 work anonymously). Reviews R1–R7 and the verification logs are local in `/tmp/dcsc-review/`: 66 code findings, of which 59 confirmed, 6 partly right and 1 rejected; plus 12 parity findings and a 32-row gap table.

## 1. Scope decisions

| Item | Evidence | Decision |
|---|---|---|
| AI configurator (`dcsc_ai_recommend`, `domain/aiConfigurator.ts`) | Website shows it only to signed-in integration users (`showAssistantFunc`, `showAIConfigCondition`); no anonymous call observed | Remove |
| Memory wizard (`memoryWizardAction`, `domain/memoryWizard.ts`) | `/memory_wizard/productCode` returns false for every product tried | Remove |
| CFXML validation (`cfxmlContent` on `dcsc_validate`) | Upstream: "only ecomm has this function" | Remove |
| `GROUP_XLS`, `P2P_XLS` direct reports | Paths only in the bundle; website never seen calling them. The website's P2P export is the `P2P_BY_RACK` export type | Remove; add the website's export types instead |
| Auto-save restore | Needs a login token | Out of scope |
| Manufacturing validation | Website's own call fails upstream ("LMC server error … 400"); worked on 2026-10-15 | Keep; harness reports it blocked until upstream recovers; align payload with the website capture |
| Config ID generate/import | Retrieve list is empty anonymously; generate is unproven | Keep only if the harness proves it; otherwise remove |
| Local-only helpers | No website counterpart | Keep the helpful ones: `explain` and `smart_recommendations` fold into `dcsc_configuration_get` (preconfigured alternatives must pass a harness case); `scale_out`, `compare_scenarios`, `diff_sessions` merge into `dcsc_compare`. Remove `blueprints`/`start_from_blueprint` (agent-written, not Lenovo data) |

## 2. Tool surface

Rules:
- One tool per website panel, so an agent maps a user request to one tool.
- Reads and writes are separate tools, so read-only flags are true.
- A `kind` switch only where every kind takes the same inputs and returns the same shape.
- One handle parameter `session` (configuration or workspace) and one `expectedRevision`. The alias Proxy is deleted.
- Annotations are declared with each tool, not in name lists.
- Descriptions say when to use the tool, in one or two sentences. Cross-tool workflow guidance lives once, in the capabilities resource.
- Responses are compact JSON within one central byte budget. Artifacts are returned as paths.

| Target tool | Website panel / action | Replaces |
|---|---|---|
| `dcsc_settings_get` / `dcsc_settings_set` | Locale, solution mode, Settings popover (withdrawn-since, distributor stock) | list_locales, set_locale, solution_modes, capabilities |
| `dcsc_search` | Product, part, SID, preconfigured (LFO) and specialty search, incl. `isAiExpress`, withdrawn filters | find_products, find_parts, query_sids, specialty_catalog, cto_lfo_codes, browse_catalog |
| `dcsc_category` | Category pages, sub-category filters, family page | category_detail (discovery modes), service_categories |
| `dcsc_reference_solutions` | Reference solution list/detail | reference_solutions |
| `dcsc_launch` | Customize: CTO, LFO, LFO-as-CTO, reference solution, standalone software/services basket, unconfigured | launch, launch_reference_solution, software_launch, services_launch, load_unconfigured |
| `dcsc_configuration_get` | Configurator tabs/sections, feature detail, resource tracker, errors, recommendations | list_options, get_feature, feature_details, get_configuration, subtab_recommendations |
| `dcsc_configure` | Option changes, quantity, name/colour, Guided/Expert, Auto-Correct, AI Express/Full toggle | configure, set_quantity, set_unconfigured, set_configuration_controls |
| `dcsc_wizard_get` / `dcsc_wizard_set` | PCI and storage wizards | pci_wizard, set_pci_wizard, storage_wizard, set_storage_wizard |
| `dcsc_auto_fix` | Auto-fix / error customise | auto_fix |
| `dcsc_workspace_get` | Workspace: racks, floor, items, baskets, history | list_racks, workspace_layout, session_info, workspace_history, standalone/software/services inspect |
| `dcsc_rack_add` | Add rack/container, change rack model | add_rack |
| `dcsc_rack_edit` | Place, move, unplace, remove, lock, clone, copy, colour, logical groups | place_in_rack, edit_layout, set_rack_lock, copy_rack_item, clone_configuration |
| `dcsc_floor_set` | Floor placement, floor preferences, Auto Arrange, COG validation | place_on_floor |
| `dcsc_pdu_set` | PDU preferences and cords | configure_pdu |
| `dcsc_network_get` / `dcsc_network_set` | Network tab: topologies, connectors, node roles, preferences | fabric_options, network_connectors, set_topology, set_node_role, set_network_preferences |
| `dcsc_vlh_get` / `dcsc_vlh_set` | VLH wizard info and attributes / item create, import, export | vlh_wizard_info, vlh_attributes |
| `dcsc_auto_connect` | Auto-Connect | add_cabling (auto) |
| `dcsc_cabling_get` / `dcsc_cabling_set` | Cable configuration panel | cabling_connections, manual_cabling_options, create/edit_cabling_connection, add_cabling (manual) |
| `dcsc_storage_get` / `dcsc_storage_set` | Storage networks, controllers, switches | storage network/controller/switch tools (6) |
| `dcsc_power_get` / `dcsc_power_set` | Power report and controls | power, power_controls, set_power_controls |
| `dcsc_basket_browse` / `dcsc_basket_set` | Standalone software, hardware and services: browse, add, quantity, remove | 17 software/hardware/services tools |
| `dcsc_validate` | Validation and manufacturing validation jobs | validate, validation_jobs, verify_mandatory_software |
| `dcsc_export` | Every website export type incl. `QUOTE_REFERENCE`, `P2P_BY_RACK`, `VLH`, power report, configuration tree, services/software zips, reference XML | export, software_export, services_export, export_configuration_tree, download_reference_solution |
| `dcsc_import` | Import from configuration file | import, import_config_id |
| `dcsc_session_list` / `dcsc_session_close` / `dcsc_undo` | Session housekeeping, undo/redo | session_list, session_close, undo, health, recovery_* |
| `dcsc_compare` | Local analysis: scale-out sizing, scenario compare, part diff | compare_scenarios, diff_sessions, scale_out, summary_insights |

That is 36 tools including `dcsc_compare` (from 108), targeting ≤ 35 KB of definitions (from 112 KB). Mode-specific defaults (HPC `controlExpressModal=false`, quote type absent) come from the mode's `systemFunctionList`, which is stored today but never read.

## 3. Module layout

Adopt R3's layout:
- `model/` holds pure types, including the session types moved out of `SessionStore.ts`; this removes the domain↔session cycle.
- New `domain/endpoints.ts` is the only owner of paths and wire families. It fixes the `lfo-as-cto` divergence.
- New `session/ids.ts` is the only owner of id formats.
- `app/` holds feature workflows split out of `service.ts`, plus the standalone logic moved out of `standaloneTools.ts`.
- `mcp/*Tools.ts` handlers only parse, call one `app/` function and project the result.
- One shared `util/coerce.ts` replaces the divergent `num`/`str`/`isObject` copies.
- The ~25 pass-through wrappers and the dead `SessionStore` mutators, `create` and `racks` field are deleted.

## 4. Persistence

Causes: startup restores and deep-clones the whole 91 MB file (5.6 s), and every change clones and rewrites all of it plus a full rollback copy (~4–5 s), with history storing full nested snapshots.

Design:
- One file per workspace, written only when that workspace changes.
- Atomic temp-file + rename; no rollback copy.
- Workspaces are loaded on first access; startup reads only an index.
- History keeps the last N snapshots without nested configuration copies, and clones only what it keeps.
- No migration: the old `sessions.json` is renamed to `sessions.json.bak` and ignored.

Target: startup + tool listing < 0.5 s; local work per change < 100 ms on the same data.

## 5. Parity harness

Adopt R6's design. One runner, `tsx scripts/parity/run.ts <case|tag|all>`, takes the place of about 60 npm aliases. Cases are `{ id, tags, run(h) }`.

The harness owns:
- the stdio MCP client, with a response-budget check;
- one headless Chromium recipe and the shared UI primitives;
- `compare(webEvidence, mcpEvidence, { normalize, expectedDifferences })` and `skip(reason, proof)`;
- normalizers written once;
- report generation from the recorded evidence.

Status rules:
- **pass:** every compare has zero unexpected differences.
- **fail:** an unexpected difference, a thrown step, or no compare at all.
- **known-difference:** an exact declared exception, with a doc reference.
- **blocked:** only through `skip` with a captured upstream error. It is re-checked each run and fails once the call succeeds.

`parity-power-controls.ts` is the reference case. The phase 0–3 scripts are deleted.

## 6. Ranked fix list (must-fix)

1. Tools marked read-only that change state (`power_controls`, `pci_wizard`, `storage_wizard`, `export_configuration_tree`). Fixed by section 2.
2. Hollow gates: status literals, HTTP 400 counted as anonymous. Fixed by section 5.
3. Direct and tree exports: arbitrary-path writes, unbounded buffering, base64 in responses. Route through the artifact store.
4. Upstream bodies leak through JSON re-parse; raw transport errors are unwrapped (`http/request.ts`, `discoveryHelpers.ts`). Parse once, in `http`.
5. Silent fallbacks:
   - hard-coded product `7D73CTO1WW` and tab `Memory`;
   - Nightingale error codes ignored (removed with the feature);
   - share-URL failures swallowed;
   - missing prices counted as 0 in diffs and subtotals.
6. `lfo-as-cto` standalone exports go to the `lfos` endpoints. Fixed by `domain/endpoints.ts`.
7. Persistence startup and per-change cost. Fixed by section 4.

Should-fix items (duplication, dead code, schema clarity, caching and in-flight coalescing, stale tests) are absorbed by the packages below. `later` items are recorded in the logs and not scheduled.

## 7. Parity work (from R7 and the inventory)

**Gaps:**
- export types `QUOTE_REFERENCE`, `P2P_BY_RACK`, `VLH`, and mode-aware default types;
- VLH item create/import/export;
- Auto Arrange and COG validation toggles;
- AI Express/Full toggle and `isAiExpress` filter;
- Show Errors and resource tracker;
- withdrawn-since refetch (`withdrawnDate`) and `serviceCto=true`;
- floor grid and distance preferences, distance calculator;
- rack colour, change rack model, logical groups, add container;
- services export (`/service_pacs_download/{code}`), download catalog, `/service_pacs_product`;
- software search (`/software/portal/search/{code}`);
- add hardware to a rack (`/ctos/racks/hardware`, `new_hardware`, `AddAndCustomize`).

**Request mismatches:**
- HPC `controlExpressModal`;
- LFO launch `scope`;
- rack launch and `pduPreference`;
- autoFix `configurationId` / `selectedTceAudience` / `showExpressMode`;
- validation payload keys.

**Unverified:** about 30 endpoints the MCP calls that were only ever mined from the bundle. Each is proven by a harness case or removed.

## 8. Execution packages

| # | Package | Depends on | Parallel with | Model |
|---|---|---|---|---|
| E1 | Harness + port maintained gates; delete phase 0–3 scripts and dead scripts (keeping those `release-checkpoint.ts` uses, or rewiring it) | — | E2a | Sonnet (port: Haiku) |
| E2a | `util/coerce`, `model/` session types, `session/ids.ts`, `domain/endpoints.ts` (incl. fix 6) | — | E1 | Sonnet |
| E2b | Split `service.ts` / `standaloneTools.ts` into `app/`; delete wrappers and dead code. No behaviour change | E2a | — | Sonnet |
| E3 | Tool surface (section 2), annotations, single handle/revision, compact responses, central budget; remove out-of-scope features (section 1) | E2b | E4 | Sonnet |
| E4 | Persistence redesign (section 4) | E2b | E3 | Sonnet |
| E5 | Fixes 3–5 | E3 | E6 | Sonnet |
| E6 | Parity gaps and mismatches (section 7), one sub-package per panel, each closed by a harness case | E1, E3 | E5, each other | Sonnet |
| E7 | Tests: merge or delete stale suites, add pricing and concurrency coverage, update fixtures | E3–E6 | — | Sonnet / Haiku |
| E8 | Docs (README, context, AGENTS.md), retire old roadmaps, prune `artifacts/` to the latest report per gate plus anything the docs cite | all | — | Haiku |

After each package the orchestrator runs `npm run check`; after E1 and each E6 sub-package, the affected harness cases, serially.

## Decisions (2026-11-01)

- Removals: AI configurator, memory wizard, CFXML validation, `GROUP_XLS`/`P2P_XLS` removed. The AI configurator (Lenovo internal SSO user modes) and the quote export (likely login-gated) are recorded under "Authenticated backlog" in `website-actions.md`, to rebuild only with real credentials.
- Local helpers: as in section 1.
- Session file: start fresh, keep `sessions.json.bak`.
- `artifacts/`: keep the latest report per gate plus anything the docs cite.
- `AGENTS.md`: tracked via `!AGENTS.md` in the repo `.gitignore`.
- Design approved as written; execution starts with E1 and E2a.
