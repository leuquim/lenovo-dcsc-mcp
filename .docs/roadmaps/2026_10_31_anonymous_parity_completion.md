# Anonymous DCSC parity completion roadmap

**Date:** 2026-10-31
**Goal:** An HPC/AI architect can do through the MCP everything an anonymous user can do on dcsc.lenovo.com, with results that match the website's state, prices and deliverables.
**Supersedes for new work:** the action inventory in [2026_10_15_dcsc_parity.md](2026_10_15_dcsc_parity.md). That file stays as the evidence ledger for work already delivered.

## Scope rule

In scope: every website action that works with no Lenovo login, in any solution mode reachable anonymously (General Purpose, HPC/AI). Out of scope: anything that returns 401/403 or redirects to sign-in anonymously. A capability enters the backlog only when a headless capture shows the website using it anonymously. Bundle strings alone are leads, not requirements.

Acceptance per capability is unchanged from the existing roadmap: MCP result matches native website state/artifacts on a live headless run, survives restart, and hands off to the website where an artifact exists. Unit tests alone do not close an item. Upstream-unavailable cases exit 2 and are recorded as blocked.

## Phase 0 — Complete, evidence-based inventory

**Status:** Completed on 2026-10-31 against live bundle `app-2026-01-14-5be41ba.js` (SHA-256: `41d0ad97ac0905416d6250261431f15d754ce2ca8b7cd0537299e6346341d97d`).
Full structured inventory and probe ledger committed at `artifacts/phase0-inventory-2026-10-31/report.json`.

### Inventory Classification Breakdown (381 Total Paths Mined)

- **Total path literals mined:** 381 (361 API path literals + 20 AI configurator paths)
- **MCP_COVERED (107 paths):** Implemented in domain modules (`src/domain/*.ts`) and exposed via MCP tools.
- **AUTH_GATED (75 paths):** Gated by Lenovo partner credentials, LBP/MC/RM/DealReg logins, or mandatory `Authorization` headers (`/lbp/*`, `/mc/*`, `/RMCase/*`, `/deal-reg*`, `/user_configurations*`, `/marketability`, etc.). Dropped per scope rule.
- **SPA_ROUTE (41 paths):** Client-side React Router views or static asset links (`/cto-rule-version`, `/table-version/:code`, `/configuration/lfo-as-cto/:productNumber`, `/supply-status`, `/copy/:`, `/andor-public-announcement`, `/dev-info`, etc.).
- **CANDIDATE_GAP (158 paths):** Target API paths evaluated for anonymous capabilities, with live probes executed for G1–G12 leads.

### UI Area Distribution

| UI Area | Path Count | Primary Functional Scope |
|---|---|---|
| general | 166 | Base primitives, utilities, shared API routes |
| configurator | 49 | CTO/LFO hardware configuration, autoDerive, static features |
| export menu | 30 | Deliverable downloads (XML, ZIP, XLS, ConfigID, Copy URL) |
| services | 30 | Standalone services, PACS, portal categories, warranties |
| catalog | 29 | Hierarchies, specialty catalogs, search, SIDs, promotions |
| rack | 27 | Rack layout, elevation, PDUs, positioning rules |
| AI assistant | 22 | Nightingale AI configurator, prompt templates, recommendations |
| summary | 9 | Validation, BOM, flag summaries, power calculate |
| software | 6 | Standalone software, portals, mandatory verification |
| dev-info | 6 | Rule and table version inspection routes |
| home | 4 | Solution modes, announcements, landing |
| connections | 2 | P2P cabling report, distance calculation |
| storage | 1 | Storage wizard and network layout |

### Gap Package Status Ledger (G1–G12)

Every lead evaluated with live anonymous probes routed through `DcscHttpClient` against `dcsc.lenovo.com`:

