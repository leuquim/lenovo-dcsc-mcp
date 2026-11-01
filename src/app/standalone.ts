import { reconcileImportedSoftwareCatalog, SERVICE_METADATA_REFRESH_WARNING } from '../domain/importStandalone.js';
import { fetchSupplyStatus } from '../domain/supplyStatus.js';
import { renderRackImage } from '../domain/rackImage.js';
import {
  buildExportData,
  buildExportForm,
  buildGroups,
  DEFAULT_EXPORT_TYPES,
  type ExportFileType,
} from '../domain/reduce.js';
import {
  buildProductServiceExportEnvelope,
  buildStandaloneSoftwareExportEnvelope,
  findParts,
  launchProductServices,
  refreshProductServiceCatalog,
  launchStandaloneSoftware,
  removeProductService,
  removeStandaloneSoftware,
  selectProductService,
  selectStandaloneSoftware,
  setStandaloneSoftwareQuantity,
  summariseProductServices,
  type PartLookupType,
  type ProductServiceState,
  type StandaloneSoftwareState,
} from '../domain/standalone.js';
import {
  emptyStandaloneHardware,
  lookupStandaloneHardwarePart,
  removeStandaloneHardware,
  selectStandaloneHardware,
  setStandaloneHardwareQuantity,
  standaloneHardwareExportItem,
  standaloneHardwareGroupProduct,
  type StandaloneHardwareState,
} from '../domain/standaloneHardware.js';
import { exportZipPath } from '../domain/endpoints.js';
import { hardwareEndpointFamily } from '../domain/modeFamily.js';
import { writeExportBundle, type ExportBundle } from '../files/artifactStore.js';
import type { RequestCtx } from '../http/request.js';
import type { SolutionContext } from '../config/schema.js';
import type { WorkspaceSession } from '../model/session.js';
import { isObject } from '../util/coerce.js';
import { assertTrustedWorkspace } from './reconciliation.js';
import type { Runtime } from './runtime.js';

const SOFTWARE_STATE = 'standaloneSoftwareState';
const SERVICE_STATE = 'standaloneServiceState';
const HARDWARE_STATE = 'standaloneHardwareState';
const PART_LOOKUP_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_PART_LOOKUP_SNAPSHOTS = 4;
const SERVICE_WORKSPACE_REQUIRED = 'Independent services require a separate workspace.';
const SOFTWARE_CATALOG_EXISTS = 'This workspace already has a software catalog. Use refresh=true to preserve selections or replace=true to reset it.';
const SERVICE_GRAPH_EXISTS = 'This workspace already has a product-service graph. Use refresh=true to preserve selections or replace=true to reset it.';
const SERVICE_SELECTION_REQUIRED = 'serviceCode is required when more than one product service is selected.';
/** Captured default choices in the standalone software export dialog. */
export const SOFTWARE_EXPORT_TYPES: ExportFileType[] = ['XML', 'QUOTE', 'QUOTE_SUPPLYINFO', 'QUOTE_GROUP', 'SUMMARY', 'POWER_REPORT', 'QUOTE_CSV', 'EPRICE_CSV'];

export type PartLookupItem = {
  code: string;
  description: string;
  type: string;
  nextAction: string;
};

export interface PartLookupArgs {
  keyword: string;
  mode: 'CTO' | 'LFO';
  types?: readonly PartLookupType[] | undefined;
  solutionMode?: string | undefined;
  expectedCatalogFingerprint?: string | undefined;
}

export interface SupplyStatusProjection {
  code: string;
  type: string;
  country: string;
  shippingStatus: unknown;
}

const partLookupSnapshots = new WeakMap<Runtime, Map<string, { at: number; items: PartLookupItem[] }>>();

export function requireWorkspace(rt: Runtime, handle: string): WorkspaceSession {
  const workspace = rt.sessions.getWorkspace(handle);
  if (!workspace) throw new Error(`Workspace ${handle} not found.`);
  return workspace;
}

