import { detachedNestedNodeIds } from '../domain/nestedPhysical.js';
import { readConnectionGraph } from '../domain/cabling.js';
import { cablingDiagnostics } from '../domain/cablingDiagnostics.js';
import type { WorkspaceSession } from './session.js';
import { projectJsonPage } from './pagedJson.js';
import { storageConnectionNetworkSource, storageComponentQuantities, storagePhysicalTemplateIds } from '../domain/storagePreferences.js';
import { storagePhysicalConfigurations } from '../domain/storagePhysicalState.js';
import { configurationListPrice } from '../domain/pricing.js';
import { physicalIds } from '../domain/workspaceReferences.js';
import { isObject } from '../util/coerce.js';

const DEFAULT_PAGE_LIMIT = 20;
const PREVIEW_TEXT_LIMIT = 160;
const RESPONSE_BUDGET_BYTES = 7_000;
const RESPONSE_HARD_LIMIT_BYTES = 7_500;

export interface WorkspaceProjectionOptions {
  tool: string;
  arguments: Record<string, unknown>;
  previewLimit?: number | undefined;
  pageLimit?: number | undefined;
}

export interface WorkspacePageOptions extends WorkspaceProjectionOptions {
  path: string[];
  offset: number;
  limit: number;
}

interface Continuation {
  tool: string;
  arguments: Record<string, unknown>;
}

interface CollectionNavigation {
  total: number;
  previewed: number;
  inspect: Continuation;
}

export interface WorkspaceProjectionTotals {
  configurations: number;
  racks: number;
  rackItems: number;
  rackErrors: number;
  unracked: number;
  cables: number;
  floorItems: number;
  powerSelections: number;
  storageNetworks: number;
  cloneDependency: number;
  cloneDependencyColor: number;
  rawRackArea: number;
  rawNonRackArea: number;
  layoutErrors: number;
  rawConnections: number;
  autoConnectMessageGroups: number;
  autoConnectMessages: number;
  standaloneSoftware: number;
  integrityWarnings: number;
}

function clonedRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(isObject).map(record => structuredClone(record))
    : [];
}

function fitsResponse(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value, null, 2)) <= RESPONSE_BUDGET_BYTES;
}

function assertResponseFits(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > RESPONSE_HARD_LIMIT_BYTES) {
    throw new Error(
      'Workspace identity or locale context exceeds the response budget. ' +
      'Use dcsc_recovery_export to inspect the retained workspace safely.',
    );
  }
}

function appendWhileFits<T>(result: Record<string, unknown>, values: T[], candidates: T[]): void {
  for (const candidate of candidates) {
    values.push(candidate);
    if (!fitsResponse(result)) {
      values.pop();
      break;
    }
  }
}

function boundedText(value: string | undefined): {
  value: string | undefined;
  truncated: boolean;
} {
  if (value === undefined || value.length <= PREVIEW_TEXT_LIMIT) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, PREVIEW_TEXT_LIMIT), truncated: true };
}

function continuation(
  options: WorkspaceProjectionOptions,
  path: string[],
  offset = 0,
): Continuation {
  return {
    tool: options.tool,
    arguments: {
      ...options.arguments,
      path,
      offset,
      limit: options.pageLimit ?? DEFAULT_PAGE_LIMIT,
    },
  };
}

function collectionNavigation(
  options: WorkspaceProjectionOptions,
  path: string[],
  total: number,
  previewed: number,
): CollectionNavigation {
  return { total, previewed, inspect: continuation(options, path) };
}

function previewStringField(
  target: Record<string, unknown>,
  name: string,
  value: string | undefined,
  detail: Continuation,
): void {
  const bounded = boundedText(value);
  if (bounded.value !== undefined) target[name] = bounded.value;
  if (bounded.truncated) {
    target[`${name}Truncated`] = true;
    target.detail = detail;
  }
}