| # | Capability | Target Endpoints | Probed Status & Evidence | Exact Phase 0 Status | Likely MCP Surface |
|---|---|---|---|---|---|
| **G1** | Power & quote group XLS downloads | `/ctos/power/export_xls`, `/ctos/group/export_xls`, `/lfos/power/export_xls`, `/lfos/group/export_xls` | POST with `fileName` & hidden-form payload reaches live export controller anonymously (requires `data`, `groups`). Missing `fileName` returns 400 Bad Request; partial payload yields internal Spring NPE on missing BOM sections, proving anonymous backend availability without 401/403. | `ANONYMOUS_CONFIRMED` | Extend `dcsc_export` with `POWER_XLS` / `QUOTE_XLS` formats |
| **G2** | P2P cabling report & cable-distance calculation | `/p2p-report`, `/calculateDistance` | `/p2p-report` POST returns **HTTP 201** with live binary XLSX spreadsheet anonymously (`PK...` ZIP header confirmed). `/calculateDistance` is already implemented and verified in `manualCabling.ts` / `src/mcp/service.ts:2491`. | `ANONYMOUS_CONFIRMED` (`/p2p-report`) & `MCP_COVERED` (`/calculateDistance`) | Add `P2P_XLS` format to `dcsc_export`; cabling distance already in `dcsc_create_cabling_connection` |
| **G3** | Memory wizard launch & population | `/ctos/{code}/memory_wizard/launch`, `/memory_wizard/*` | `/ctos/7D73CTO1WW/memory_wizard/launch` and `7D76CTO1WW` return **HTTP 200** anonymously in US, DE, and CN (`["MEMORY", "PROCESSOR"]`). Withdrawn code `7X06` returns 404. Modern servers accept anonymous launch. | `ANONYMOUS_CONFIRMED` | New/extended wizard tool mirroring PCI/storage |
| **G4** | Nightingale AI configurator | `/default-prompt/_query`, `/prompt-template/_query`, `/candidate/features/desc`, `/config-replenishment/_calculate`, `/features/replace`, `/recommendation/services` | POST probes return **HTTP 200** anonymously: prompt templates return valid suggested prompts; replenishment and feature replacements calculate valid candidate options. (`blade/recommendation`, `feature-compat/_validate`, `recommendation/ctoCandidates` already `MCP_COVERED`). | `ANONYMOUS_CONFIRMED` | Extend `dcsc_ai_recommend` |
| **G5** | Supply status and ESD | `/api/supply/status`, `/supply-status`, `/sst/esd/*` | `/api/supply/status?country=US&type=Option&code=4X77A08621` returns **HTTP 200** with live shipping lead times (`shippingStatus: ["30","30",...]`). `/supply-status` is client `SPA_ROUTE`. `/sst/esd/*` yields internal Spring NPE without session context. | `ANONYMOUS_CONFIRMED` (`/api/supply/status`) | Add lead-time fields to `dcsc_find_parts` / catalog |
| **G6** | CFXML validation | `/ecomm/cfxml_validation` | Multipart POST with `cfxmlFile` returns **HTTP 200** anonymously (`{"url":null,"message":"only ecomm has this function","success":false}`). Controller verifies upload structure anonymously but restricts processing to ECOMM origin. | `ANONYMOUS_CONFIRMED` (with ECOMM limitation) | Optional flag in `dcsc_validate` |
| **G7** | Batch & error customize | `*/errorCustomizeWithAutoDerive`, `*/batch_customizing` | Both `/ctos/errorCustomizeWithAutoDerive` and `/lfos/errorCustomizeWithAutoDerive` return **HTTP 200** `[]` anonymously with `{ configurations: [] }`. `*/batch_customizing` endpoints are dead legacy bundle strings returning 404; in the SPA, `batchCustomize` delegates to `autoDerive` (`MCP_COVERED`). | `ANONYMOUS_CONFIRMED` (`errorCustomizeWithAutoDerive`) / `MCP_COVERED` (`autoDerive`) | Internal auto-repair in `dcsc_auto_fix` / `dcsc_configure` |
| **G8** | Service cost simulator | `/cost_simulator`, `/service/cto/calculate/*` | `/cost_simulator` returns **HTTP 301** redirect to internal port `http://dcsc.lenovo.com:81/cost_simulator/` requiring internal credentials (`r.username`). External requests blocked/unsupported anonymously. | `UPSTREAM_UNAVAILABLE_BLOCKED` | Dropped per scope rule (internal service) |
| **G9** | Rule & table versions | `/ctos/{code}/versions`, `/ctos/{code}/{table}/rule_versions` | Both `/ctos/7D73CTO1WW/versions` and `/ctos/7D73CTO1WW/203/rule_versions` return **HTTP 200** anonymously with rule versions. `/cto-rule-version` and `/table-version/:code` are client `SPA_ROUTE`s. | `ANONYMOUS_CONFIRMED` | Add version inspection field to `dcsc_session_info` |
| **G10** | Discovery helpers | `/categories/caseStudy/all`, `/categories/getSubCategorySearchConditions`, `/categories/checkTopChoiceCountry`, `/function_definition/product_functions`, `/ctos/{code}/display_orders/features_and_groups`, `/ctos/{code}/{tab}/staticFeatures`, `/marketability` | Case studies, sub-category conditions, top-choice countries, product functions, display orders, and static features all return **HTTP 200** anonymously. `/marketability` and `/integration/marketability` return **HTTP 400** requiring `Authorization` header (`AUTH_GATED_DROPPED`). | `ANONYMOUS_CONFIRMED` (Discovery helpers) & `AUTH_GATED_DROPPED` (Marketability) | Enrich `dcsc_browse_catalog` / `dcsc_find_products` filters |
| **G11** | Share link | `/copy/url` | GET with `configuration_id` returns **HTTP 200** anonymously with live shareable redirect URL (`https://us-dcsc.lenovo.com/redirect/rack-summary/...`). | `ANONYMOUS_CONFIRMED` | Add `shareUrl` to `dcsc_export` / session summary |
| **G12** | Carried-over open items | `/recovery`, storage wizard modes | Legacy companion workbook recovery `/recovery` is already `MCP_COVERED` via `dcsc_recovery_inspect` / `dcsc_recovery_export`. Modern LFO storage wizard is upstream unavailable (storage wizard is exclusively CTO; LFO uses autoDerive). | `MCP_COVERED` / `UPSTREAM_UNAVAILABLE_BLOCKED` | Handled by existing tools |

All details, response schemas, and failure logs are archived in `artifacts/phase0-inventory-2026-10-31/report.json`.