export function hardwareState(workspace: WorkspaceSession): StandaloneHardwareState;
export function hardwareState(workspace: WorkspaceSession, required: false): StandaloneHardwareState | undefined;
export function hardwareState(workspace: WorkspaceSession, required = true): StandaloneHardwareState | undefined {
  const value = workspace.serverState[HARDWARE_STATE];
  if (isObject(value) && value['kind'] === 'standalone-hardware') return value as unknown as StandaloneHardwareState;
  if (required) throw new Error(`Workspace ${workspace.id} has no standalone hardware. Add a part with dcsc_standalone_hardware_add.`);
  return undefined;
}

export function softwareState(workspace: WorkspaceSession): StandaloneSoftwareState;
export function softwareState(workspace: WorkspaceSession, required: false): StandaloneSoftwareState | undefined;
export function softwareState(workspace: WorkspaceSession, required = true): StandaloneSoftwareState | undefined {
  const value = workspace.serverState[SOFTWARE_STATE];
  if (isObject(value) && value['kind'] === 'standalone-software') {
    return value as unknown as StandaloneSoftwareState;
  }
  if (required) throw new Error(`Workspace ${workspace.id} has no standalone software catalog.`);
  return undefined;
}

export function serviceState(workspace: WorkspaceSession): ProductServiceState;
export function serviceState(workspace: WorkspaceSession, required: false): ProductServiceState | undefined;
export function serviceState(workspace: WorkspaceSession, required = true): ProductServiceState | undefined {
  const value = workspace.serverState[SERVICE_STATE];
  if (isObject(value) && value['kind'] === 'product-bound-services') {
    return value as unknown as ProductServiceState;
  }
  if (required) throw new Error(`Workspace ${workspace.id} has no product-service graph.`);
  return undefined;
}

function revisionOption(expectedRevision: number | undefined): { expectedRevision?: number } {
  return expectedRevision !== undefined ? { expectedRevision } : {};
}

async function contextFor(rt: Runtime, workspace: WorkspaceSession | undefined, requestedMode: string | undefined) {
  if (workspace) {
    if (requestedMode && requestedMode !== workspace.solution.solutionMode) {
      throw new Error(
        `Workspace ${workspace.id} uses solution mode ${workspace.solution.solutionMode}, not ${requestedMode}.`,
      );
    }
    return {
      solution: workspace.solution,
      ctx: rt.newCtx({ locale: workspace.locale, solution: workspace.solution }),
    };
  }
  const initial = rt.newCtx();
  const solution = await rt.resolveSolution(initial, requestedMode);
  return { solution, ctx: rt.newCtx({ solution }) };
}

function workspaceCtx(rt: Runtime, workspace: WorkspaceSession): RequestCtx {
  return rt.newCtx({ locale: workspace.locale, solution: workspace.solution });
}

function workspaceContextFor(ctx: RequestCtx, solution: SolutionContext, label: string | undefined) {
  return { locale: ctx.locale, solution, ...(label !== undefined ? { label } : {}) };
}

function snapshotsFor(rt: Runtime) {
  let snapshots = partLookupSnapshots.get(rt);
  if (!snapshots) {
    snapshots = new Map();
    partLookupSnapshots.set(rt, snapshots);
  }
  return snapshots;
}