function cablePreview(
  cable: Record<string, unknown>,
  index: number,
  options: WorkspaceProjectionOptions,
): Record<string, unknown> {
  const detail = continuation(options, ['cables', String(index)]);
  const preview: Record<string, unknown> = { detail };
  for (const name of ['id', 'fromConfigId', 'fromPort', 'toConfigId', 'toPort', 'cableCode', 'description']) {
    const value = cable[name];
    if (typeof value === 'string') previewStringField(preview, name, value, detail);
  }
  return preview;
}

function rackAttachmentPreview(
  value: unknown,
  detail: Continuation,
  kind: 'floor' | 'power',
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const preview: Record<string, unknown> = {};
  const stringFields = kind === 'floor'
    ? ['id', 'rackId']
    : ['rackId', 'pduCode', 'cordCode', 'voltage'];
  for (const name of stringFields) {
    const field = value[name];
    if (typeof field === 'string') previewStringField(preview, name, field, detail);
  }
  if (kind === 'floor') {
    if (typeof value['x'] === 'number') preview['x'] = value['x'];
    if (typeof value['y'] === 'number') preview['y'] = value['y'];
  }
  return preview;
}

/**
 * Lossless JSON-safe source behind the compact workspace projections.
 *
 * Keep this source free of previews and truncation. projectJsonPage turns large
 * values into child continuations, so even an individual oversized rack or
 * cable remains inspectable without exceeding an MCP response budget.
 */