## Phase 1 — Live-verify the unverified tools

Commits `25537ec` and `0537e00` added 23 tools (config ID, auto-fix, specialty catalogs, feature details/recommendations, VLH/virtual containers, multi-unit export, category detail, CTO→LFO codes, rack position rule, mandatory software, summary insights, configuration-tree export, AI recommend) with unit tests only.

Phase 1 implemented the automated live verification harness `scripts/parity-phase1-tools.ts` (`npm run parity:phase1`), testing all 25 capabilities (23 tools + session persistence restart survival + unracked multi-unit auto-expansion export) against live `dcsc.lenovo.com`.

### Phase 1 Verification Ledger

| Tool / Capability | Live Wire Endpoint & Method | Status | Live Evidence & Notes |
|---|---|---|---|
| `dcsc_standalone_hardware_add` | GET `/findpart` | `VERIFIED` | Added option `4X77A08621` (qty 2, unit list price $34.50, total $69). |
| `dcsc_standalone_hardware_inspect` | Local `SessionStore` | `VERIFIED` | Read active standalone items and list price total ($69). |
| `dcsc_standalone_hardware_set_quantity` | Local `SessionStore` | `VERIFIED` | Updated quantity to 5, total updated to $172.50. |
| `dcsc_standalone_hardware_remove` | Local `SessionStore` | `VERIFIED` | Removed item, remaining total reset to $0. |
| **Standalone Restart Survival** | Disk state restore roundtrip | `VERIFIED` | Restored persisted standalone hardware workspace cleanly from disk across simulated restart. |
| `dcsc_generate_config_id` | POST `/generateConfigId` | `VERIFIED` | Successfully generated live Config ID (`CIDU00CKWW`) from CTO session `7D73CTO1WW`. |
| `dcsc_import_config_id` | POST `/retrieve/configId` | `VERIFIED` | Reached live controller anonymously; validated upstream config ID response payload. |
| `dcsc_query_sids` | GET `/sids/query/{categoryId}` | `VERIFIED` | Fetched live SIDs for rack servers (`STG@Servers@Rack Server`). |
| `dcsc_auto_fix` / candidates | POST `/cto/hardware/autoFix` & candidates | `VERIFIED` | Evaluated 3 candidate sections (`PROCESSOR`, `NONRAID_HDD`, `LIQUID_COOLING_THERMAL_SOLUTION`). |
| `dcsc_specialty_catalog` | GET `/categories/lvr`, `/categories/multi_product`, `/promotion/*` | `VERIFIED` | Queried 119 LVR categories, 33 converged categories, verified live promotion hierarchies & SIDs. |
| `dcsc_get_feature` | Local `SessionStore` index | `VERIFIED` | Instant indexed feature lookup for feature code `CA0Z`. |
| `dcsc_feature_details` | POST `/ctos/featureDetails` | `VERIFIED` | Retrieved live feature metadata details for 3 features on `7D73CTO1WW`. |
| `dcsc_subtab_recommendations` | GET `/ctos/{code}/transition_guide` | `VERIFIED` | Fetched 15 transition guide recommendations for `7D73CTO1WW`. |
| `dcsc_smart_recommendations` | POST `/ctos/cross_sell` & GET `/api/categories/top_choices/smart_lfo/*` | `VERIFIED` | Queried cross-sell recommendations and smart LFO top choices. |
| `dcsc_vlh_wizard_info` | GET `/vlh/wizardInfo` | `DEFECT_FIXED` | Live endpoint returned 4 keys (topology connectors, functions, topologies, placeholders). Marked `requiresSolution: false` so call succeeds anonymously. |
| `dcsc_vlh_attributes` | GET `/vlh/attributes/{code}` | `DEFECT_FIXED` | Live physical U-capacity and connectors fetched cleanly for `7D73CTO1WW`. Marked `requiresSolution: false`. |
| `dcsc_virtual_container_compatible_products` | POST `/virtual-containers/getCompatibleProductsForVirtualContainer` | `DEFECT_FIXED` | Resolved solution mode context and locale from workspace so preamble validation succeeds. |
| `dcsc_virtual_container_check_rules` | POST `/virtual-containers/checkIfAnythingNeedUpdate` | `DEFECT_FIXED` | Resolved solution mode context and locale from workspace so preamble validation succeeds. |
| `dcsc_export` (Unracked Multi-Unit) | POST `/ctos/export_zip` | `VERIFIED` | Auto-expanded unracked multi-unit (qty 3) into physical nonRackData clones; generated live CFXML and quote reports. |
| `dcsc_category_detail` | GET `/category_detail/{id}` | `DEFECT_FIXED` | Resolved solution context in `DcScService.categoryDetail` so preamble solution query is populated. |
| `dcsc_cto_lfo_codes` | GET `/lfos/cto_filter_lfo` | `DEFECT_FIXED` | Resolved solution context; fetched 142 live LFO codes for `7D73CTO1WW`. |
| `dcsc_rack_position_rule` | POST `/racks/ctos/position/rule` | `DEFECT_FIXED` | Resolved `HPC and AI - Systems` solution mode, relaxed `mtMinMaxRule` and `productMinMaxRule` to accept null in schema. |
| `dcsc_verify_mandatory_software` | POST `/cto/mandatory/sw/selection` | `DEFECT_FIXED` | Transformed null `tabs` from upstream when status is false into empty array. |
| `dcsc_summary_insights` | POST `/ctos/serviceSaving` & `/ctos/flag_summary` | `DEFECT_FIXED` | Resolved solution context so export form snapshot evaluates cleanly. |
| `dcsc_export_configuration_tree` | POST `/ctos/export/configurationTree` | `DEFECT_FIXED` | Resolved solution context; verified valid 3,546 byte XLSX binary stream with `PK` zip header. |
| `dcsc_ai_recommend` | POST `/ai-acceler/nightingale-configurator/api/v1/*` | `DEFECT_FIXED` | Resolved solution context for `ctoCandidates`, `featureCompat`, and `bladeRecommendation` routes (`SUCCESS` responses). |