export async function lookupParts(rt: Runtime, args: PartLookupArgs) {
  const initial = rt.newCtx();
  const solution = await rt.resolveSolution(initial, args.solutionMode);
  const ctx = rt.newCtx({ solution });
  const snapshots = snapshotsFor(rt);
  const snapshotKey = JSON.stringify({
    keyword: args.keyword.trim(),
    types: args.types ?? ['SOFTWARE', 'SERVICE', 'HARDWARE'],
    mode: args.mode,
    locale: ctx.locale,
    solution,
  });
  const now = Date.now();
  for (const [key, snapshot] of snapshots) {
    if (now - snapshot.at >= PART_LOOKUP_SNAPSHOT_TTL_MS) snapshots.delete(key);
  }
  let items = args.expectedCatalogFingerprint
    ? snapshots.get(snapshotKey)?.items
    : undefined;
  if (!items) {
    const result = await findParts(rt.http, ctx, {
      keyword: args.keyword,
      mode: args.mode,
      ...(args.types !== undefined ? { types: args.types } : {}),
    });
    items = result.items.map((item) => ({ code: item.code, description: item.description,
      type: item.type, nextAction: item.nextAction }));
    snapshots.delete(snapshotKey);
    snapshots.set(snapshotKey, { at: now, items });
    while (snapshots.size > MAX_PART_LOOKUP_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  }
  return { ctx, solution, items };
}

export async function partSupplyStatus(
  rt: Runtime,
  ctx: RequestCtx,
  targetCode: string,
  type: string,
): Promise<SupplyStatusProjection> {
  try {
    const supply = await fetchSupplyStatus(rt.http, ctx, {
      code: targetCode,
      type,
      country: ctx.locale.country,
    });
    return {
      code: supply.code,
      type: supply.type,
      country: supply.country,
      shippingStatus: supply.shippingStatus,
    };
  } catch {
    return {
      code: targetCode,
      type,
      country: ctx.locale.country,
      shippingStatus: [],
    };
  }
}

export async function launchSoftware(rt: Runtime, args: {
  session?: string | undefined;
  solutionMode?: string | undefined;
  label?: string | undefined;
  replace: boolean;
  refresh: boolean;
  expectedRevision?: number | undefined;
}): Promise<{ workspace: WorkspaceSession; state: StandaloneSoftwareState }> {
  if (args.replace && args.refresh) throw new Error('Choose refresh or replace, not both.');
  const existing = args.session ? requireWorkspace(rt, args.session) : undefined;
  if (existing && softwareState(existing, false) && !args.replace && !args.refresh) {
    throw new Error(SOFTWARE_CATALOG_EXISTS);
  }
  const { ctx, solution } = await contextFor(rt, existing, args.solutionMode);
  const state = await launchStandaloneSoftware(rt.http, ctx);
  const result = await rt.sessions.createManyAtomic([], {
    ...(existing ? { workspaceHandle: existing.id } : {}),
    ...revisionOption(args.expectedRevision),
    ...(!existing ? { workspaceContext: workspaceContextFor(ctx, solution, args.label) } : {}),
    prepare: (draft) => {
      if (softwareState(draft, false) && !args.replace && !args.refresh) {
        throw new Error(SOFTWARE_CATALOG_EXISTS);
      }
      if (draft.serverState[SERVICE_STATE]) throw new Error(SERVICE_WORKSPACE_REQUIRED);
      const current = softwareState(draft, false);
      draft.serverState[SOFTWARE_STATE] = current && args.refresh
        ? reconcileImportedSoftwareCatalog(current, state) : state;
    },
  });
  return { workspace: result.workspace, state };
}

export async function selectSoftware(rt: Runtime, args: {
  session: string;
  code: string;
  quantity: number;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  await rt.sessions.transact(
    args.session,
    { keepEmptyWorkspace: true, ...revisionOption(args.expectedRevision) },
    (draft) => {
      draft.serverState[SOFTWARE_STATE] = selectStandaloneSoftware(softwareState(draft), {
        code: args.code,
        quantity: args.quantity,
      });
    },
  );
  return requireWorkspace(rt, args.session);
}

export async function setSoftwareQuantity(rt: Runtime, args: {
  session: string;
  code: string;
  quantity: number;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  await rt.sessions.transact(
    args.session,
    { keepEmptyWorkspace: true, ...revisionOption(args.expectedRevision) },
    (draft) => {
      draft.serverState[SOFTWARE_STATE] = setStandaloneSoftwareQuantity(
        softwareState(draft),
        args.code,
        args.quantity,
      );
    },
  );
  return requireWorkspace(rt, args.session);
}

export async function removeSoftware(rt: Runtime, args: {
  session: string;
  code: string;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  await rt.sessions.transact(
    args.session,
    { keepEmptyWorkspace: true, ...revisionOption(args.expectedRevision) },
    (draft) => {
      const current = softwareState(draft);
      if (!current.selections.some((selection) => selection.code === args.code)) {
        throw new Error(`Standalone software ${args.code} is not selected.`);
      }
      draft.serverState[SOFTWARE_STATE] = removeStandaloneSoftware(current, args.code);
    },
  );
  return requireWorkspace(rt, args.session);
}

export async function addHardware(rt: Runtime, args: {
  session?: string | undefined;
  code: string;
  quantity: number;
  solutionMode?: string | undefined;
  label?: string | undefined;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  const existing = args.session ? requireWorkspace(rt, args.session) : undefined;
  if (existing?.serverState[SERVICE_STATE]) throw new Error(SERVICE_WORKSPACE_REQUIRED);
  const { ctx, solution } = await contextFor(rt, existing, args.solutionMode);
  const part = await lookupStandaloneHardwarePart(rt.http, ctx, args.code);
  const result = await rt.sessions.createManyAtomic([], {
    ...(existing ? { workspaceHandle: existing.id } : {}),
    ...revisionOption(args.expectedRevision),
    ...(!existing ? { workspaceContext: workspaceContextFor(ctx, solution, args.label) } : {}),
    prepare: (draft) => {
      if (draft.serverState[SERVICE_STATE]) throw new Error(SERVICE_WORKSPACE_REQUIRED);
      draft.serverState[HARDWARE_STATE] = selectStandaloneHardware(
        hardwareState(draft, false) ?? emptyStandaloneHardware(), part, args.quantity);
    },
  });
  return result.workspace;
}

export async function setHardwareQuantity(rt: Runtime, args: {
  session: string;
  code: string;
  quantity: number;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  await rt.sessions.transact(
    args.session,
    { keepEmptyWorkspace: true, ...revisionOption(args.expectedRevision) },
    (draft) => {
      draft.serverState[HARDWARE_STATE] = setStandaloneHardwareQuantity(hardwareState(draft), args.code, args.quantity);
    },
  );
  return requireWorkspace(rt, args.session);
}

export async function removeHardware(rt: Runtime, args: {
  session: string;
  code: string;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  await rt.sessions.transact(
    args.session,
    { keepEmptyWorkspace: true, ...revisionOption(args.expectedRevision) },
    (draft) => {
      draft.serverState[HARDWARE_STATE] = removeStandaloneHardware(hardwareState(draft), args.code);
    },
  );
  return requireWorkspace(rt, args.session);
}

export async function launchServices(rt: Runtime, args: {
  productCode?: string | undefined;
  productQuantity: number;
  productDescription?: string | undefined;
  subCategory: string;
  session?: string | undefined;
  solutionMode?: string | undefined;
  label?: string | undefined;
  replace: boolean;
  refresh: boolean;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  if (args.replace && args.refresh) throw new Error('Choose refresh or replace, not both.');
  const existing = args.session ? requireWorkspace(rt, args.session) : undefined;
  if (args.refresh) {
    if (!existing || !serviceState(existing, false)) throw new Error('Service refresh requires an existing service workspace.');
    if (args.productCode && args.productCode !== serviceState(existing).product.code) {
      throw new Error('Refresh cannot change the serviced product. Launch a new workspace for another product.');
    }
    const { ctx } = await contextFor(rt, existing, args.solutionMode);
    await rt.sessions.transact(existing.id, {
      expectedRevision: args.expectedRevision, keepEmptyWorkspace: true, remoteApplied: true,
    }, async (draft) => {
      draft.serverState[SERVICE_STATE] = await refreshProductServiceCatalog(rt.http, ctx, serviceState(draft));
      draft.integrityWarnings = draft.integrityWarnings.filter(warning => warning !== SERVICE_METADATA_REFRESH_WARNING);
    });
    return requireWorkspace(rt, existing.id);
  }
  if (!args.productCode) throw new Error('productCode is required when opening or replacing a service workspace.');
  if (existing && serviceState(existing, false) && !args.replace) {
    throw new Error(SERVICE_GRAPH_EXISTS);
  }
  if (existing && (existing.configurations.size > 0 || existing.serverState[SOFTWARE_STATE])) throw new Error('Independent services require a separate service-only workspace.');
  const { ctx, solution } = await contextFor(rt, existing, args.solutionMode);
  const state = await launchProductServices(rt.http, ctx, {
    productCode: args.productCode,
    productQuantity: args.productQuantity,
    subCategory: args.subCategory,
    ...(args.productDescription !== undefined
      ? { productDescription: args.productDescription }
      : {}),
  });
  const result = await rt.sessions.createManyAtomic([], {
    remoteApplied: true,
    ...(existing ? { workspaceHandle: existing.id } : {}),
    ...revisionOption(args.expectedRevision),
    ...(!existing ? { workspaceContext: workspaceContextFor(ctx, solution, args.label) } : {}),
    prepare: (draft) => {
      if (serviceState(draft, false) && !args.replace) {
        throw new Error(SERVICE_GRAPH_EXISTS);
      }
      if (draft.configurations.size > 0 || draft.serverState[SOFTWARE_STATE]) throw new Error('Independent services require a separate service-only workspace.');
      draft.serverState[SERVICE_STATE] = state;
    },
  });
  return result.workspace;
}

function findServiceSelection<T extends { code: string }>(selections: readonly T[], serviceCode: string | undefined): T {
  const selected = serviceCode
    ? selections.find((candidate) => candidate.code === serviceCode)
    : selections.length === 1 ? selections[0] : undefined;
  if (!selected) throw new Error(
    selections.length > 1 && !serviceCode
      ? SERVICE_SELECTION_REQUIRED
      : `Selected product service was not found${serviceCode ? `: ${serviceCode}` : '.'}`,
  );
  return selected;
}

async function selectAndSummarise(
  rt: Runtime,
  workspace: WorkspaceSession,
  serviceCode: string,
  quantity: number,
  expectedRevision?: number,
): Promise<void> {
  const ctx = workspaceCtx(rt, workspace);
  await rt.sessions.transact(
    workspace.id,
    {
      keepEmptyWorkspace: true,
      remoteApplied: true,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    },
    async (draft) => {
      const current = serviceState(draft);
      const existing = current.selections.find((selection) => selection.code === serviceCode);
      const selected = existing?.quantity === quantity
        ? current
        : await selectProductService(rt.http, ctx, current, { serviceCode, quantity });
      const acceptedQuantity = selected.selections.find(
        (selection) => selection.code === serviceCode,
      )?.quantity ?? 0;
      if (acceptedQuantity !== quantity) {
        throw new Error(
          `DCSC rejected the requested per-product service quantity for ${serviceCode}: ` +
          `requestedQuantity=${quantity}, acceptedQuantity=${acceptedQuantity}. ` +
          'No workspace change was saved. Use dcsc_services_set_product_quantity to change the covered-product count, or dcsc_services_remove to remove this service.',
        );
      }
      draft.serverState[SERVICE_STATE] = await summariseProductServices(
        rt.http,
        ctx,
        selected,
      );
    },
  );
}

export async function selectService(rt: Runtime, args: {
  session: string;
  serviceCode: string;
  quantity: number;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  const workspace = requireWorkspace(rt, args.session);
  await selectAndSummarise(rt, workspace, args.serviceCode, args.quantity, args.expectedRevision);
  return requireWorkspace(rt, workspace.id);
}

export async function setServiceQuantity(rt: Runtime, args: {
  session: string;
  serviceCode?: string | undefined;
  quantity: number;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  const workspace = requireWorkspace(rt, args.session);
  const selection = findServiceSelection(serviceState(workspace).selections, args.serviceCode);
  await selectAndSummarise(rt, workspace, selection.code, args.quantity, args.expectedRevision);
  return requireWorkspace(rt, workspace.id);
}

export async function setServiceProductQuantity(rt: Runtime, args: {
  session: string;
  quantity: number;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  const workspace = requireWorkspace(rt, args.session);
  const ctx = workspaceCtx(rt, workspace);
  await rt.sessions.transact(
    workspace.id,
    {
      keepEmptyWorkspace: true,
      remoteApplied: true,
      ...revisionOption(args.expectedRevision),
    },
    async (draft) => {
      const current = serviceState(draft);
      let next: ProductServiceState = {
        ...current,
        product: { ...current.product, quantity: args.quantity },
        summaryRaw: undefined,
      };
      if (next.selections.length > 0) {
        next = await summariseProductServices(rt.http, ctx, next);
      }
      draft.serverState[SERVICE_STATE] = next;
    },
  );
  return requireWorkspace(rt, workspace.id);
}

export async function removeService(rt: Runtime, args: {
  session: string;
  serviceCode?: string | undefined;
  expectedRevision?: number | undefined;
}): Promise<WorkspaceSession> {
  const workspace = requireWorkspace(rt, args.session);
  const ctx = workspaceCtx(rt, workspace);
  await rt.sessions.transact(
    workspace.id,
    {
      keepEmptyWorkspace: true,
      remoteApplied: true,
      ...revisionOption(args.expectedRevision),
    },
    async (draft) => {
      const current = serviceState(draft);
      if (current.selections.length === 0) throw new Error('This workspace has no selected product services.');
      const selected = findServiceSelection(current.selections, args.serviceCode);
      let next = await removeProductService(rt.http, ctx, current, selected.code);
      if (next.selections.length > 0) next = await summariseProductServices(rt.http, ctx, next);
      draft.serverState[SERVICE_STATE] = next;
    },
  );
  return requireWorkspace(rt, workspace.id);
}

export async function exportStandaloneSoftwareArtifact(
  rt: Runtime,
  workspace: WorkspaceSession,
  fileName: string,
  options: {
    fileTypes?: ExportFileType[] | undefined;
    image?: string | undefined;
  } = {},
): Promise<ExportBundle & { contentDisposition: string | undefined }> {
  assertTrustedWorkspace(rt, workspace.id);
  const modes = new Set([...workspace.configurations.values()].map((session) => hardwareEndpointFamily(session.mode)));
  if (modes.size > 1) throw new Error('Mixed CTO and LFO hardware requires separate workspaces.');
  if (workspace.serverState[SERVICE_STATE]) throw new Error('Independent services require a separate service-only export.');
  const fileTypes = options.fileTypes ?? (workspace.configurations.size > 0 ? DEFAULT_EXPORT_TYPES : SOFTWARE_EXPORT_TYPES);
  if (workspace.configurations.size === 0 && fileTypes.some((type) => !SOFTWARE_EXPORT_TYPES.includes(type))) {
    throw new Error(`Standalone-only workspaces support these reports: ${SOFTWARE_EXPORT_TYPES.join(', ')}. Rack and connection reports require hardware.`);
  }
  const software = softwareState(workspace, false);
  const hardware = hardwareState(workspace, false);
  const softwareSelected = (software?.selections.length ?? 0) > 0;
  const hardwareSelected = (hardware?.selections.length ?? 0) > 0;
  if (!softwareSelected && !hardwareSelected) throw new Error('Select at least one standalone software or hardware item first.');
  const base = softwareExportBase(workspace, software, fileTypes);
  const softwareEnvelope = software && softwareSelected
    ? buildStandaloneSoftwareExportEnvelope(software, base)
    : undefined;
  const hardwareRows = hardware?.selections.map(standaloneHardwareExportItem) ?? [];
  const hardwareProducts = hardware?.selections.map((selection) => standaloneHardwareGroupProduct(selection)) ?? [];
  const data = {
    ...(softwareEnvelope?.data ?? base),
    standaloneData: [...(softwareEnvelope?.data.standaloneData ?? []), ...hardwareRows],
  };
  const standaloneGroups = [{
    name: 'Config 1', parent: null, index: -1,
    products: [...(softwareEnvelope?.groups[0]?.products ?? []), ...hardwareProducts],
  }];
  const form = buildExportForm({
    data,
    groups: mergeExportGroups(buildGroups(workspace), standaloneGroups),
  });
  if (options.image !== undefined) form['image'] = options.image;
  else if (workspace.rackArea.length > 0 && fileTypes.includes('RACK_REPORT')) {
    form['image'] = renderRackImage(workspace);
  }
  const ctx = workspaceCtx(rt, workspace);
  const response = await rt.http.send({
    endpoint: 'standalone_software_export_zip',
    method: 'POST',
    path: exportZipPath(workspace.configurations.size > 0
      ? hardwareEndpointFamily([...workspace.configurations.values()][0]!.mode)
      : 'lfos'),
    query: { fileName },
    requiresSolution: false,
    body: { kind: 'form', fields: form },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });
  return {
    ...(await writeExportBundle(response.stream, fileName, rt.config)),
    contentDisposition: response.contentDisposition,
  };
}

export async function exportProductServiceArtifact(
  rt: Runtime,
  workspace: WorkspaceSession,
  fileName: string,
): Promise<ExportBundle & { contentDisposition: string | undefined }> {
  assertTrustedWorkspace(rt, workspace.id);
  const envelope = buildProductServiceExportEnvelope(serviceState(workspace));
  const ctx = workspaceCtx(rt, workspace);
  const response = await rt.http.send({
    endpoint: 'standalone_services_export',
    method: 'POST',
    path: envelope.endpoint,
    query: { fileName },
    requiresSolution: false,
    body: { kind: 'form', fields: envelope.fields },
    responseKind: 'stream',
    timeoutClass: 'export',
    ctx,
  });
  return {
    ...(await writeExportBundle(response.stream, fileName, rt.config)),
    contentDisposition: response.contentDisposition,
  };
}

function softwareExportBase(
  workspace: WorkspaceSession,
  state: StandaloneSoftwareState | undefined,
  fileTypes: ExportFileType[],
): Record<string, unknown> {
  const retained = structuredClone(workspace.serverState);
  delete retained[SOFTWARE_STATE];
  delete retained[SERVICE_STATE];
  delete retained[HARDWARE_STATE];
  // Rebuilt from the typed baskets so imported rows are never sent twice.
  delete retained['standaloneData'];
  const launch = state && isObject(state.launchRaw) ? structuredClone(state.launchRaw) : {};
  delete launch['standaloneData'];
  const canonical = buildExportData({
    workspace,
    solution: workspace.solution,
    fileTypes,
    validationMode: workspace.validationMode,
  });
  // Import responses are not export DTOs (e.g. summary/configuration/type).
  // Preserve their provenance in state; send only the captured export fields.
  const source = { ...launch, ...retained };
  const exportFields = Object.fromEntries(Object.keys(canonical)
    .filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return mergeCanonical(exportFields, canonical);
}

function mergeCanonical(
  retained: Record<string, unknown>,
  canonical: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(retained);
  for (const [key, canonicalValue] of Object.entries(canonical)) {
    const retainedValue = merged[key];
    merged[key] =
      isObject(retainedValue) && isObject(canonicalValue)
        ? mergeCanonical(retainedValue, canonicalValue)
        : structuredClone(canonicalValue);
  }
  return merged;
}

function mergeExportGroups(
  canonical: Array<Record<string, unknown>>,
  standalone: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = structuredClone(canonical);
  for (const group of standalone) {
    const existing = merged.find((candidate) => candidate['name'] === group['name']);
    if (!existing) {
      merged.push(structuredClone(group));
      continue;
    }
    const canonicalProducts = Array.isArray(existing['products']) ? existing['products'] : [];
    const standaloneProducts = Array.isArray(group['products']) ? group['products'] : [];
    existing['products'] = [...canonicalProducts, ...structuredClone(standaloneProducts)];
  }
  return merged;
}