export function workspaceDetailSource(workspace: WorkspaceSession): Record<string, unknown> {
  const byConfigurationId = new Map(
    [...workspace.configurations.values()].map(session => [session.configurationId, session]),
  );
  const placedIds = new Set(
    [
      ...workspace.rackArea.flatMap(rack => [...physicalIds(rack)]),
      ...workspace.rackSummaries.flatMap(rack => rack.items.map(item => String(item.id ?? ''))),
    ],
  );

  const storageQuantities = storageComponentQuantities(workspace);
  const storageAliases = storagePhysicalTemplateIds(workspace);
  const configurations = [...workspace.configurations.values()].map(session => {
    const managedTemplate = storageQuantities.has(session.configurationId);
    const quantity = storageQuantities.get(session.configurationId) ?? session.raw.quantity ?? 1;
    const physical = managedTemplate ? storagePhysicalConfigurations(workspace, session.configurationId, session.raw) : [];
    const prices = physical.length ? physical.map(instance => configurationListPrice(instance.raw)) : [configurationListPrice(session.raw)];
    const priceAvailable = prices.every(price => price !== null);
    const unitPrice = priceAvailable && prices.every(price => price === prices[0]) ? prices[0]! : null;
    const extendedPrice = quantity === 0 ? 0 : !priceAvailable ? null : physical.length
      ? Math.round(prices.reduce<number>((total, price) => total + price!, 0) * 100) / 100 : unitPrice! * quantity;
    return {
      id: session.id,
      configurationId: session.configurationId,
      productCode: session.product.code,
      description: session.product.description,
      quantity,
      ...(managedTemplate ? { configurationQuantity: session.raw.quantity ?? 1, managedStorageTemplate: true } : {}),
      ...(physical.length ? { physicalInstances: physical.map(instance => ({ physicalId: instance.physicalId,
        unitPrice: configurationListPrice(instance.raw), configuration: structuredClone(instance.raw) })) } : {}),
      unitPrice,
      extendedPrice,
      priceAvailable,
      ...(!priceAvailable ? { knownPriceSubtotal: physical.length
        ? prices.reduce<number>((total, price) => total + (price ?? 0), 0) : 0 } : {}),
    };
  });

  const racks = workspace.rackSummaries.map(rack => ({
    rackId: rack.id,
    code: rack.code,
    description: rack.description,
    sizeU: rack.sizeU,
    usedU: rack.usedU,
    freeU: rack.freeU,
    emptyWeightKg: rack.emptyWeightKg,
    totalWeightKg: rack.totalWeightKg,
    stability: rack.stableStatus,
    floorTile: workspace.floorItems.find(item => item.rackId === rack.id) ?? null,
    powerSelection: workspace.powerSelections.find(selection => selection.rackId === rack.id) ?? null,
    items: rack.items.map(item => ({
      ...item,
      session: byConfigurationId.get(storageAliases.get(String(item.id ?? '')) ?? String(item.id ?? ''))?.id,
      ...(storageAliases.has(String(item.id ?? '')) ? { templateConfigurationId: storageAliases.get(String(item.id ?? '')) } : {}),
    })),
    errors: rack.errors.map(error => ({ ...error })),
  }));

  const nonRackIds = new Set(workspace.nonRackArea.flatMap(item => [...physicalIds(item)]));
  const detachedNodes = detachedNestedNodeIds(workspace);
  const unracked = [...[...workspace.configurations.values()]
    .filter(session => !placedIds.has(session.configurationId) && session.product.type !== 'rack' &&
      !storageQuantities.has(session.configurationId))
    .map(session => ({
      session: session.id,
      configurationId: session.configurationId,
      code: session.product.code,
      description: session.product.description,
      ...(detachedNodes.has(session.configurationId) ? { physicalState: 'detached; Lenovo reimport drops this node' } : {}),
    })), ...[...storageAliases].filter(([physicalId]) => nonRackIds.has(physicalId)).map(([physicalId, templateId]) => {
      const template = byConfigurationId.get(templateId);
      return { configurationId: physicalId, templateConfigurationId: templateId,
        session: template?.id, code: template?.product.code, description: template?.product.description };
    })];

  const softwareState = workspace.serverState['standaloneSoftwareState'];
  const standaloneSoftware = isObject(softwareState)
    ? clonedRecords(softwareState['selections'])
    : [];
  const hardwareState = workspace.serverState['standaloneHardwareState'];
  const standaloneHardware = isObject(hardwareState)
    ? clonedRecords(hardwareState['selections']).map(selection => {
        const unitPrice = selection['unitPrice'];
        const quantity = selection['quantity'];
        const totalPrice =
          typeof unitPrice === 'number' && Number.isFinite(unitPrice) &&
          typeof quantity === 'number' && Number.isFinite(quantity) &&
          selection['priceNotAvailable'] !== true
            ? Math.round(unitPrice * quantity * 100) / 100
            : undefined;
        return { ...selection, ...(totalPrice !== undefined ? { totalPrice } : {}) };
      })
    : [];
  const rawConnections = readConnectionGraph(workspace.serverState);
  const autoConnectMessages = workspace.rackArea.flatMap(rack => {
    const errors = Array.isArray(rack['errors']) ? rack['errors'] : [];
    const messages = errors.filter(isObject)
      .filter(error => String(error['code'] ?? '') === '102')
      .map(error => String(error['message'] ?? ''))
      .filter(Boolean);
    return messages.length > 0 ? [{ rackId: String(rack['id'] ?? ''), messages }] : [];
  });
  const layoutErrors = Array.isArray(workspace.serverState['layoutErrors'])
    ? structuredClone(workspace.serverState['layoutErrors'])
    : [];

  return {
    configurations,
    racks,
    unracked,
    cables: workspace.cables.map(cable => ({ ...cable })),
    floorItems: workspace.floorItems.map(item => ({ ...item })),
    powerSelections: workspace.powerSelections.map(selection => ({ ...selection })),
    storageNetworks: structuredClone(storageConnectionNetworkSource(workspace.serverState)),
    cloneDependency: structuredClone(workspace.serverState.cloneDependency ?? {}),
    cloneDependencyColor: structuredClone(workspace.serverState.cloneDependencyColor ?? {}),
    detachedStorageComponents: structuredClone(workspace.serverState.detachedStorageComponents ?? []),
    rawRackArea: structuredClone(workspace.rackArea),
    rawNonRackArea: structuredClone(workspace.nonRackArea),
    layoutErrors,
    rawConnections,
    cablingDiagnostics: cablingDiagnostics([...workspace.configurations.values()].map(session => session.raw), workspace.serverState),
    importDiagnostics: structuredClone(workspace.serverState.lastImportDiagnostics ?? {}),
    autoConnectMessages,
    standaloneSoftware,
    standaloneHardware,
    integrityWarnings: [...workspace.integrityWarnings],
  };
}