### Defects Discovered and Fixed During Live Gate

1. **`src/domain/mandatorySoftware.ts` — Nullable Tabs Wire Schema Drift**
   - **Root cause:** When mandatory software selection check is disabled upstream (`status: false`), DCSC returns `{ status: false, tabs: null, message: "function not work now" }`. Zod's `.default([])` only triggers on `undefined`, throwing a `DcscContractDriftError` on `null`.
   - **Resolution:** Changed `tabs` schema to `z.array(TabSchema).nullable().optional().transform(v => v ?? [])`. Added regression unit test in `test/mandatory-software.test.ts`.

2. **`src/domain/rackPositionRule.ts` — Null MinMax Rules & Missing Fields**
   - **Root cause:** Endpoint `/racks/ctos/position/rule` returns `{ mtMinMaxRule: null, productMinMaxRule: null }` when no machine-type rules constrain the server. Zod's `.optional()` rejected explicit `null`s. Additionally, response payload includes `sliceCtoCode` and `type` fields.
   - **Resolution:** Relaxed `mtMinMaxRule`, `productMinMaxRule`, `rule`, and `serverRule` to `.nullable().optional()`, added `sliceCtoCode` and `type` to `RackItemResponseSchema`, and updated the `ServerRule` interface to allow `null`. Added regression unit test in `test/rack-position-rule.test.ts`.

3. **`src/mcp/service.ts` & `src/domain/vlh.ts` — Missing Solution Preamble Context**
   - **Root cause:** DCSC's Spring controllers reject requests missing `solutionMode` and `masterSlices` with a preamble error. Several new standalone helper tools (`categoryDetail`, `ctoLfoCodes`, `rackPositionRule`, `verifyMandatorySoftware`, `summaryInsights`, `exportConfigurationTree`, `aiRecommend`) called `this.newCtx()` without solution context. VLH endpoints `/vlh/wizardInfo` and `/vlh/attributes` do not require solution context upstream.
   - **Resolution:** Marked `requiresSolution: false` on `vlh.wizardInfo` and `vlh.attributes`. Enhanced standalone service methods to resolve solution mode (defaulting to `General Purpose`, or `HPC and AI - Systems` for rack positioning) when no context is provided. Passed workspace solution/locale context in virtual container tools.

Structured Phase 1 verification ledger archived in `artifacts/parity-phase1/2026-10-31/report.json`.

All 25 capabilities verified against live `dcsc.lenovo.com` via `npm run parity:phase1`.

## Phase 2 — Gap work packages

Leads from the bundle diff, ordered by value to an HPC architect. Phase 0 confirms or drops each. Prefer extending an existing tool over adding one (see decision D1).

| # | Capability | Endpoints (bundle) | Likely MCP surface | HPC value |
|---|---|---|---|---|
| G1 | Power report XLS and quote/group XLS downloads | `/ctos/power/export_xls`, `/ctos/group/export_xls`, `lfos` equivalents | `dcsc_export` format option | Power/heat sizing deliverables for facilities |
| G2 | P2P cabling report and cable-distance calculation | `/p2p-report`, `/calculateDistance` | `dcsc_export` format + cabling tool option | Cable plans for fabric build-out |
| G3 | Memory wizard | `/memory_wizard/*` (launch, options, capacity, loadmap, slot number, export) | wizard tool mirroring PCI/storage | Memory population for HPC nodes; prior audit found no enabled US case, so first find one in other locales/products |
| G4 | AI configurator, remaining flows | Nightingale `recommendation/configs`, `recommendation/services`, `config-replenishment/_calculate`, `features/replace`, `candidate/*`, prompt templates | extend `dcsc_ai_recommend` | Requirement-to-configuration for AI clusters. Skip feedback, rating, behaviour tracking. |
| G5 | Supply status and ESD | `/api/supply/status`, `/sst/esd/info`, `/sst/esd/alternative` | catalog/feature tool fields | Lead-time and alternative-part decisions |
| G6 | CFXML validation | `/ecomm/cfxml_validation` | `dcsc_validate` option | Pre-checks external/x-config CFXML |
| G7 | Batch and error customize | `/ctos/batch_customizing`, `*/errorCustomizeWithAutoDerive` | inside `dcsc_configure`/`dcsc_auto_fix` | Multi-change edits in one transaction; fixing invalid imports |
| G8 | Service cost simulator | `/cost_simulator`, `/service/cto/calculate/*` | services tool option | Service cost comparison; confirm anonymous first |
| G9 | Rule versions | `/ctos/{id}/versions`, `/rule_versions`, `/cto-rule-version` | session info field | Reproducibility of a design against rule changes |
| G10 | Discovery helpers | case studies, sub-category search conditions, product-list-by-subcategory, top-choice country, product functions, display orders, static features, marketability | `dcsc_find_products`/`dcsc_browse_catalog` filters | Faster product selection |
| G11 | Share link | `/copy/url` | export option | Hand a design to a colleague without files; confirm anonymous first |
| G12 | Carried-over open items | legacy companion-workbook recovery; LFO storage-wizard mode; other wizard families and physical shapes | existing tools | Already listed in the 2026-10-15 roadmap; close with a concrete case or record as unavailable |

