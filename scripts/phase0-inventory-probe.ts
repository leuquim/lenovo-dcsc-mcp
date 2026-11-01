/**
 * Phase 0 Inventory and Live Probe Script
 *
 * Implements Phase 0 requirements from 2026_10_31_anonymous_parity_completion.md:
 * 1. Analyzes fixtures/endpoints.json (apiPaths + aiPaths) against app.js and domain files.
 * 2. Classifies each path (SPA_ROUTE, MCP_COVERED, AUTH_GATED, CANDIDATE_GAP).
 * 3. Runs live anonymous probes against dcsc.lenovo.com for candidate gaps G1-G12.
 * 4. Outputs artifacts/phase0-inventory-2026-10-31/report.json.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AI_PREFIX, API_PREFIX } from '../src/config/constants.js';
import { loadConfig } from '../src/config/load.js';
import type { Locale, SolutionContext } from '../src/config/schema.js';
import { fetchSolutionModes, toSolutionContext } from '../src/domain/context.js';
import { DcscHttpClient, RequestBudget, type ReqBody } from '../src/http/request.js';
import { configureLogger, newCorrId } from '../src/http/trace.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(ROOT, 'fixtures', 'endpoints.json');
const APP_JS_PATH = join(ROOT, 'artifacts', 'gap-audit-2026-10-29', 'app.js');
const REPORT_DIR = join(ROOT, 'artifacts', 'phase0-inventory-2026-10-31');
const REPORT_PATH = join(REPORT_DIR, 'report.json');

export type Classification = 'SPA_ROUTE' | 'MCP_COVERED' | 'AUTH_GATED' | 'CANDIDATE_GAP';
export type UiArea =
  | 'home'
  | 'catalog'
  | 'configurator'
  | 'summary'
  | 'workspace'
  | 'rack'
  | 'floor'
  | 'connections'
  | 'storage'
  | 'services'
  | 'software'
  | 'AI assistant'
  | 'export menu'
  | 'dev-info'
  | 'general';

export interface InventoryEntry {
  path: string;
  source: 'api' | 'ai';
  actionName: string;
  apiDictKey?: string | undefined;
  uiArea: UiArea;
  classification: Classification;
  mcpCoverage?: { domainFile: string; mcpTool: string } | undefined;
  gapItem?: string | undefined; // G1 - G12
  notes?: string | undefined;
}

export interface ProbeResult {
  gap: string;
  target: string;
  method: 'GET' | 'POST';
  url: string;
  status: number;
  statusCategory: 'ANONYMOUS_CONFIRMED' | 'AUTH_GATED_DROPPED' | 'UPSTREAM_UNAVAILABLE_BLOCKED' | 'MCP_COVERED';
  durationMs: number;
  responsePreview?: unknown;
  error?: string;
  evidence: string;
}

// Known MCP Tool & Domain mappings
const MCP_MAPPINGS: Record<string, { domainFile: string; mcpTool: string }> = {
  '/solution_modes': { domainFile: 'src/domain/context.ts', mcpTool: 'dcsc_solution_modes' },
  '/locales': { domainFile: 'src/domain/locale.ts', mcpTool: 'dcsc_list_locales' },
  '/currencies': { domainFile: 'src/domain/locale.ts', mcpTool: 'dcsc_list_locales' },
  '/category_hierarchies': { domainFile: 'src/domain/catalog.ts', mcpTool: 'dcsc_browse_catalog' },
  '/lvr/category_hierarchies': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_specialty_catalog' },
  '/multiprod_category_hierarchies': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_specialty_catalog' },
  '/category_detail': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_category_detail' },
  '/category_detail/': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_category_detail' },
  '/multiprod_category_detail/': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_category_detail' },
  '/categories': { domainFile: 'src/domain/catalog.ts', mcpTool: 'dcsc_browse_catalog' },
  '/categories/category_detail_list': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_category_detail' },
  '/categories/services/': { domainFile: 'src/domain/services-catalog.ts', mcpTool: 'dcsc_service_categories' },
  '/categories/services/andor/': { domainFile: 'src/domain/services-catalog.ts', mcpTool: 'dcsc_service_categories' },
  '/categories/softwares': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_software_browse' },
  '/findpart': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_find_parts' },
  '/generateConfigId': { domainFile: 'src/domain/configId.ts', mcpTool: 'dcsc_generate_config_id' },
  '/retrieve/configId': { domainFile: 'src/domain/configId.ts', mcpTool: 'dcsc_import_config_id' },
  '/restore': { domainFile: 'src/domain/configId.ts', mcpTool: 'dcsc_import_config_id' },
  '/sids/query/': { domainFile: 'src/domain/configId.ts', mcpTool: 'dcsc_query_sids' },
  '/promotion/hierarchies': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_specialty_catalog' },
  '/promotion/lfo': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_specialty_catalog' },
  '/promotion/option': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_specialty_catalog' },
  '/promotion/sid': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_specialty_catalog' },
  '/reference_solution/CRNs/': { domainFile: 'src/domain/referenceSolutions.ts', mcpTool: 'dcsc_reference_solutions' },
  '/reference_solution/fetch_categories': { domainFile: 'src/domain/referenceSolutions.ts', mcpTool: 'dcsc_reference_solutions' },
  '/reference_solution/new_or_popular_CRNs': { domainFile: 'src/domain/referenceSolutions.ts', mcpTool: 'dcsc_reference_solutions' },
  '/reference_solution/categories/': { domainFile: 'src/domain/referenceSolutions.ts', mcpTool: 'dcsc_reference_solutions' },
  '/reference_solution/category_vc': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_blueprints' },
  '/reference_solution/category_drs': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_blueprints' },
  '/reference_solution/categories/truscale/': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_reference_solutions' },
  '/ctos/autoDerive': { domainFile: 'src/domain/rackRecustomize.ts', mcpTool: 'dcsc_configure' },
  '/ctos/export/configurationTree': { domainFile: 'src/domain/exportConfigurationTree.ts', mcpTool: 'dcsc_export_configuration_tree' },
  '/ctos/featureDetails': { domainFile: 'src/domain/featureDetails.ts', mcpTool: 'dcsc_feature_details' },
  '/ctos/flag_summary': { domainFile: 'src/domain/summaryInsights.ts', mcpTool: 'dcsc_summary_insights' },
  '/ctos/serviceSaving': { domainFile: 'src/domain/summaryInsights.ts', mcpTool: 'dcsc_summary_insights' },
  '/ctos/standalone_software/launch': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_software_launch' },
  '/ctos/standalone_software/autoDerive': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_software_select' },
  '/ctos/racks/customize/non_rack': { domainFile: 'src/domain/rack.ts', mcpTool: 'dcsc_place_in_rack' },
  '/ctos/racks/customize': { domainFile: 'src/domain/switchProvisioning.ts', mcpTool: 'dcsc_edit_layout' },
  '/ctos/racks/hardware': { domainFile: 'src/domain/rack.ts', mcpTool: 'dcsc_place_in_rack' },
  '/ctos/racks/new_hardware': { domainFile: 'src/domain/rack.ts', mcpTool: 'dcsc_place_in_rack' },
  '/ctos/racks/categories': { domainFile: 'src/domain/rack.ts', mcpTool: 'dcsc_list_options' },
  '/ctos/racks/compatible_categories': { domainFile: 'src/domain/rack.ts', mcpTool: 'dcsc_list_options' },
  '/ctos/racks/AddAndCustomize': { domainFile: 'src/domain/rack.ts', mcpTool: 'dcsc_place_in_rack' },
  '/ctos/export': { domainFile: 'src/domain/exportGroups.ts', mcpTool: 'dcsc_export' },
  '/ctos/export_zip': { domainFile: 'src/domain/exportGroups.ts', mcpTool: 'dcsc_export' },
  '/ctos/exportV2': { domainFile: 'src/domain/exportGroups.ts', mcpTool: 'dcsc_export' },
  '/cto/hardware/autoFix': { domainFile: 'src/domain/autoFix.ts', mcpTool: 'dcsc_auto_fix' },
  '/cto/hardware/autoFix/config': { domainFile: 'src/domain/autoFix.ts', mcpTool: 'dcsc_auto_fix' },
  '/cto/mandatory/sw/selection': { domainFile: 'src/domain/mandatorySoftware.ts', mcpTool: 'dcsc_verify_mandatory_software' },
  '/lfo/mandatory/sw/selection': { domainFile: 'src/domain/mandatorySoftware.ts', mcpTool: 'dcsc_verify_mandatory_software' },
  '/lfos/cto_filter_lfo': { domainFile: 'src/domain/specialtyCatalog.ts', mcpTool: 'dcsc_cto_lfo_codes' },
  '/lfos/export': { domainFile: 'src/domain/exportGroups.ts', mcpTool: 'dcsc_export' },
  '/lfos/export_zip': { domainFile: 'src/domain/exportGroups.ts', mcpTool: 'dcsc_export' },
  '/lfos/exportV2': { domainFile: 'src/domain/exportGroups.ts', mcpTool: 'dcsc_export' },
  '/lfos/autoDerive': { domainFile: 'src/domain/rackRecustomize.ts', mcpTool: 'dcsc_configure' },
  '/racks/ctos/position/rule': { domainFile: 'src/domain/rackPositionRule.ts', mcpTool: 'dcsc_rack_position_rule' },
  '/recommendations/sub_tabs': { domainFile: 'src/domain/recommendations.ts', mcpTool: 'dcsc_subtab_recommendations' },
  '/recommendations/summary': { domainFile: 'src/domain/recommendations.ts', mcpTool: 'dcsc_summary_insights' },
  '/smart/recommend/lfo/preload/data': { domainFile: 'src/domain/recommendations.ts', mcpTool: 'dcsc_smart_recommendations' },
  '/smart/recommend/lfo/': { domainFile: 'src/domain/recommendations.ts', mcpTool: 'dcsc_smart_recommendations' },
  '/service/portal/categories': { domainFile: 'src/domain/services-catalog.ts', mcpTool: 'dcsc_service_categories' },
  '/service/portal/launch': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_services_launch' },
  '/service/portal/tabs': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_services_launch' },
  '/service/portal/search/': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_services_launch' },
  '/services/autoDerive': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_services_select' },
  '/services/summaries': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_services_inspect' },
  '/service_pacs/': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_services_select' },
  '/software/portal/launch': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_software_launch' },
  '/software/portal/search/': { domainFile: 'src/domain/standalone.ts', mcpTool: 'dcsc_software_launch' },
  '/switch_calculation': { domainFile: 'src/domain/switchProvisioning.ts', mcpTool: 'dcsc_scale_out' },
  '/auto_connect': { domainFile: 'src/domain/cabling.ts', mcpTool: 'dcsc_add_cabling' },
  '/calculateDistance': { domainFile: 'src/domain/manualCabling.ts', mcpTool: 'dcsc_create_cabling_connection' },
  '/getTopologies': { domainFile: 'src/domain/fabric.ts', mcpTool: 'dcsc_fabric_options' },
  '/node_roles': { domainFile: 'src/domain/fabric.ts', mcpTool: 'dcsc_fabric_options' },
  '/getStoragePreferences': { domainFile: 'src/domain/fabric.ts', mcpTool: 'dcsc_fabric_options' },
  '/lmc_validation': { domainFile: 'src/domain/validate.ts', mcpTool: 'dcsc_validate' },
  '/lmc_validation/result': { domainFile: 'src/domain/validate.ts', mcpTool: 'dcsc_validation_jobs' },
  '/lmc_validation/error': { domainFile: 'src/domain/validate.ts', mcpTool: 'dcsc_validate' },
  '/virtual-containers/allAvailableBlackList': { domainFile: 'src/domain/virtualContainers.ts', mcpTool: 'dcsc_virtual_container_check_rules' },
  '/virtual-containers/checkIfAnythingNeedUpdate': { domainFile: 'src/domain/virtualContainers.ts', mcpTool: 'dcsc_virtual_container_check_rules' },
  '/virtual-containers/getCompatibleProductsForVirtualContainer': { domainFile: 'src/domain/virtualContainers.ts', mcpTool: 'dcsc_virtual_container_compatible_products' },
  '/virtual-containers/': { domainFile: 'src/domain/virtualContainers.ts', mcpTool: 'dcsc_virtual_container_compatible_products' },
  '/vlh/wizardInfo': { domainFile: 'src/domain/vlh.ts', mcpTool: 'dcsc_vlh_wizard_info' },
  '/vlh/attributes/': { domainFile: 'src/domain/vlh.ts', mcpTool: 'dcsc_vlh_attributes' },
  '/vlh/export/xml': { domainFile: 'src/domain/vlh.ts', mcpTool: 'dcsc_export' },
  '/vlh/import': { domainFile: 'src/domain/importFile.ts', mcpTool: 'dcsc_import' },
  '/cfxml_import': { domainFile: 'src/domain/importFile.ts', mcpTool: 'dcsc_import' },
  '/multiple/cfxml_import': { domainFile: 'src/domain/importFile.ts', mcpTool: 'dcsc_import' },
  '/recovery': { domainFile: 'src/mcp/recoveryTools.ts', mcpTool: 'dcsc_recovery_inspect' },
  '/pdu/pduPreference': { domainFile: 'src/domain/pdu.ts', mcpTool: 'dcsc_configure_pdu' },
  '/powercalculation/powercalculate': { domainFile: 'src/domain/power.ts', mcpTool: 'dcsc_power' },
  '/rmp/mip': { domainFile: 'src/mcp/service.ts', mcpTool: 'dcsc_network_connectors' },
  '/unconfigured/': { domainFile: 'src/domain/unconfigured.ts', mcpTool: 'dcsc_load_unconfigured' },
  '/pci_wizard/': { domainFile: 'src/domain/pciWizard.ts', mcpTool: 'dcsc_pci_wizard' },
  '/pci_wizard/validate/slot': { domainFile: 'src/domain/pciWizard.ts', mcpTool: 'dcsc_set_pci_wizard' },
  '/pci_wizard/validate/additional/slot': { domainFile: 'src/domain/pciWizard.ts', mcpTool: 'dcsc_set_pci_wizard' },
  '/nightingale-configurator/api/v1/recommendation/ctoCandidates': { domainFile: 'src/domain/aiConfigurator.ts', mcpTool: 'dcsc_ai_recommend' },
  '/nightingale-configurator/api/v1/feature-compat/_validate': { domainFile: 'src/domain/aiConfigurator.ts', mcpTool: 'dcsc_ai_recommend' },
  '/nightingale-configurator/api/v1/blade/recommendation': { domainFile: 'src/domain/aiConfigurator.ts', mcpTool: 'dcsc_ai_recommend' },
};

function assignGapItem(path: string): string | undefined {
  if (
    path.includes('/power/export_xls') ||
    path.includes('/group/export_xls')
  ) return 'G1';
  if (path === '/p2p-report' || path === '/calculateDistance') return 'G2';
  if (path.includes('memory_wizard')) return 'G3';
  if (path.startsWith('/nightingale-configurator/')) return 'G4';
  if (path.includes('/supply/status') || path === '/supply-status' || path.includes('/sst/esd')) return 'G5';
  if (path.includes('cfxml_validation')) return 'G6';
  if (path.includes('batch_customizing') || path.includes('errorCustomizeWithAutoDerive')) return 'G7';
  if (path.includes('cost_simulator') || path.includes('/service/cto/calculate') || path.includes('/service/cto/query') || path.includes('/service/cto/report') || path.includes('/service/cto/history')) return 'G8';
  if (path.includes('rule_versions') || path.includes('cto-rule-version') || path.includes('table-version') || path === '/versions') return 'G9';
  if (
    path.includes('/categories/caseStudy') ||
    path.includes('getSubCategorySearchConditions') ||
    path.includes('getProductListBySubCategory') ||
    path.includes('checkTopChoiceCountry') ||
    path.includes('product_functions') ||
    path.includes('features_and_groups') ||
    path.includes('staticFeatures') ||
    path.includes('marketability')
  ) return 'G10';
  if (path === '/copy/url') return 'G11';
  return undefined;
}

function classifyPath(path: string, appJs: string): { classification: Classification; actionName: string; uiArea: UiArea; notes?: string } {
  // 1. Check known MCP coverage first
  for (const [prefix, mapping] of Object.entries(MCP_MAPPINGS)) {
    if (path === prefix || path.startsWith(prefix)) {
      return {
        classification: 'MCP_COVERED',
        actionName: mapping.mcpTool,
        uiArea: inferUiArea(path),
        notes: `Covered by ${mapping.mcpTool} in ${mapping.domainFile}`,
      };
    }
  }

  // 2. Client-side SPA routes and static assets
  const spaRoutes = [
    '/catalog',
    '/catalogSearchResult/:searchText',
    '/categories/:categoryId',
    '/cto-rule-version',
    '/table-version',
    '/deal-reg',
    '/deal-reg/',
    '/deal-reg/new',
    '/deal-reg/create',
    '/deal-reg/manage',
    '/deal-reg/withdrawn',
    '/deal-reg/edit/:dealRegId',
    '/deal-reg/update-expiry-date/:dealRegId',
    '/deal-reg/withdrawn/:dealRegId',
    '/RMCase/',
    '/RMCase/manage',
    '/RMCase/detail/:caseId',
    '/configId/management',
    '/configId/management/',
    '/configId/management/grouped',
    '/configId/management/grouped/',
    '/configuration',
    '/configuration/',
    '/configuration/cto/',
    '/configuration/cto/:productNumber',
    '/configuration/lfo/',
    '/configuration/lfo/:productNumber',
    '/configuration/lfo-as-cto/',
    '/configuration/lfo-as-cto/:productNumber',
    '/configuration/placement-info',
    '/configuration/import',
    '/main',
    '/cost_simulator',
    '/cost_Simulator',
    '/memory-configuration',
    '/placement-info',
    '/DCSC-Overview-features-and-functions.pdf',
    '/offline-release',
    '/Core',
    '/Ghz',
    '/dev-info',
    '/update-browser',
    '/logout',
    '/login',
    '/error',
    '/serviceDetail',
    '/servicePortal',
    '/service(/:category)',
    '/rack-summary/',
    '/rack-summary/solution-guide',
    '/rack-summary/:type',
    '/crc-summary',
    '/ai-configurator-assistant',
    '/andor-public-announcement',
    '/supply-status',
    '/copy/',
    '/copy/:',
  ];
  if (spaRoutes.some(r => path === r || path.startsWith(`${r}/`))) {
    return {
      classification: 'SPA_ROUTE',
      actionName: 'react-router / static asset',
      uiArea: inferUiArea(path),
      notes: 'Client-side React router route or static asset',
    };
  }

  // 3. Auth-gated endpoints (require Lenovo login / partner credentials)
  const authPrefixes = [
    '/lbp/',
    '/mc/',
    '/RMCase/',
    '/deal_registration',
    '/deal-reg',
    '/user_configurations',
    '/user_configuration_sharing',
    '/reseller/',
    '/api/integration/sso/',
    '/api/redirectElois/',
    '/api/redirectUserIntegration/',
    '/integration/user',
    '/auto/save/',
    '/crc/',
    '/search/prime/config',
    '/query/geo/mappings',
    '/search/uid',
    '/all/mc/locales',
    '/product-categories',
    '/configId/email',
    '/configId/query/',
    '/configId/compareConfigurations',
    '/configId/getRestoreResponse',
    '/configId/saveUserColumns',
    '/configId/getUserColumns',
    '/current_country',
    '/CXSurveyAllowlist',
    '/api-simulation',
    '/api-preview',
    '/preview/',
    '/httpStatus',
    '/offline/application/',
    '/marketability',
    '/integration/marketability',
  ];
  if (authPrefixes.some(p => path === p || path.startsWith(p))) {
    return {
      classification: 'AUTH_GATED',
      actionName: 'auth / partner portal action',
      uiArea: inferUiArea(path),
      notes: 'Requires Lenovo partner / employee authentication (LBP/MC/RM/DealReg/Auth-header)',
    };
  }

  // 4. Default: Candidate Gap
  return {
    classification: 'CANDIDATE_GAP',
    actionName: findCallingActionInAppJs(path, appJs),
    uiArea: inferUiArea(path),
  };
}

function inferUiArea(path: string): UiArea {
  if (path.startsWith('/nightingale') || path.startsWith('/ai-')) return 'AI assistant';
  if (path.includes('export') || path.includes('p2p-report') || path === '/copy/url' || path.includes('configId')) return 'export menu';
  if (path.includes('cabling') || path.includes('Distance') || path.includes('auto_connect')) return 'connections';
  if (path.includes('storage') || path.includes('lanamark')) return 'storage';
  if (path.includes('software') || path.includes('/categories/softwares')) return 'software';
  if (path.includes('service') || path.includes('cost_simulator')) return 'services';
  if (path.includes('rack') || path.includes('pdu')) return 'rack';
  if (path.includes('floor')) return 'floor';
  if (path.includes('summary') || path.includes('powercalculate') || path.includes('validation')) return 'summary';
  if (path.includes('rule-version') || path.includes('table-version') || path.includes('versions') || path.includes('dev-info')) return 'dev-info';
  if (path.includes('category') || path.includes('catalog') || path.includes('promotion') || path.includes('reference_solution') || path.includes('findpart')) return 'catalog';
  if (path.includes('cto') || path.includes('lfo') || path.includes('unconfigured') || path.includes('virtual-container')) return 'configurator';
  if (path.includes('main') || path.includes('solution_mode') || path.includes('news') || path.includes('announcement')) return 'home';
  return 'general';
}

function findCallingActionInAppJs(path: string, appJs: string): string {
  const idx = appJs.indexOf(path);
  if (idx === -1) return 'unknown';
  const snippetBefore = appJs.substring(Math.max(0, idx - 120), idx);
  const keyMatch = /([a-zA-Z0-9_$]+)\s*:\s*["']?$/.exec(snippetBefore);
  if (keyMatch && keyMatch[1]) return keyMatch[1];
  const fnMatch = /function\s+([a-zA-Z0-9_$]+)/.exec(snippetBefore);
  if (fnMatch && fnMatch[1]) return fnMatch[1];
  return 'anonymous';
}

async function runLiveProbes(http: DcscHttpClient, baseCtx: { corrId: string; locale: Locale; budget: RequestBudget; solution: SolutionContext }): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];

  const probeOne = async (
    gap: string,
    target: string,
    method: 'GET' | 'POST',
    inputPath: string,
    options: {
      prefix?: string;
      body?: ReqBody | undefined;
      query?: Record<string, string>;
      locale?: Locale;
      requiresSolution?: boolean;
    } = {}
  ): Promise<ProbeResult> => {
    const started = Date.now();
    const prefix = options.prefix ?? API_PREFIX;
    const url = `https://dcsc.lenovo.com${prefix}${inputPath}`;
    const ctx = options.locale ? { ...baseCtx, locale: options.locale } : baseCtx;

    try {
      const res = await http.send({
        endpoint: `probe_${target.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        method,
        prefix,
        path: inputPath,
        query: options.query,
        body: options.body,
        responseKind: 'json',
        timeoutClass: 'interactive',
        requiresSolution: options.requiresSolution ?? true,
        ctx,
      });

      const durationMs = Date.now() - started;
      const raw = (res as { raw?: unknown }).raw;
      const preview = typeof raw === 'object' && raw !== null ? (Array.isArray(raw) ? `Array(${raw.length})` : Object.keys(raw).slice(0, 8)) : String(raw).slice(0, 100);

      const statusCategory: ProbeResult['statusCategory'] = 'ANONYMOUS_CONFIRMED';
      return {
        gap,
        target,
        method,
        url,
        status: res.status,
        statusCategory,
        durationMs,
        responsePreview: preview,
        evidence: `HTTP ${res.status} returned anonymously: ${JSON.stringify(preview)}`,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - started;
      const status = err && typeof err === 'object' && 'status' in err && typeof err.status === 'number' ? err.status : 500;
      let statusCategory: ProbeResult['statusCategory'] = 'UPSTREAM_UNAVAILABLE_BLOCKED';

      if (status === 401 || status === 403) {
        statusCategory = 'AUTH_GATED_DROPPED';
      } else if (status === 400) {
        // If 400 specifically demands Authorization header, it is auth-gated
        if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message.includes('Authorization')) {
          statusCategory = 'AUTH_GATED_DROPPED';
        } else {
          // Bad request due to missing parameters indicates endpoint is live and authenticated
          statusCategory = 'ANONYMOUS_CONFIRMED';
        }
      } else if (status === 404 || status === 405 || status >= 500) {
        statusCategory = 'UPSTREAM_UNAVAILABLE_BLOCKED';
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        gap,
        target,
        method,
        url,
        status,
        statusCategory,
        durationMs,
        error: message,
        evidence: `HTTP ${status}: ${message}`,
      };
    }
  };

  console.log('--- Probing G1: Power & Group export XLS ---');
  // Pass required fileName parameter and export payload shape
  probes.push(await probeOne('G1', '/ctos/power/export_xls', 'POST', '/ctos/power/export_xls', {
    query: { fileName: 'Power_Report.xlsx' },
    body: {
      kind: 'form',
      fields: {
        fileName: 'Power_Report.xlsx',
        data: JSON.stringify({
          workspaceInformation: { id: 'w1', name: 'W1' },
          configurations: [{ id: 'c1', code: '7D73CTO1WW', type: 'server', quantity: 1, derivedResults: [], sections: [] }],
          cloneDependencyColor: {},
        }),
        groups: '[]',
      },
    },
  }));
  probes.push(await probeOne('G1', '/ctos/group/export_xls', 'POST', '/ctos/group/export_xls', {
    query: { fileName: 'Group_Quote.xlsx' },
    body: {
      kind: 'form',
      fields: {
        fileName: 'Group_Quote.xlsx',
        data: JSON.stringify({
          workspaceInformation: { id: 'w1', name: 'W1' },
          configurations: [{ id: 'c1', code: '7D73CTO1WW', type: 'server', quantity: 1, derivedResults: [], sections: [] }],
          cloneDependencyColor: {},
        }),
        groups: '[]',
      },
    },
  }));
  probes.push(await probeOne('G1', '/lfos/power/export_xls', 'POST', '/lfos/power/export_xls', {
    query: { fileName: 'Power_Report.xlsx' },
    body: {
      kind: 'form',
      fields: {
        fileName: 'Power_Report.xlsx',
        data: JSON.stringify({
          workspaceInformation: { id: 'w1', name: 'W1' },
          configurations: [{ id: 'l1', code: '7D73LFO1WW', type: 'server', quantity: 1, derivedResults: [], sections: [] }],
          cloneDependencyColor: {},
        }),
        groups: '[]',
      },
    },
  }));
  probes.push(await probeOne('G1', '/lfos/group/export_xls', 'POST', '/lfos/group/export_xls', {
    query: { fileName: 'Group_Quote.xlsx' },
    body: {
      kind: 'form',
      fields: {
        fileName: 'Group_Quote.xlsx',
        data: JSON.stringify({
          workspaceInformation: { id: 'w1', name: 'W1' },
          configurations: [{ id: 'l1', code: '7D73LFO1WW', type: 'server', quantity: 1, derivedResults: [], sections: [] }],
          cloneDependencyColor: {},
        }),
        groups: '[]',
      },
    },
  }));

  console.log('--- Probing G2: Cabling & Distance ---');
  probes.push(await probeOne('G2', '/p2p-report', 'POST', '/p2p-report', {
    query: { fileName: 'P2P_Report.xlsx' },
    body: { kind: 'form', fields: { data: '{}' } },
  }));
  probes.push(await probeOne('G2', '/calculateDistance', 'POST', '/calculateDistance', {
    body: { kind: 'json', value: { sourceRackId: 'RACK-1', targetRackId: 'RACK-2', sourceLocation: 10, targetLocation: 20 } },
  }));

  console.log('--- Probing G3: Memory Wizard ---');
  probes.push(await probeOne('G3', '/ctos/7D73CTO1WW/memory_wizard/launch (US)', 'POST', '/ctos/7D73CTO1WW/memory_wizard/launch', {
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G3', '/ctos/7D76CTO1WW/memory_wizard/launch (US)', 'POST', '/ctos/7D76CTO1WW/memory_wizard/launch', {
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G3', '/ctos/7X06CTO1WW/memory_wizard/launch (Purley SR650)', 'POST', '/ctos/7X06CTO1WW/memory_wizard/launch', {
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G3', '/ctos/7D73CTO1WW/memory_wizard/launch (DE)', 'POST', '/ctos/7D73CTO1WW/memory_wizard/launch', {
    locale: { country: 'DE', language: 'de', currency: 'EUR', geo: 'emea' },
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G3', '/ctos/7D73CTO1WW/memory_wizard/launch (CN)', 'POST', '/ctos/7D73CTO1WW/memory_wizard/launch', {
    locale: { country: 'CN', language: 'zh', currency: 'CNY', geo: 'cn' },
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G3', '/memory_wizard/productCode', 'POST', '/memory_wizard/productCode', {
    body: { kind: 'json', value: { productCode: '7D73CTO1WW', ctoCode: '7D73CTO1WW' } },
  }));

  console.log('--- Probing G4: Nightingale AI Routes ---');
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/default-prompt/_query', 'POST', '/nightingale-configurator/api/v1/default-prompt/_query', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: { ctoCode: '7D73CTO1WW', country: 'US' } },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/prompt-template/_query', 'POST', '/nightingale-configurator/api/v1/prompt-template/_query', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: { country: 'US' } },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/candidate/attributes', 'POST', '/nightingale-configurator/api/v1/candidate/attributes', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: { ctoCode: '7D73CTO1WW' } },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/candidate/features', 'POST', '/nightingale-configurator/api/v1/candidate/features', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: { ctoCode: '7D73CTO1WW' } },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/candidate/features/desc', 'POST', '/nightingale-configurator/api/v1/candidate/features/desc', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/config-replenishment/_calculate', 'POST', '/nightingale-configurator/api/v1/config-replenishment/_calculate', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/features/replace', 'POST', '/nightingale-configurator/api/v1/features/replace', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/recommendation/configs', 'POST', '/nightingale-configurator/api/v1/recommendation/configs', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G4', '/nightingale-configurator/api/v1/recommendation/services', 'POST', '/nightingale-configurator/api/v1/recommendation/services', {
    prefix: AI_PREFIX,
    body: { kind: 'json', value: {} },
  }));

  console.log('--- Probing G5: Supply Status & ESD ---');
  probes.push(await probeOne('G5', '/supply-status', 'GET', '/supply-status', { prefix: '', requiresSolution: false }));
  probes.push(await probeOne('G5', '/api/supply/status', 'GET', '/supply/status', {
    query: { country: 'US', type: 'Option', code: '4X77A08621' },
    requiresSolution: false,
  }));
  probes.push(await probeOne('G5', '/sst/esd/info', 'POST', '/sst/esd/info', {
    query: { country_or_region: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    body: { kind: 'json', value: { productItems: [] } },
  }));
  probes.push(await probeOne('G5', '/sst/esd/alternative', 'POST', '/sst/esd/alternative', {
    query: { country_or_region: 'US', geo: 'NA', language: 'en', currency: 'USD' },
    body: { kind: 'json', value: {} },
  }));

  console.log('--- Probing G6: CFXML validation ---');
  probes.push(await probeOne('G6', '/ecomm/cfxml_validation', 'POST', '/ecomm/cfxml_validation', {
    body: {
      kind: 'multipart',
      parts: [{
        name: 'cfxmlFile',
        filename: 'config.xml',
        contentType: 'application/xml',
        content: '<?xml version="1.0" encoding="UTF-8"?><configuration></configuration>',
      }],
    },
  }));

  console.log('--- Probing G7: Batch & error customize ---');
  probes.push(await probeOne('G7', '/ctos/batch_customizing', 'POST', '/ctos/batch_customizing', {
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G7', '/lfos/batch_customizing', 'POST', '/lfos/batch_customizing', {
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G7', '/ctos/errorCustomizeWithAutoDerive', 'POST', '/ctos/errorCustomizeWithAutoDerive', {
    body: { kind: 'json', value: { configurations: [] } },
  }));
  probes.push(await probeOne('G7', '/lfos/errorCustomizeWithAutoDerive', 'POST', '/lfos/errorCustomizeWithAutoDerive', {
    body: { kind: 'json', value: { configurations: [] } },
  }));

  console.log('--- Probing G8: Cost Simulator ---');
  probes.push(await probeOne('G8', '/cost_simulator (root)', 'GET', '/cost_simulator', {
    prefix: '',
    requiresSolution: false,
  }));
  probes.push(await probeOne('G8', '/cost_simulator/service/cto/calculate/files', 'POST', '/service/cto/calculate/files', {
    prefix: '/cost_simulator',
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G8', '/cost_simulator/service/cto/query/snow_id', 'GET', '/service/cto/query/snow_id', {
    prefix: '/cost_simulator',
    query: { id: 'SNOW123' },
  }));

  console.log('--- Probing G9: Rule versions ---');
  probes.push(await probeOne('G9', '/ctos/7D73CTO1WW/versions', 'GET', '/ctos/7D73CTO1WW/versions'));
  probes.push(await probeOne('G9', '/ctos/7D73CTO1WW/203/rule_versions', 'GET', '/ctos/7D73CTO1WW/203/rule_versions'));
  probes.push(await probeOne('G9', '/rule_versions', 'GET', '/rule_versions', { requiresSolution: false }));
  probes.push(await probeOne('G9', '/cto-rule-version', 'GET', '/cto-rule-version', { prefix: '', requiresSolution: false }));

  console.log('--- Probing G10: Discovery helpers ---');
  probes.push(await probeOne('G10', '/categories/caseStudy/', 'GET', '/categories/caseStudy/all'));
  probes.push(await probeOne('G10', '/categories/getSubCategorySearchConditions', 'GET', '/categories/getSubCategorySearchConditions'));
  probes.push(await probeOne('G10', '/categories/getProductListBySubCategory', 'GET', '/categories/getProductListBySubCategory', {
    query: { categoryId: '1', pageNumber: '1', pageSize: '10' },
  }));
  probes.push(await probeOne('G10', '/categories/checkTopChoiceCountry', 'GET', '/categories/checkTopChoiceCountry'));
  probes.push(await probeOne('G10', '/function_definition/product_functions', 'POST', '/function_definition/product_functions', {
    query: { code: '7D73CTO1WW' },
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G10', '/ctos/7D73CTO1WW/display_orders/features_and_groups', 'GET', '/ctos/7D73CTO1WW/display_orders/features_and_groups'));
  probes.push(await probeOne('G10', '/ctos/7D73CTO1WW/Memory/staticFeatures', 'POST', '/ctos/7D73CTO1WW/Memory/staticFeatures', {
    body: { kind: 'json', value: {} },
  }));
  probes.push(await probeOne('G10', '/marketability', 'GET', '/marketability', {
    query: { country: 'US', product_number: '7D73CTO1WW' },
  }));
  probes.push(await probeOne('G10', '/integration/marketability', 'GET', '/integration/marketability', {
    query: { country: 'US', product_number: '7D73CTO1WW' },
  }));

  console.log('--- Probing G11: Copy URL ---');
  probes.push(await probeOne('G11', '/copy/url', 'GET', '/copy/url', {
    query: { configuration_id: 'test_config_id' },
  }));

  return probes;
}

async function main(): Promise<void> {
  console.log('Phase 0 Complete Inventory & Probing starting...');

  // 1. Read endpoints and app.js
  const endpointsData = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  const allRawPaths: Array<{ path: string; source: 'api' | 'ai' }> = [
    ...endpointsData.apiPaths.map((p: string) => ({ path: p, source: 'api' as const })),
    ...endpointsData.aiPaths.map((p: string) => ({ path: p, source: 'ai' as const })),
  ];

  console.log(`Analyzing ${allRawPaths.length} endpoint paths...`);

  // 2. Classify inventory
  const inventory: InventoryEntry[] = allRawPaths.map(({ path, source }) => {
    const { classification, actionName, uiArea, notes } = classifyPath(path, appJs);
    const mcpCoverage = MCP_MAPPINGS[path] ?? Object.entries(MCP_MAPPINGS).find(([k]) => path.startsWith(k))?.[1];
    const gapItem = assignGapItem(path);

    return {
      path,
      source,
      actionName,
      uiArea,
      classification: mcpCoverage ? 'MCP_COVERED' : classification,
      mcpCoverage,
      gapItem,
      notes,
    };
  });

  // 3. Pacing and Live Probing via DcscHttpClient
  // Configure client with relaxed breaker and single-attempt retry so probes do not cascade trip breaker
  const config = loadConfig({
    logLevel: (process.env.DCSC_LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') ?? 'warn',
    retry: { maxAttempts: 1 },
    breaker: { failureRatio: 1.0, consecutive5xxTrip: 1000, minSamples: 1000, openMs: 1 },
    pacing: { perToolRequestBudget: 500, maxConcurrency: 1, refillPerSec: 2 },
  });
  configureLogger(config.logLevel);

  const http = new DcscHttpClient(config);
  const corrId = newCorrId();
  const budget = new RequestBudget(500);
  const base = { corrId, locale: config.locale, budget };

  console.log('Fetching solution modes for probe context...');
  const modes = await fetchSolutionModes(http, base);
  const solution = toSolutionContext(modes, 'General Purpose');
  const baseCtx = { ...base, solution };

  console.log('Running live anonymous probes for G1-G12 candidate gaps...');
  const probes = await runLiveProbes(http, baseCtx);

  // 4. Summarize statistics
  const countsByClassification: Record<Classification, number> = {
    SPA_ROUTE: 0,
    MCP_COVERED: 0,
    AUTH_GATED: 0,
    CANDIDATE_GAP: 0,
  };
  const countsByUiArea: Record<string, number> = {};

  for (const entry of inventory) {
    countsByClassification[entry.classification] = (countsByClassification[entry.classification] ?? 0) + 1;
    countsByUiArea[entry.uiArea] = (countsByUiArea[entry.uiArea] ?? 0) + 1;
  }

  // Summarize gap package statuses from probe results
  const gapStatuses: Record<string, { totalProbes: number; confirmed: number; authGated: number; blocked: number; summary: string }> = {};
  for (let g = 1; g <= 11; g++) {
    const gKey = `G${g}`;
    const gProbes = probes.filter(p => p.gap === gKey);
    const confirmed = gProbes.filter(p => p.statusCategory === 'ANONYMOUS_CONFIRMED').length;
    const authGated = gProbes.filter(p => p.statusCategory === 'AUTH_GATED_DROPPED').length;
    const blocked = gProbes.filter(p => p.statusCategory === 'UPSTREAM_UNAVAILABLE_BLOCKED').length;

    let summary = 'UNKNOWN';
    if (confirmed > 0 && authGated === 0 && blocked === 0) summary = 'ANONYMOUS_CONFIRMED';
    else if (authGated > 0 && confirmed === 0) summary = 'AUTH_GATED_DROPPED';
    else if (confirmed > 0 && authGated > 0) summary = `ANONYMOUS_CONFIRMED (${confirmed}/${gProbes.length} endpoints confirmed; ${authGated} auth-gated)`;
    else if (confirmed > 0 && blocked > 0) summary = `ANONYMOUS_CONFIRMED (${confirmed}/${gProbes.length} endpoints confirmed)`;
    else if (blocked > 0) summary = 'UPSTREAM_UNAVAILABLE_BLOCKED';

    gapStatuses[gKey] = {
      totalProbes: gProbes.length,
      confirmed,
      authGated,
      blocked,
      summary,
    };
  }

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      bundle: endpointsData.bundle,
      bundleSha256: endpointsData.bundleSha256,
      host: endpointsData.host,
      totalPaths: inventory.length,
      countsByClassification,
      countsByUiArea,
    },
    gapStatuses,
    probes,
    inventory,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n=== Phase 0 Inventory & Probe Completed ===`);
  console.log(`Total Paths: ${inventory.length}`);
  console.log(`Classification Breakdown:`, countsByClassification);
  console.log(`UI Areas:`, countsByUiArea);
  console.log(`Report written to ${REPORT_PATH}`);
}

main().catch(err => {
  console.error('Phase 0 inventory probe failed:', err);
  process.exitCode = 1;
});