export function workspaceProjectionTotals(
  source: ReturnType<typeof workspaceDetailSource>,
): WorkspaceProjectionTotals {
  const configurations = source['configurations'] as unknown[];
  const racks = source['racks'] as Array<{ items: unknown[]; errors: unknown[] }>;
  const unracked = source['unracked'] as unknown[];
  const cables = source['cables'] as unknown[];
  const floorItems = source['floorItems'] as unknown[];
  const powerSelections = source['powerSelections'] as unknown[];
  const rawRackArea = source['rawRackArea'] as unknown[];
  const rawNonRackArea = source['rawNonRackArea'] as unknown[];
  const layoutErrors = source['layoutErrors'] as unknown[];
  const rawConnections = source['rawConnections'] as unknown[];
  const autoConnectMessageGroups = source['autoConnectMessages'] as Array<{ messages: unknown[] }>;
  const standaloneSoftware = source['standaloneSoftware'] as unknown[];
  const integrityWarnings = source['integrityWarnings'] as unknown[];
  return {
    configurations: configurations.length,
    racks: racks.length,
    rackItems: racks.reduce((sum, rack) => sum + rack.items.length, 0),
    rackErrors: racks.reduce((sum, rack) => sum + rack.errors.length, 0),
    unracked: unracked.length,
    cables: cables.length,
    floorItems: floorItems.length,
    powerSelections: powerSelections.length,
    storageNetworks: Array.isArray(source['storageNetworks']) ? source['storageNetworks'].length : 0,
    cloneDependency: Object.keys(source['cloneDependency'] as Record<string, unknown>).length,
    cloneDependencyColor: Object.keys(source['cloneDependencyColor'] as Record<string, unknown>).length,
    rawRackArea: rawRackArea.length,
    rawNonRackArea: rawNonRackArea.length,
    layoutErrors: layoutErrors.length,
    rawConnections: rawConnections.length,
    autoConnectMessageGroups: autoConnectMessageGroups.length,
    autoConnectMessages: autoConnectMessageGroups.reduce((sum, group) => sum + group.messages.length, 0),
    standaloneSoftware: standaloneSoftware.length,
    integrityWarnings: integrityWarnings.length,
  };
}

/** Bounded integrity fragment reusable by single-configuration and standalone summaries. */
export function projectWorkspaceIntegrity(
  workspace: WorkspaceSession,
  options: WorkspaceProjectionOptions,
): Record<string, unknown> {
  const integrityWarnings: unknown[] = [];
  const result: Record<string, unknown> = {
    integrity: workspace.integrity,
    integrityWarnings,
    integrityWarningCount: workspace.integrityWarnings.length,
    integrityWarningsPage: collectionNavigation(
      options,
      ['integrityWarnings'],
      workspace.integrityWarnings.length,
      0,
    ),
  };
  const candidates = workspace.integrityWarnings.map((warning, index) => {
    const bounded = boundedText(warning);
    return bounded.truncated
      ? { text: bounded.value, truncated: true, detail: continuation(options, ['integrityWarnings', String(index)]) }
      : warning;
  });
  appendWhileFits(result, integrityWarnings, candidates);
  (result['integrityWarningsPage'] as CollectionNavigation).previewed = integrityWarnings.length;
  assertResponseFits(result);
  return result;
}