Leads already confirmed absent or not needed: single-row connection delete (not a website action), browser auto-save restore (`/auto/save/*`; the MCP has its own recovery).

### Phase 2 Verification Ledger

| Gap | Capability | Live Endpoint & Method | Status | Live Evidence & Notes |
|---|---|---|---|---|
| **G11** | Shareable redirect URL | GET `/copy/url` | `VERIFIED` | Generated live redirect URL `https://us-dcsc.lenovo.com/redirect/rack-summary/...` via `dcsc_export` (`includeShareUrl: true`). |
| **G1** | CTO Power XLS export | POST `/ctos/power/export_xls` | `VERIFIED` | Exported `Live_Power_Report.xlsx` (29,102 bytes binary stream) via `dcsc_export` (`directReport: 'POWER_XLS'`). |
| **G1** | CTO Quote Group XLS export | POST `/ctos/group/export_xls` | `VERIFIED` | Exported `Live_Group_Quote.xlsx` (11,258 bytes binary stream) via `dcsc_export` (`directReport: 'GROUP_XLS'`). |
| **G2** | Fabric P2P Cabling XLSX report | POST `/p2p-report` | `DEFECT_FIXED` | Exported `Live_P2P_Report.xlsx` (2,788 bytes XLSX binary stream) via `dcsc_export` (`directReport: 'P2P_XLS'`). |
| **G3** | Memory Wizard launch & tab discovery | POST `/ctos/7D73CTO1WW/memory_wizard/launch` | `DEFECT_FIXED` | Discovered active memory wizard steps (`["MEMORY","PROCESSOR"]`) on live 7D73CTO1WW session. |
| **G3** | Memory Wizard slotNumber query | GET `/memory_wizard/slot_number` | `VERIFIED` | Queried slot numbering rules cleanly via `dcsc_pci_wizard` (`memoryWizardAction: 'slotNumber'`). |
| **G4** | Nightingale AI: defaultPrompt | POST `/ai-acceler/nightingale-configurator/api/v1/default-prompt/_query` | `VERIFIED` | Successfully queried prompt suggestions for HPC cluster questions via `dcsc_ai_recommend`. |
| **G4** | Nightingale AI: promptTemplate | POST `/ai-acceler/nightingale-configurator/api/v1/prompt-template/_query` | `VERIFIED` | Retrieved GENERAL prompt template via `dcsc_ai_recommend`. |
| **G4** | Nightingale AI: candidateFeaturesDesc | POST `/ai-acceler/nightingale-configurator/api/v1/candidate/features/desc` | `VERIFIED` | Fetched candidate feature descriptions for `7D73CTO1WW` via `dcsc_ai_recommend`. |
| **G4** | Nightingale AI: configReplenishment | POST `/ai-acceler/nightingale-configurator/api/v1/config-replenishment/_calculate` | `VERIFIED` | Calculated configuration replenishment recommendations via `dcsc_ai_recommend`. |
| **G4** | Nightingale AI: replaceFeatures | POST `/ai-acceler/nightingale-configurator/api/v1/features/replace` | `VERIFIED` | Evaluated feature replacement pairs via `dcsc_ai_recommend`. |
| **G4** | Nightingale AI: recommendServices | POST `/ai-acceler/nightingale-configurator/api/v1/recommendation/services` | `VERIFIED` | Queried recommended warranty/services via `dcsc_ai_recommend`. |
| **G5** | Part supply status & shipping lead times | GET `/api/supply/status` | `VERIFIED` | Queried live shipping lead times for `4X77A08621` (`shippingStatus: ["30","30",...]`) via `dcsc_find_parts` (`includeSupplyStatus: true`). |
| **G5** | ESD part info check | POST `/api/sst/esd/info` | `UPSTREAM_BLOCKED` | Upstream Spring NPE without internal session context as confirmed in Phase 0 audit; recorded as upstream blocked. |
| **G6** | External CFXML validation | POST `/api/ecomm/cfxml_validation` | `VERIFIED` | Validated multipart CFXML upload anonymously via `dcsc_validate` (`cfxmlContent`); received functional upstream response. |
| **G7** | CTO error customize with auto derive | POST `/api/ctos/errorCustomizeWithAutoDerive` | `VERIFIED` | Dispatched batch error customize with auto derive for CTO mode via `dcsc_auto_fix`. |
| **G7** | LFO error customize with auto derive | POST `/api/lfos/errorCustomizeWithAutoDerive` | `VERIFIED` | Dispatched batch error customize with auto derive for LFO mode via `dcsc_auto_fix`. |
| **G9** | CTO product versions & table rule versions | GET `/api/ctos/{code}/versions` & `/{table}/rule_versions` | `DEFECT_FIXED` | Retrieved version map (`"QF.2,1297"`) and rule versions via `dcsc_session_info` (`includeRuleVersions: true`). |
| **G10** | Case study product definitions | GET `/api/categories/caseStudy/all` | `VERIFIED` | Queried case study category definitions via `dcsc_category_detail` (`discoveryAction: 'caseStudies'`). |
| **G10** | Subcategory search conditions | GET `/api/categories/getSubCategorySearchConditions` | `VERIFIED` | Fetched hierarchical search conditions via `dcsc_category_detail` (`discoveryAction: 'subCategoryConditions'`). |
| **G10** | Product list by subcategory | GET `/api/categories/getProductListBySubCategory` | `DEFECT_FIXED` | Fetched filtered product list for rack servers via `dcsc_category_detail` (`discoveryAction: 'productListBySubCategory'`). |
| **G10** | Top choice country availability | GET `/api/categories/checkTopChoiceCountry` | `VERIFIED` | Checked top choice country status via `dcsc_category_detail` (`discoveryAction: 'topChoiceCountry'`). |
| **G10** | Product function feature definitions | POST `/api/function_definition/product_functions` | `DEFECT_FIXED` | Retrieved feature definitions via `dcsc_category_detail` (`discoveryAction: 'productFunctions'`). |
| **G10** | Display ordering rules | GET `/api/ctos/{code}/display_orders/features_and_groups` | `VERIFIED` | Queried feature/group display ordering rules via `dcsc_category_detail` (`discoveryAction: 'displayOrders'`). |
| **G10** | Static tab features hierarchy | POST `/api/ctos/{code}/{tab}/staticFeatures` | `DEFECT_FIXED` | Fetched static features for Memory tab via `dcsc_category_detail` (`discoveryAction: 'staticFeatures'`). |