/** Compact replacement for the multi-configuration dcsc_session_info body. */
export function projectWorkspaceSummary(
  workspace: WorkspaceSession,
  options: WorkspaceProjectionOptions,
): Record<string, unknown> {
  const source = workspaceDetailSource(workspace);
  const totals = workspaceProjectionTotals(source);
  const configurations = source['configurations'] as Array<Record<string, unknown>>;
  const racks = source['racks'] as Array<Record<string, unknown>>;
  const cables = source['cables'] as Array<Record<string, unknown>>;
  const standaloneSoftware = source['standaloneSoftware'] as Array<Record<string, unknown>>;
  const standaloneHardware = source['standaloneHardware'] as Array<Record<string, unknown>>;
  const warnings = source['integrityWarnings'] as string[];

  const configCandidates = configurations.map((configuration, index) => {
    const detail = continuation(options, ['configurations', String(index)]);
    const preview: Record<string, unknown> = {
      quantity: configuration['quantity'],
      unitPrice: configuration['unitPrice'],
      extendedPrice: configuration['extendedPrice'],
      priceAvailable: configuration['priceAvailable'],
      ...(configuration['knownPriceSubtotal'] !== undefined ? { knownPriceSubtotal: configuration['knownPriceSubtotal'] } : {}),
      ...(configuration['managedStorageTemplate'] === true ? {
        managedStorageTemplate: true, configurationQuantity: configuration['configurationQuantity'],
      } : {}),
    };
    previewStringField(preview, 'id', configuration['id'] as string | undefined, detail);
    previewStringField(preview, 'productCode', configuration['productCode'] as string | undefined, detail);
    previewStringField(
      preview,
      'description',
      configuration['description'] as string | undefined,
      detail,
    );
    return preview;
  });

  const rackCandidates = racks.map((rack, index) => {
    const detail = continuation(options, ['racks', String(index)]);
    const preview: Record<string, unknown> = {
      sizeU: rack['sizeU'], usedU: rack['usedU'], freeU: rack['freeU'],
      totalWeightKg: rack['totalWeightKg'], itemCount: (rack['items'] as unknown[]).length,
      errorCount: (rack['errors'] as unknown[]).length, detail,
    };
    previewStringField(preview, 'rackId', rack['rackId'] as string | undefined, detail);
    previewStringField(preview, 'code', rack['code'] as string | undefined, detail);
    previewStringField(preview, 'stability', rack['stability'] as string | undefined, detail);
    return preview;
  });

  const cableCandidates = cables.map((cable, index) =>
    cablePreview(cable, index, options));

  const warningCandidates = warnings.map((warning, index) => {
    const bounded = boundedText(warning);
    return bounded.truncated
      ? { text: bounded.value, truncated: true, detail: continuation(options, ['integrityWarnings', String(index)]) }
      : warning;
  });

  const standaloneCandidates = standaloneSoftware.map((selection, index) => {
    const detail = continuation(options, ['standaloneSoftware', String(index)]);
    const preview: Record<string, unknown> = { detail };
    for (const name of ['id', 'code']) {
      const value = selection[name];
      if (typeof value === 'string') previewStringField(preview, name, value, detail);
    }
    for (const name of ['quantity', 'unitPrice', 'totalPrice']) {
      if (typeof selection[name] === 'number') preview[name] = selection[name];
    }
    return preview;
  });

  const configurationSubtotal = configurations.reduce(
    (sum, configuration) => sum + Number(configuration['extendedPrice'] ?? configuration['knownPriceSubtotal'] ?? 0),
    0,
  );
  const standaloneSoftwareSubtotal = standaloneSoftware.reduce(
    (sum, selection) => sum + (softwareSelectionPriceAvailable(selection) ? selection['totalPrice'] as number : 0),
    0,
  );
  const standaloneHardwareSubtotal = standaloneHardware.reduce(
    (sum, selection) => sum + (softwareSelectionPriceAvailable(selection) ? selection['totalPrice'] as number : 0),
    0,
  );
  const priceIncomplete = configurations.some(configuration => Number(configuration['quantity']) > 0 && configuration['priceAvailable'] !== true) ||
    standaloneSoftware.some(selection => !softwareSelectionPriceAvailable(selection)) ||
    standaloneHardware.some(selection => !softwareSelectionPriceAvailable(selection));

  const configPreview: Array<Record<string, unknown>> = [];
  const rackPreview: Array<Record<string, unknown>> = [];
  const cablePreviews: Array<Record<string, unknown>> = [];
  const warningPreview: unknown[] = [];
  const standalonePreviews: Array<Record<string, unknown>> = [];

  const pages = {
    configurations: collectionNavigation(options, ['configurations'], totals.configurations, 0),
    cablingDiagnostics: { inspect: continuation(options, ['cablingDiagnostics']) },
    ...(totals.cloneDependency > 0 ? { cloneDependency:
      collectionNavigation(options, ['cloneDependency'], totals.cloneDependency, 0) } : {}),
    ...(totals.cloneDependencyColor > 0 ? { cloneDependencyColor:
      collectionNavigation(options, ['cloneDependencyColor'], totals.cloneDependencyColor, 0) } : {}),
    racks: collectionNavigation(options, ['racks'], totals.racks, 0),
    cables: collectionNavigation(options, ['cables'], totals.cables, 0),
    rawConnections: collectionNavigation(options, ['rawConnections'], totals.rawConnections, 0),
    rawRackArea: collectionNavigation(options, ['rawRackArea'], totals.rawRackArea, 0),
    rawNonRackArea: collectionNavigation(options, ['rawNonRackArea'], totals.rawNonRackArea, 0),
    layoutErrors: collectionNavigation(options, ['layoutErrors'], totals.layoutErrors, 0),
    autoConnectMessages: collectionNavigation(options, ['autoConnectMessages'], totals.autoConnectMessageGroups, 0),
    standaloneSoftware: collectionNavigation(options, ['standaloneSoftware'], totals.standaloneSoftware, 0),
    integrityWarnings: collectionNavigation(options, ['integrityWarnings'], totals.integrityWarnings, 0),
  };

  const combinedSubtotal = configurationSubtotal + standaloneSoftwareSubtotal + standaloneHardwareSubtotal;
  const result: Record<string, unknown> = {
    workspace: workspace.id,
    revision: workspace.revision,
    ...(workspace.serverState.connectionGraphInvalidation !== undefined ? {
      connectionGraphStale: true,
      refreshConnections: { tool: 'dcsc_add_cabling', arguments: { session: workspace.id, mode: 'auto' } },
    } : {}),
    workspaceRevision: workspace.revision,
    revisionScope: 'workspace',
    integrity: workspace.integrity,
    integrityWarnings: warningPreview,
    isMultiProduct: true,
    totalPrice: priceIncomplete ? null : Math.round(combinedSubtotal * 100) / 100,
    ...(priceIncomplete ? { knownPriceSubtotal: Math.round(combinedSubtotal * 100) / 100 } : {}),
    priceIncomplete,
    subtotals: {
      configurations: Math.round(configurationSubtotal * 100) / 100,
      standaloneSoftware: Math.round(standaloneSoftwareSubtotal * 100) / 100,
      ...(standaloneHardware.length > 0
        ? { standaloneHardware: Math.round(standaloneHardwareSubtotal * 100) / 100 }
        : {}),
    },
    currency: workspace.locale.currency,
    country: workspace.locale.country,
    configurations: configPreview,
    racks: rackPreview,
    cables: cablePreviews,
    standaloneSoftware: standalonePreviews,
    totals,
    pages,
  };
  appendWhileFits(result, configPreview, configCandidates);
  appendWhileFits(result, rackPreview, rackCandidates);
  appendWhileFits(result, cablePreviews, cableCandidates);
  appendWhileFits(result, standalonePreviews, standaloneCandidates);
  appendWhileFits(result, warningPreview, warningCandidates);
  pages.configurations.previewed = configPreview.length;
  pages.racks.previewed = rackPreview.length;
  pages.cables.previewed = cablePreviews.length;
  pages.standaloneSoftware.previewed = standalonePreviews.length;
  pages.integrityWarnings.previewed = warningPreview.length;
  assertResponseFits(result);
  return result;
}

/** Compact replacement for the default dcsc_workspace_layout response. */
export function projectWorkspaceLayout(
  workspace: WorkspaceSession,
  options: WorkspaceProjectionOptions,
): Record<string, unknown> {
  const source = workspaceDetailSource(workspace);
  const totals = workspaceProjectionTotals(source);
  const racks = source['racks'] as Array<Record<string, unknown>>;
  const unracked = source['unracked'] as Array<Record<string, unknown>>;
  const cables = source['cables'] as Array<Record<string, unknown>>;
  const floorItems = source['floorItems'] as Array<Record<string, unknown>>;
  const unstable = racks.filter(rack => rack['stability'] && rack['stability'] !== 'PASSED');

  const unrackedCandidates = unracked.map((item, index) => {
    const detail = continuation(options, ['unracked', String(index)]);
    const preview: Record<string, unknown> = { detail };
    for (const name of ['session', 'configurationId', 'templateConfigurationId', 'code', 'description', 'physicalState']) {
      const value = item[name];
      if (typeof value === 'string') previewStringField(preview, name, value, detail);
    }
    return preview;
  });

  const floorCandidates = floorItems.map((item, index) => {
    const detail = continuation(options, ['floorItems', String(index)]);
    const preview: Record<string, unknown> = { detail };
    previewStringField(preview, 'id', item['id'] as string | undefined, detail);
    previewStringField(preview, 'rackId', item['rackId'] as string | undefined, detail);
    if (typeof item['x'] === 'number') preview['x'] = item['x'];
    if (typeof item['y'] === 'number') preview['y'] = item['y'];
    return preview;
  });

  const rackPreview: Array<Record<string, unknown>> = [];
  const unrackedPreview: Array<Record<string, unknown>> = [];
  const cablePreviews: Array<Record<string, unknown>> = [];
  const floorPreviews: Array<Record<string, unknown>> = [];

  const pages = {
    racks: collectionNavigation(options, ['racks'], totals.racks, 0),
    cablingDiagnostics: { inspect: continuation(options, ['cablingDiagnostics']) },
    ...(totals.cloneDependency > 0 ? { cloneDependency:
      collectionNavigation(options, ['cloneDependency'], totals.cloneDependency, 0) } : {}),
    ...(totals.cloneDependencyColor > 0 ? { cloneDependencyColor:
      collectionNavigation(options, ['cloneDependencyColor'], totals.cloneDependencyColor, 0) } : {}),
    unracked: collectionNavigation(options, ['unracked'], totals.unracked, 0),
    cables: collectionNavigation(options, ['cables'], totals.cables, 0),
    rawConnections: collectionNavigation(options, ['rawConnections'], totals.rawConnections, 0),
    rawRackArea: collectionNavigation(options, ['rawRackArea'], totals.rawRackArea, 0),
    rawNonRackArea: collectionNavigation(options, ['rawNonRackArea'], totals.rawNonRackArea, 0),
    layoutErrors: collectionNavigation(options, ['layoutErrors'], totals.layoutErrors, 0),
    autoConnectMessages: collectionNavigation(options, ['autoConnectMessages'], totals.autoConnectMessageGroups, 0),
    floorItems: collectionNavigation(options, ['floorItems'], totals.floorItems, 0),
    powerSelections: collectionNavigation(options, ['powerSelections'], totals.powerSelections, 0),
    storageNetworks: collectionNavigation(options, ['storageNetworks'], totals.storageNetworks, 0),
  };

  const unstablePreview = unstable.slice(0, 3)
    .map(rack => `${boundedText(String(rack['code'])).value}=${boundedText(String(rack['stability'])).value}`);

  const result: Record<string, unknown> = {
    workspace: workspace.id,
    rackCount: totals.racks,
    ...(workspace.serverState.connectionGraphInvalidation !== undefined ? {
      connectionGraphStale: true,
      refreshConnections: { tool: 'dcsc_add_cabling', arguments: { session: workspace.id, mode: 'auto' } },
    } : {}),
    racks: rackPreview,
    unracked: unrackedPreview,
    cables: cablePreviews,
    floorItems: floorPreviews,
    totals,
    pages,
    ...(unstable.length > 0
      ? {
          stabilityWarning:
            `Centre-of-gravity check returned ${unstablePreview.join(', ')}` +
            `${unstable.length > unstablePreview.length ? ` and ${unstable.length - unstablePreview.length} more` : ''}. ` +
            'FAILED means the rack is not safe to ship as laid out.',
        }
      : {}),
    note:
      'Layout is what DCSC validated at placement time. Follow pages.inspect/detail continuations for the complete elevation and cabling.',
  };

  for (let rackIndex = 0; rackIndex < racks.length; rackIndex += 1) {
    const rack = racks[rackIndex]!;
    const items = rack['items'] as Array<Record<string, unknown>>;
    const errors = rack['errors'] as Array<Record<string, unknown>>;
    const detail = continuation(options, ['racks', String(rackIndex)]);
    const preview: Record<string, unknown> = {
      sizeU: rack['sizeU'], usedU: rack['usedU'], freeU: rack['freeU'],
      emptyWeightKg: rack['emptyWeightKg'], totalWeightKg: rack['totalWeightKg'],
      floorTile: rackAttachmentPreview(rack['floorTile'], detail, 'floor'),
      powerSelection: rackAttachmentPreview(rack['powerSelection'], detail, 'power'),
      itemCount: items.length, errorCount: errors.length,
      items: [], errors: [], itemsReturned: 0, errorsReturned: 0,
      itemsComplete: items.length === 0, errorsComplete: errors.length === 0,
      detail,
    };
    for (const name of ['rackId', 'code', 'description', 'stability']) {
      const value = rack[name];
      if (typeof value === 'string') previewStringField(preview, name, value, detail);
    }
    rackPreview.push(preview);
    if (!fitsResponse(result)) {
      rackPreview.pop();
      break;
    }

    const itemPreviews = preview['items'] as Array<Record<string, unknown>>;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex]!;
      const itemDetail = continuation(options, ['racks', String(rackIndex), 'items', String(itemIndex)]);
      const itemPreview: Record<string, unknown> = {
        position: item['position'], endPosition: item['endPosition'], sizeU: item['sizeU'], detail: itemDetail,
      };
      for (const name of ['id', 'code', 'description', 'session']) {
        const value = item[name];
        if (typeof value === 'string') previewStringField(itemPreview, name, value, itemDetail);
      }
      itemPreviews.push(itemPreview);
      preview['itemsReturned'] = itemPreviews.length;
      preview['itemsComplete'] = itemPreviews.length === items.length;
      if (!fitsResponse(result)) {
        itemPreviews.pop();
        preview['itemsReturned'] = itemPreviews.length;
        preview['itemsComplete'] = false;
        break;
      }
    }

    const errorPreviews = preview['errors'] as Array<Record<string, unknown>>;
    for (let errorIndex = 0; errorIndex < errors.length; errorIndex += 1) {
      const error = errors[errorIndex]!;
      const errorDetail = continuation(options, ['racks', String(rackIndex), 'errors', String(errorIndex)]);
      const errorPreview: Record<string, unknown> = { detail: errorDetail };
      for (const name of ['code', 'message']) {
        const value = error[name];
        if (typeof value === 'string') previewStringField(errorPreview, name, value, errorDetail);
      }
      errorPreviews.push(errorPreview);
      preview['errorsReturned'] = errorPreviews.length;
      preview['errorsComplete'] = errorPreviews.length === errors.length;
      if (!fitsResponse(result)) {
        errorPreviews.pop();
        preview['errorsReturned'] = errorPreviews.length;
        preview['errorsComplete'] = false;
        break;
      }
    }
  }

  appendWhileFits(result, unrackedPreview, unrackedCandidates);
  appendWhileFits(result, cablePreviews, cables.map((cable, index) => cablePreview(cable, index, options)));
  appendWhileFits(result, floorPreviews, floorCandidates);
  pages.racks.previewed = rackPreview.length;
  pages.unracked.previewed = unrackedPreview.length;
  pages.cables.previewed = cablePreviews.length;
  pages.floorItems.previewed = floorPreviews.length;
  assertResponseFits(result);
  return result;
}

function softwareSelectionPriceAvailable(selection: Record<string, unknown>): boolean {
  const feature = selection['feature'];
  return typeof selection['totalPrice'] === 'number' && Number.isFinite(selection['totalPrice']) &&
    selection['priceNotAvailable'] !== true &&
    (!isObject(feature) || feature['priceNotAvailable'] !== true);
}

/** Lossless bounded detail page used when a projection tool receives path. */
export function projectWorkspacePage(
  workspace: WorkspaceSession,
  options: WorkspacePageOptions,
): Record<string, unknown> {
  return projectJsonPage(workspaceDetailSource(workspace), options);
}