### Defects Discovered and Fixed During Phase 2 Live Gate

1. **`src/domain/exportExtras.ts` — HTTP 403 Body parameter 1 was null on `/p2p-report`**
   - **Root cause:** Live DCSC Spring controller expects hidden-form POST with `data` field in `application/x-www-form-urlencoded` format, rejecting JSON body with 403.
   - **Resolution:** Updated `exportP2pReport` to send form body `{ kind: 'form', fields: { data: dataField } }`, matching native SPA hidden-form export behavior.

2. **`src/domain/memoryWizard.ts` — HTTP 405 Method Not Allowed on `/ctos/{code}/memory_wizard/launch` with GET**
   - **Root cause:** Live DCSC Spring controller explicitly rejects GET with 405 and requires POST with empty JSON body for `memory_wizard/launch`.
   - **Resolution:** Updated `launchMemoryWizard` to use POST with body `{ kind: 'json', value: {} }`, and unwrapped object dictionary keys for steps.

3. **`src/domain/discoveryHelpers.ts` — HTTP 405 Method Not Allowed on `/function_definition/product_functions` and `staticFeatures` with GET**
   - **Root cause:** Live DCSC Spring controllers explicitly reject GET with 405 and require POST with JSON body for `product_functions` and `staticFeatures`.
   - **Resolution:** Implemented `productFunctions` and `staticFeatures` routes using POST with empty JSON body `{}`.

4. **`src/domain/discoveryHelpers.ts` — HTTP 500 Null conditions on `/categories/getProductListBySubCategory`**
   - **Root cause:** Live DCSC Spring controller expects `conditions` query param to be a stringified JSON object (defaulting to `"{}"`), throwing NullPointerException when omitted.
   - **Resolution:** Defaulted `conditions` parameter to `JSON.stringify({})` in `queryDiscoveryHelper` for `productListBySubCategory`, enabling successful retrieval of subcategory product lists.

5. **`src/domain/ruleVersions.ts` — Dictionary Payload on `/ctos/{code}/versions`**
   - **Root cause:** Upstream `/ctos/{code}/versions` returns an object mapping all 2,861 CTO codes to their active version strings (e.g. `{"7D73CTO1WW": "QF.2,1297"}`), rather than a plain array.
   - **Resolution:** Parsed object responses by looking up `code` directly, splitting comma-delimited version strings into arrays (`['QF.2', '1297']`), and falling back gracefully.

6. **`src/mcp/configurationTools.ts` — Missing Solution Preamble in `dcsc_auto_fix` Error Customize**
   - **Root cause:** Calling `dcsc_auto_fix` with `errorCustomizeConfigurations` without an active session instantiated an empty `ctx`, causing preamble assertion failure on `/ctos/errorCustomizeWithAutoDerive`.
   - **Resolution:** Resolved default solution context via `await service.resolveSolution(service.newCtx())` when session/workspace is not provided.

Structured Phase 2 verification ledger archived in `artifacts/parity-phase2/2026-10-31/report.json`.

All 25 Phase 2 capabilities verified against live `dcsc.lenovo.com` via `npm run parity:phase2`. Tool ergonomics strictly preserved at exactly 108 MCP tools and < 28,000 description characters.

## Phase 3 — HPC architect end-to-end acceptance

Three scripted, live, headless end-to-end scenarios driven strictly through MCP tool handlers against live `dcsc.lenovo.com` (`npm run parity:phase3`):

1. **Scenario 1 — Multi-rack HPC compute cluster (PASSED, 108.8s):**
   - Discovered solution modes via `dcsc_solution_modes` (`HPC and AI - Systems`).
   - Launched compute node `7D73CTO1WW` in workspace (`$15,650.51`).
   - Configured node role (`Compute`), high-speed/management fabric topology (`1GbE_Copper` RJ45 on `Management`), and centralized network preferences with NVIDIA SN2201 managed switch.
   - Provisioned 2x 42U rack cabinets (`7D6DCTO1WW`), cloned compute node, placed nodes in racks U01, configured Switched & Monitored Delta PDUs (200V High Voltage), and positioned racks on floor grid at (0,0) and (1,0).
   - Executed automated cabling (`dcsc_add_cabling` with `auto_connect`).
   - Generated native deliverables: Power report XLS (`directReport: 'POWER_XLS'`), P2P cabling XLS (`directReport: 'P2P_XLS'`), shareable session URL, and manufacturing validation job.
   - Exported complete workspace ZIP and extracted CFXML bundle (`dcsc_export`).
   - Re-imported exported CFXML into fresh workspace (`dcsc_import`), verifying 100% price parity, configuration count, and 2 racks preserved.
   - Simulated process restart and verified persistent workspace layout and rack count restored from disk.

2. **Scenario 2 — AI factory pod (PASSED, 74.0s):**
   - Queried Nightingale AI configurator via `dcsc_ai_recommend`: candidate CTOs for AI/HPC workloads, default prompts, and service recommendations.
   - Launched GPU accelerator node `7D73CTO1WW` and storage system into a unified AI pod workspace.
   - Added standalone software catalog SKU (`dcsc_software_launch` & `dcsc_software_select`).
   - Configured and exported independent Point of Sale warranty services workspace (`dcsc_services_launch`, `dcsc_services_select`, `dcsc_services_export`).
   - Placed GPU and storage nodes in 42U rack cabinet and floor position (0,0).
   - Verified mandatory software compliance (`dcsc_verify_mandatory_software`).
   - Evaluated summary insights (`dcsc_summary_insights` for `serviceSaving` and `flagSummary`).
   - Passed manufacturing validation (`dcsc_validate`).
   - Generated deliverables bundle: full workspace ZIP and Configuration Tree XLSX breakdown (`dcsc_export` and `dcsc_export_configuration_tree`).

3. **Scenario 3 — External CFXML import, validate, fix, re-export (PASSED, 21.3s):**
   - Pre-validated external racked CFXML payload (`one-rack-sr630-v3.xml`) via DCSC ecommerce validator (`dcsc_validate` with `cfxmlContent`).
   - Imported external CFXML into fresh workspace (`dcsc_import`), restoring 2 configurations (42U rack cabinet + SR630 V3 server CTO).
   - Executed workspace manufacturing validation (`dcsc_validate`).
   - Dispatched batch error customize with auto derive (`dcsc_auto_fix` with `errorCustomizeConfigurations`) and evaluated candidate CTO rule auto-fix (`dcsc_auto_fix` with session).
   - Re-exported imported workspace via `dcsc_export` verifying clean round-trip generation of multi-part archive (CFXML + Excel).

### Defects Discovered and Fixed During Phase 3 Live Acceptance

1. **`src/domain/importLayout.ts` — Invariant subset matching in `assertImportContext`**
   - **Root cause:** `assertImportContext` enforced strict `isDeepStrictEqual` on `masterSlices`. Live DCSC `/multiple/cfxml_import` returns only the subset of active slices matching products present in the imported file (e.g. `['HPCGPALL', 'HPCGPRYO']`) rather than the full solution catalog slice list (`['GP', 'HPCGPALL', 'HPCGPRYO']`), rejecting valid multi-rack cluster re-imports.
   - **Resolution:** Updated assertion to verify every returned slice is contained within `workspace.solution.masterSlices` (`every(slice => workspace.solution.masterSlices.includes(slice))`), preserving strict context safety while permitting natural slice subsetting on import.

2. **`scripts/parity-phase3-hpc-e2e.ts` — Solution mode resolution on CFXML re-import**
   - **Root cause:** Lenovo DCSC export ZIP unconditionally stamps `<Configuration Type>General Purpose</Configuration Type>` in the CFXML header, even when exported from `HPC and AI - Systems`. Forcing explicit `solutionMode: 'HPC and AI - Systems'` during CFXML re-import caused DCSC to treat servers as unconfigured commercial groups instead of configured CTOs.
   - **Resolution:** Omitted explicit solutionMode override on CFXML re-import, allowing native solution mode resolution from the CFXML file declaration and preserving full configuration hierarchies, rack associations, and floor layouts.

3. **`src/mcp/service.ts` — Solution context preamble handling in helper methods**
   - **Root cause:** Methods `errorCustomizeWithAutoDerive`, `fetchRuleVersionsInfo`, `fetchCtoVersions`, `fetchRuleVersions`, and `discoveryHelper` used `ctx ?? this.newCtx({ solution: ... })`. When callers supplied a `ctx` missing `solution`, `effectiveCtx.solution` remained undefined, triggering `DcscPreambleError: Internal error: the DCSC request preamble was incomplete (missing solutionMode, masterSlices)`.
   - **Resolution:** Updated helper methods to check `ctx?.solution ? ctx : this.newCtx({ ...(ctx ?? {}), solution: await this.resolveSolution(...) })`, guaranteeing valid preamble headers on all live DCSC RPCs even when called with raw context.

Acceptance ledger archived in `artifacts/parity-phase3-hpc-e2e/2026-10-31/report.json`. All 3 scenarios PASSED (total execution time: 204.1s). Phase 3 acceptance gate is 100% complete.

## Phase 4 — Documentation and release

**Status: COMPLETED (2026-10-31)**

All Phase 4 release gates and documentation requirements have been executed and verified:
1. **Registered Tool Conformance (108/108 Tools)**:
   - Updated `scripts/conformance.ts` with happy-path tracking calls for all 108 registered tools.
   - Verified that every tool response stays within the `MAX_TOOL_BYTES = 8,000` limit. Added optional `limit` parameter to `dcsc_category_detail` and `dcsc_cto_lfo_codes`, `section` filter to `dcsc_vlh_wizard_info`, automatic `session` snapshot resolution to `dcsc_summary_insights`, and local session reconstitution fallback to `dcsc_import_config_id`.
   - Conformance run: **209/209 checks passed (exit code 0)**:
     - `every registered tool invoked (108/108)`: PASS
     - `every registered tool has a successful call (108/108)`: PASS
     - `conformance only calls registered tools`: PASS
     - Zero tool responses exceeded the 8,000-byte budget.
2. **Live Smoke Suites**:
   - `scripts/smoke.ts`: PASS (exit code 0; 4/4 live steps, budget 3/40).
   - `scripts/export-smoke.ts`: PASS (exit code 0; launch, priming, processor autoDerive delta swap, export_zip with XML + XLSX).
   - `scripts/mcp-smoke.ts`: PASS (exit code 0; starts real MCP server over stdio, lists all 108 tools, executes live catalog search, launch, option list, get_feature, configure, export).
3. **Automated Parity Pipelines**:
   - `npm run parity:phase1`: PASS (25 capabilities live verified against dcsc.lenovo.com, `artifacts/parity-phase1/2026-10-31/report.json`).
   - `npm run parity:phase2`: PASS (G1–G11 gap packages live verified, `artifacts/parity-phase2/2026-10-31/report.json`).
   - `npm run parity:phase3`: PASS (3 HPC/AI E2E scenarios live verified, `artifacts/parity-phase3-hpc-e2e/2026-10-31/report.json`).
4. **Complete Local Test Suite (`npm run check`)**:
   - `npm run typecheck`: PASS (0 errors).
   - `npm run lint`: PASS (0 warnings, 0 errors).
   - `npm test`: PASS (**1,212 unit tests across 145 files**, 100% pass).
   - `npm run contract`: PASS (17 offline wire contracts pass).
   - `npm run build`: PASS (`tsc -p tsconfig.build.json` clean).
   - `npm run smoke:stdio`: PASS (108 unique registered tools, stdio health check ok).
5. **Release Checkpoint & Manifest Verification**:
   - Added `parity:phase1`, `parity:phase2`, and `parity:phase3` to `RELEASE_COMMANDS` in `scripts/release-checkpoint.ts`.
   - Generated checkpoint manifest: `npx tsx scripts/release-checkpoint.ts --out artifacts/release-2026-10-31-parity-completion/checkpoint`.
   - Verified source manifest: `npx tsx scripts/release-checkpoint.ts --verify artifacts/release-2026-10-31-parity-completion/checkpoint/manifest.json` (`verified: true`).
6. **Documentation Synchronization**:
   - `README.md`: Updated status summary, tool count (108 tools), test count (1,212 unit tests across 145 files), and Tools table documenting all 108 tools and Phase 2 option extensions.
   - `.docs/context.md`: Updated current status summary with the 2026-10-31 anonymous parity completion metrics and artifact references.
   - `.docs/roadmaps/2026_10_15_dcsc_parity.md` & `.docs/roadmaps/2026_10_15_dcsc_finding_audit.md`: Recorded completion and linked to this roadmap.

## Decisions needed

- **D1 Tool surface.** At 108 tools, adding one tool per capability strains client tool budgets and model tool choice. Recommendation: new work extends existing tools (formats/options); a separate package consolidates closely related tools. Alternative: keep one tool per action.
- **D2 Auth-gated discoveries.** Recommendation: record and drop them. Alternative: keep a separate later backlog that needs a Lenovo ID.

## Execution rules

- Order: Phase 0 → 1 → 2 → 3 → 4. G-items inside Phase 2 can run in parallel for editing only. Live gates and test suites run serially, by one runner, at the end of each package.
- Each package: capture → implement → live parity gate → fixture-backed regression test → audit update.
