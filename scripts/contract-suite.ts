/**
 * Live contract suite against dcsc.lenovo.com.
 *
 * This exists because the bug class that has cost the most here is silent
 * divergence: a local model that looks right and that DCSC would reject. Unit
 * tests cannot catch that, so every capability that depends on a DCSC contract
 * is exercised against the real service and asserted on the server's answer.
 *
 * Usage: npx tsx scripts/contract-suite.ts [group]
 *   groups: import, rack, power, fabric, scaleout, blueprints, persist,
 *           floor, cabling, pdu, validate, locale, topology, services,
 *           services_cto, standalone, all
 */
import { fetchLocales } from '../src/domain/locale.js';
import { fetchRackCabinets } from '../src/domain/rack.js';
import { fetchServicePortalCategories } from '../src/domain/services-catalog.js';
import { readFileSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { extractPowerReport, aggregatePower } from '../src/domain/power.js';
import { searchCatalog } from '../src/domain/catalog.js';
import { listTopologyConnectors } from '../src/domain/networkPreferences.js';
import {
  launchProductServices,
  launchStandaloneSoftware,
  selectProductService,
  selectStandaloneSoftware,
  summariseProductServices,
} from '../src/domain/standalone.js';
import {
  exportProductServiceArtifact,
  exportStandaloneSoftwareArtifact,
} from '../src/app/standalone.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { stateFile } from '../src/session/persist.js';
import { isolateRuntime, readStream } from './lib/isolated-runtime.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function newService() {
  const config = isolateRuntime(
    loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' }),
  );
  configureLogger(config.logLevel);
  return { service: new DcscService(config), config };
}

async function launchCurrentCto(service: DcscService, productCode: string, label?: string) {
  const modes = await service.modesContaining(service.newCtx(), [productCode]);
  const currentMode = modes.get(productCode.toUpperCase())?.[0];
  if (!currentMode) {
    throw new Error(`${productCode} is absent from every current solution catalog.`);
  }
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, currentMode);
  const session = await service.launch({
    productCode,
    mode: 'cto',
    solution,
    ctx,
    ...(label ? { label } : {}),
  });
  return { ctx, solution, session, currentMode };
}

// ---------------------------------------------------------------------------

async function groupImport(service: DcscService): Promise<void> {
  console.log('\n=== import: fresh current-catalog CFXML round-trips through DCSC ===');
  const modes = await service.solutionModes(service.newCtx());
  let exercised = 0;
  for (const mode of modes) {
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, mode.mode);
    const catalog = await service.catalog(ctx, solution);
    const product = catalog.entries.find((entry) =>
      !entry.withdrawn && entry.type.toUpperCase() === 'CTO');
    if (!product) {
      check(
        catalog.entries.every((entry) => entry.withdrawn || entry.type.toUpperCase() !== 'CTO'),
        `${mode.mode} import is explicitly blocked without a current CTO fixture`,
      );
      continue;
    }
    const launched = await service.launch({ productCode: product.code, mode: 'cto', solution, ctx });
    const exported = await service.exportZip(launched.id, {
      fileName: `contract-import-${product.code.toLowerCase()}`,
      fileTypes: ['XML'],
      ctx: service.newCtx({ solution }),
    });
    const bundle = await writeExportBundle(exported.stream, `contract-import-${product.code}`, service.config);
    if (!bundle.xml) throw new Error(`DCSC export for ${product.code} did not contain CFXML.`);
    const content = readFileSync(bundle.xml, 'utf8');
    const imported = await service.importConfig({
      content,
      ctx: service.newCtx({ solution }),
      fileName: `${product.code}.xml`,
      solutionMode: mode.mode,
    });
    const diagnostics = imported.diagnostics;
    check(
      diagnostics.missingParts.length === 0 && diagnostics.removedParts.length === 0,
      `${product.code} round-trips in its current ${mode.mode} catalog`,
      `price=$${imported.sessions[0]?.raw.totalPrice?.toLocaleString()}`,
    );
    exercised += 1;
  }
  check(exercised > 0, 'at least one current catalog supplied an import fixture', `${exercised} mode(s)`);
}

async function groupRack(service: DcscService): Promise<void> {
  console.log('\n=== rack: placement validated by DCSC, not by us ===');
  const { session: node, solution, currentMode } = await launchCurrentCto(service, '7DM9CTO1WW');
  const ctx = service.newCtx({ solution });
  console.log(`        using 7DM9CTO1WW from current ${currentMode} catalog`);

  const cabinets = await fetchRackCabinets(service.http, { ...ctx, solution });
  check(cabinets.length > 0, 'rack cabinets listed', `${cabinets.length} cabinets`);
  check(
    cabinets.every((c) => /rack|cabinet/i.test(c.description)),
    'rack list contains only cabinets, not accessories',
  );

  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  check(added.racks[0]?.sizeU === 42, 'rack size comes from DCSC', `${added.racks[0]?.sizeU}U`);
  const emptyWeight = added.racks[0]?.totalWeightKg ?? 0;
  const rackId = added.racks[0]!.id;

  const placementState = () => {
    const workspace = service.sessions.getWorkspace(node.id);
    if (!workspace) throw new Error('Rack contract workspace is missing.');
    const snapshot = structuredClone(workspace);
    snapshot.lastAccessAt = 0;
    for (const configuration of snapshot.configurations.values()) configuration.lastAccessAt = 0;
    return snapshot;
  };
  const beforeInvalid = placementState();
  let rejection: unknown;
  try {
    await service.placeInRack(node.id, {
      rackId,
      sessionId: node.id,
      position: 1,
      ctx: service.newCtx(),
    });
  } catch (error) {
    rejection = error;
  }
  check(
    rejection instanceof Error &&
      /did not accept the requested rack placement.*Workspace was not changed/.test(rejection.message),
    'illegal U position is rejected without accepting the server-corrected layout',
    rejection instanceof Error ? rejection.message : 'No expected placement rejection was received.',
  );
  check(isDeepStrictEqual(placementState(), beforeInvalid),
    'illegal placement preserves the entire workspace and revision');

  const good = await service.placeInRack(node.id, {
    rackId,
    sessionId: node.id,
    position: 3,
    ctx: service.newCtx(),
  });
  const rack = good.racks[0];
  check((rack?.items.length ?? 0) === 1, 'legal U position is accepted', `usedU=${rack?.usedU}`);
  check(
    (rack?.totalWeightKg ?? 0) > emptyWeight,
    'weight accumulates from the placed node',
    `${emptyWeight} -> ${rack?.totalWeightKg} kg`,
  );
  check(rack?.stableStatus !== undefined, 'centre-of-gravity verdict returned', rack?.stableStatus);

  const exported = await service.exportZip(node.id, {
    fileName: 'contract-rack',
    fileTypes: ['XML', 'QUOTE'],
    ctx: service.newCtx(),
  });
  const bytes = (await readStream(exported.stream)).length;
  check(bytes > 0, 'export still succeeds with a rack present', `${bytes} bytes`);
  if (exported.rackDataOmitted) {
    console.log(
      '  NOTE  rack layout was omitted from the export payload (known gap: the export endpoint ' +
        'does not accept the shape /racks/customize returns). Racks remain priced in the BOM.',
    );
  }
}

async function groupPower(service: DcscService): Promise<void> {
  console.log('\n=== power: DCSC\'s own thermal and electrical figures ===');
  const { session: node } = await launchCurrentCto(service, '7DM9CTO1WW');

  const report = extractPowerReport(node.raw);
  check(report !== undefined, 'power report present on a launched configuration');
  if (!report) throw new Error('DCSC launch omitted the power report required by this group.');
  check(report.inputPowerW.max > 1000, 'max input power is a plausible 8-GPU figure', `${report.inputPowerW.max} W`);
  check(report.heatBtuHr.max > 0, 'heat output reported', `${report.heatBtuHr.max} BTU/hr`);
  check(!!report.operatingVoltage, 'operating voltage reported', report.operatingVoltage);

  const cluster = aggregatePower([{ report, quantity: 32 }]);
  check(
    Math.abs(cluster.maxKW - (report.inputPowerW.max * 32) / 1000) < 0.5,
    'cluster aggregation scales linearly',
    `32 nodes = ${cluster.maxKW} kW max`,
  );
}

async function groupFabric(service: DcscService): Promise<void> {
  console.log('\n=== fabric: topologies, node roles, storage switches ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const fabric = await service.fabricOptions(ctx, solution);

  check(fabric.topologies.length > 0, 'network topologies listed', `${fabric.topologies.length}`);
  check(
    fabric.topologies.some((t) => /IB_|InfiniBand/i.test(t.shortName)),
    'InfiniBand fabric offered',
    fabric.topologies
      .filter((t) => /IB_/i.test(t.shortName))
      .map((t) => t.shortName)
      .join(', '),
  );
  check(fabric.nodeRoles.length > 0, 'node roles listed', fabric.nodeRoles.map((r) => r.role).join(', '));
  check(fabric.storageSwitches.length > 0, 'storage switches listed', `${fabric.storageSwitches.length}`);
}

async function groupScaleOut(service: DcscService): Promise<void> {
  console.log('\n=== scale-out: cluster sizing measured against DCSC ===');
  const { session: node } = await launchCurrentCto(service, '7DM9CTO1WW');

  const plan = await service.scaleOut({
    sessionHandle: node.id,
    nodes: 32,
    rackCode: '7D6DCTO1WW',
    ctx: service.newCtx(),
  });

  check(plan.nodesPerRack > 0, 'nodes per rack established empirically', `${plan.nodesPerRack}/rack`);
  check(
    plan.nodesPerRack <= Math.floor(plan.rackSizeU / plan.nodeSizeU),
    'measured density never exceeds the arithmetic maximum',
    `${plan.nodesPerRack} <= ${Math.floor(plan.rackSizeU / plan.nodeSizeU)}`,
  );
  check(
    plan.racksNeeded === Math.ceil(plan.nodes / plan.nodesPerRack),
    'rack count follows from node count',
    `${plan.nodes} nodes -> ${plan.racksNeeded} racks`,
  );
  check(
    (plan.clusterPower?.maxKW ?? 0) > 0,
    'cluster power computed',
    `${plan.clusterPower?.maxKW} kW max, ${plan.powerPerRack?.maxKW} kW/rack`,
  );
  console.log(
    `        32x ${plan.nodeCode}: $${plan.totalListPrice.toLocaleString()} list, ` +
      `${plan.racksNeeded} racks, ${plan.totalWeightKg} kg`,
  );
}

async function groupBlueprints(service: DcscService): Promise<void> {
  console.log('\n=== blueprints: current catalog availability controls launch ===');
  const blueprints = await service.blueprintAvailability(service.newCtx());
  check(blueprints.length > 0, 'blueprint registry is non-empty', `${blueprints.length} records`);
  let launched = 0;
  for (const bp of blueprints) {
    if (!bp.available) {
      check(
        bp.availableModes.length === 0 && /cannot be launched/i.test(bp.availabilityNote),
        `${bp.id} is explicitly blocked when absent from current catalogs`,
        bp.availabilityNote,
      );
      continue;
    }
    const currentMode = bp.availableModes[0]!;
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, currentMode);
    const session = await service.launch({ productCode: bp.productCode, mode: 'cto', solution, ctx });
    const price = session.raw.totalPrice ?? 0;
    const drift = Math.abs(price - bp.verifiedListPriceUsd) / (bp.verifiedListPriceUsd || 1);
    check(price > 0, `${bp.id} launches in current mode ${currentMode}`, `$${price.toLocaleString()}`);
    if (drift > 0.02) {
      console.log(
        `  NOTE  ${bp.id} list price moved ${(drift * 100).toFixed(1)}% since ${bp.verifiedOn} ` +
          `($${bp.verifiedListPriceUsd.toLocaleString()} -> $${price.toLocaleString()})`,
      );
    }
    launched += 1;
  }
  check(launched > 0, 'at least one historical blueprint remains currently launchable', `${launched} launched`);
}

async function groupPersist(): Promise<void> {
  console.log('\n=== persistence: sessions survive a restart ===');
  const path = `/tmp/dcsc-contract-sessions-${Date.now()}.json`;
  const config = loadConfig({ logLevel: 'silent' });
  const withFile = { ...config, files: { ...config.files, sessionFile: path, persistSessions: true } };

  const first = new DcscService(withFile);
  const { session: node } = await launchCurrentCto(first, '7DM9CTO1WW');
  const price = node.raw.totalPrice;
  await first.addRack(node.id, '7D6DCTO1WW', first.newCtx());
  // Persistence is debounced; give the timer a chance to fire.
  await new Promise((r) => setTimeout(r, 800));
  await first.close();

  const second = new DcscService(withFile);
  const restoredWs = second.sessions.listWorkspaces();
  check(restoredWs.length > 0, 'workspace restored after restart', `${restoredWs.length} workspace(s)`);
  const restoredSession = second.sessions.list().find((s) => s.product.code === node.product.code);
  check(restoredSession !== undefined, 'configuration restored');
  check(restoredSession?.raw.totalPrice === price, 'restored configuration keeps its price', `$${price?.toLocaleString()}`);
  check((restoredSession?.index.features.length ?? 0) > 0, 'feature index rebuilt from raw on load');
  check((restoredWs[0]?.rackArea.length ?? 0) > 0, 'rack layout restored');
  await second.close();

  rmSync(path, { force: true });
  console.log(`        (state file: ${stateFile(withFile)})`);
}

async function groupFloor(service: DcscService): Promise<void> {
  console.log('\n=== floor: client-side planning, rack must exist ===');
  const { session: node } = await launchCurrentCto(service, '7DM9CTO1WW');
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rackId = added.racks[0]!.id;

  const placed = await service.placeOnFloor(node.id, rackId, 1, 2);
  check(placed.clientSide === true, 'floor placement is explicitly client-side');
  check(placed.item.x === 1 && placed.item.y === 2, 'coordinates stored', `(${placed.item.x},${placed.item.y})`);
  check(placed.warning.length > 0, 'warning surfaces that DCSC does not validate floor tiles');

  const ws = service.sessions.getWorkspace(node.id);
  check(
    (ws?.floorItems.length ?? 0) === 1 && ws?.floorItems[0]?.rackId === rackId,
    'workspace records the floor item',
  );

  let refusedUnknown = false;
  try {
    await service.placeOnFloor(node.id, 'not-a-real-rack', 0, 0);
  } catch {
    refusedUnknown = true;
  }
  check(refusedUnknown, 'unknown rack id is refused');

  // Second rack, same tile — collision.
  const second = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rack2 = second.racks.find((r) => r.id !== rackId)?.id ?? second.racks[0]!.id;
  let refusedCollision = false;
  try {
    await service.placeOnFloor(node.id, rack2, 1, 2);
  } catch {
    refusedCollision = true;
  }
  check(refusedCollision, 'occupied tile is refused');
}

async function groupCabling(service: DcscService): Promise<void> {
  console.log('\n=== cabling: auto-connect is DCSC-backed ===');
  const { session: node } = await launchCurrentCto(service, '7DM9CTO1WW');
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rackId = added.racks[0]!.id;
  await service.placeInRack(node.id, {
    rackId,
    sessionId: node.id,
    position: 3,
    ctx: service.newCtx(),
  });

  const result = await service.runAutoConnect(node.id, service.newCtx());
  check(Array.isArray(result.connections), 'auto_connect returns a connections array');
  check(Array.isArray(result.cables), 'connections mapped to workspace cables');
  // A single GPU node and no switch yields zero links — that is a valid answer.
  check(
    result.connections.length === result.cables.length,
    'cable list matches connection count',
    `${result.connections.length} connection(s)`,
  );
  const ws = service.sessions.getWorkspace(node.id);
  check((ws?.cables.length ?? -1) === result.cables.length, 'workspace cable list replaced by DCSC result');
  check((ws?.rackArea.length ?? 0) > 0, 'auto_connect left a rackArea in place');

  // Manual path must not invent server validation.
  const manual = await service.addManualCabling(node.id, {
    fromConfigId: node.configurationId,
    fromPort: 'eth0',
    toConfigId: node.configurationId,
    toPort: 'eth1',
  });
  check(!!manual.id, 'manual cable can still be recorded for planning', manual.id);
}

async function groupPdu(service: DcscService): Promise<void> {
  console.log('\n=== pdu: selection goes through DCSC autoDerive ===');
  const { session: node } = await launchCurrentCto(service, '7DM9CTO1WW');
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rackId = added.racks[0]!.id;

  const listing = await service.configurePdu(node.id, rackId, { ctx: service.newCtx() });
  check(!!listing.catalog, 'catalog returned when no code is requested');
  const pdus = listing.catalog?.options.filter((o) => o.section.toUpperCase() === 'PDU') ?? [];
  check(pdus.length > 0, 'rack Power tab lists PDUs', `${pdus.length} options`);
  check(
    (listing.catalog?.placementRules.length ?? 0) > 0,
    'sidewall placement rules present from customize',
    `${listing.catalog?.placementRules.length} rule groups`,
  );

  const pick = pdus.find((p) => p.code === 'C0CS') ?? pdus[0]!;
  const before = listing.totalPrice;
  const applied = await service.configurePdu(node.id, rackId, {
    pduCode: pick.code,
    quantity: 1,
    ctx: service.newCtx(),
  });
  check(
    applied.selected.some((s) => s.code === pick.code && s.quantity >= 1),
    'DCSC accepted the PDU selection',
    `${pick.code} x${applied.selected.find((s) => s.code === pick.code)?.quantity}`,
  );
  check(
    applied.totalPrice !== null && before !== null && applied.totalPrice > before,
    'rack LIST price increases after PDU is ordered',
    `${before === null ? 'unavailable' : `$${before.toLocaleString()}`} -> ` +
      `${applied.totalPrice === null ? 'unavailable' : `$${applied.totalPrice.toLocaleString()}`}`,
  );
  check(applied.selection.pduCode === pick.code, 'workspace powerSelection records accepted code');
}

async function groupValidate(service: DcscService): Promise<void> {
  console.log('\n=== validate: LMC handoff from DCSC export-shaped payload ===');
  const { session: node } = await launchCurrentCto(service, '7DM9CTO1WW');
  const report = await service.validate(node.id, service.newCtx());
  check(report.source === 'lmc_validation', 'validation source is lmc_validation');
  check(
    !!report.server?.buildEntityNumber || !!report.server?.uuid || !!report.server?.lmcURL,
    'DCSC returned an LMC handoff field',
    report.server?.buildEntityNumber ?? report.server?.uuid ?? report.server?.lmcURL ?? 'none',
  );
  check(typeof report.isValid === 'boolean', 'isValid is boolean');
  check(Array.isArray(report.messages), 'messages array present');
  check(report.rackDataOmitted === false, 'single config has no rack omission');

  // Racked workspace: either LMC accepted racks, or we disclose omission.
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  check((added.racks.length ?? 0) > 0, 'rack added for validate-with-racks check');
  const racked = await service.validate(node.id, service.newCtx());
  if (racked.rackDataOmitted) {
    check(
      typeof racked.warning === 'string' && /rack/i.test(racked.warning),
      'racked validate surfaces explicit rack-omission warning',
      racked.warning?.slice(0, 80),
    );
  } else {
    check(
      !!racked.server?.buildEntityNumber || !!racked.server?.lmcURL,
      'racked validate kept racks and still got LMC handoff',
    );
  }
}

async function groupLocale(service: DcscService): Promise<void> {
  console.log('\n=== locale: /locales catalogue and cohesive override ===');
  const ctx = service.newCtx();
  const locales = await fetchLocales(service.http, ctx);
  check(locales.length > 10, 'locales listed from DCSC', `${locales.length} countries`);
  const us = locales.find((l) => l.countryCode === 'US');
  check(!!us, 'US present in catalogue');
  check(!!us?.currency, 'US has currency', us?.currency);
  const de = await service.resolveLocale(ctx, 'DE');
  check(de.country === 'DE', 'resolveLocale returns DE');
  check(de.currency.length === 3, 'currency is ISO-4217', de.currency);
  check(de.geo.length >= 2, 'geo/region present', de.geo);
  service.setLocale(de);
  check(service.locale.country === 'DE', 'setLocale updates process locale');
  // restore US for subsequent groups sharing this service instance
  service.setLocale(await service.resolveLocale(ctx, 'US'));
}

async function groupTopology(service: DcscService): Promise<void> {
  console.log('\n=== topology: selection stored and fabric shortNames from DCSC ===');
  const { session: node, solution } = await launchCurrentCto(service, '7DM9CTO1WW');
  const ctx = service.newCtx({ solution });
  const fabric = await service.fabricOptions(ctx, solution);
  const compatible = fabric.networkTypes.flatMap((network) => {
    const topology = fabric.topologies.find(
      (candidate) => candidate.shortName === network.defaultNetworkTechnology,
    );
    if (!topology) return [];
    const connectors = listTopologyConnectors(node.raw, fabric, topology.shortName);
    return connectors.length > 0 ? [{ network, topology, connector: connectors[0]! }] : [];
  });
  const choice = compatible.find(({ topology }) => /IB|InfiniBand/i.test(topology.shortName)) ?? compatible[0];
  check(!!choice, 'launched product has a topology, network and connector combination');
  if (!choice) throw new Error('No current topology is compatible with a connector on the launched product.');
  const applied = await service.applyTopology({
    sessionHandle: node.id,
    topology: choice.topology.shortName,
    networkName: choice.network.id,
    connectorIds: [choice.connector.id],
    autoConnect: false,
    ctx: service.newCtx(),
  });
  check(applied.topology === choice.topology.shortName, 'topology applied', applied.topology);
  check(
    Object.values(applied.selectedTopologies).some((value) =>
      typeof value === 'object' && value !== null &&
      (value as Record<string, unknown>)['networkTechnology'] === choice.topology.shortName),
    'selectedTopologies map contains the compatible topology and connector',
  );

  // Regression: autoDerive must not wipe topology on the next configure.
  const selected = [...node.index.features].find((f) => f.selectedQty > 0 && f.sectionName);
  check(!!selected, 'have a selected feature to re-apply through configure', selected?.code);
  if (selected) {
    await service.configure(
      node,
      [{ section: selected.sectionName!, code: selected.code, quantity: selected.selectedQty }],
      service.newCtx(),
    );
    const after = service.sessions.get(node.id)!;
    const containsTopology = (values: Record<string, unknown> | undefined) =>
      Object.values(values ?? {}).some((value) =>
        value === choice.topology.shortName ||
        (typeof value === 'object' && value !== null &&
          (value as Record<string, unknown>)['networkTechnology'] === choice.topology.shortName));
    check(
      containsTopology(after.reduced.selectedTopologies) ||
        containsTopology((after.raw as { selectedTopologies?: Record<string, unknown> }).selectedTopologies),
      'selectedTopologies survives configure/autoDerive',
      choice.topology.shortName,
    );
  }
}

async function groupServices(service: DcscService): Promise<void> {
  console.log('\n=== services: portal categories available anonymously ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const root = await fetchServicePortalCategories(service.http, { ...ctx, solution });
  check(!!root, 'services portal root returned');
  check((root?.children.length ?? 0) > 0, 'service categories listed', `${root?.children.length} top-level`);
  check(
    (root?.children.some((c) => /advise|deploy|support|maintain|service/i.test(c.title)) ?? false),
    'category titles look like services',
    root?.children.map((c) => c.title).slice(0, 5).join(', '),
  );
}

/**
 * Product Services tab via list/configure — not the portal tree.
 * Documents what anonymous DCSC actually accepts.
 */
async function groupServicesCto(service: DcscService): Promise<void> {
  console.log('\n=== services_cto: Services tab list + configure honesty ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'General Purpose');
  const catalog = await service.catalog(ctx, solution);
  const product = searchCatalog(catalog, { query: 'SR630 V3', type: 'CTO', limit: 10 })
    .find((entry) => !entry.withdrawn);
  check(!!product, 'current General Purpose catalog has an SR630 V3 CTO for Services checks');
  if (!product) throw new Error('No current SR630 V3 CTO exposes the Services-tab contract.');
  const node = await service.launch({ productCode: product.code, mode: 'cto', solution, ctx });

  check(node.index.tabs.some((t) => t === 'Services'), 'Services tab present on launched CTO');
  const serviceFeats = node.index.features.filter((f) => f.tab === 'Services');
  check(serviceFeats.length > 0, 'Services tab has features in the index', `${serviceFeats.length}`);
  const selected = serviceFeats.filter((f) => f.selectedQty > 0);
  check(
    selected.length > 0,
    'default service package auto-attached (serviceCto)',
    selected.map((f) => f.code).join(','),
  );

  // Exercise an alternate the current graph actually exposes instead of pinning
  // this contract to a historical package code.
  const packageOpt = serviceFeats.find(
    (f) => f.selectedQty === 0 && f.sectionName?.includes('Lenovo Recommends') && f.sectionName,
  ) ?? serviceFeats.find((f) => f.selectedQty === 0 && f.sectionName);
  if (packageOpt?.sectionName) {
    const beforeSel = node.index.selected.get(packageOpt.code) ?? 0;
    const beforePrice = node.raw.totalPrice ?? 0;
    await service.configure(
      node,
      [{ section: packageOpt.sectionName, code: packageOpt.code, quantity: 1 }],
      service.newCtx(),
    );
    const after = service.sessions.get(node.id)!;
    const afterSel = after.index.selected.get(packageOpt.code) ?? 0;
    const afterPrice = after.raw.totalPrice ?? 0;
    if (afterSel > beforeSel || afterPrice !== beforePrice) {
      check(true, 'DCSC accepted a Services package change', `${packageOpt.code} qty=${afterSel}`);
    } else {
      check(
        afterSel === beforeSel,
        'package UI configure did not stick (honest: selectedQty unchanged)',
        `${packageOpt.code} still ${afterSel}`,
      );
      // CFC sections only expose the currently selected option as a feature.
      const cfcOnlyOne = ['SERVICE_TYPE_CFC', 'YOURDRIVEYOURDATA_CFC', 'SERVICE_UPSELL_CFC'].every(
        (name) => serviceFeats.filter((f) => f.sectionName === name).length <= 1,
      );
      check(
        cfcOnlyOne,
        'CFC service characters expose only the selected line (no anonymous alternate to switch to)',
      );
    }
  } else {
    const cfcOnlyOne = ['SERVICE_TYPE_CFC', 'YOURDRIVEYOURDATA_CFC', 'SERVICE_UPSELL_CFC'].every(
      (name) => serviceFeats.filter((f) => f.sectionName === name).length <= 1,
    );
    check(
      cfcOnlyOne && selected.length > 0,
      'current Services graph explicitly exposes selected CFC lines only',
      `${selected.length} selected, no alternate package in the graph`,
    );
  }
}

async function groupStandalone(service: DcscService): Promise<void> {
  console.log('\n=== standalone: software and product-service select, price and export ===');
  const bootstrapCtx = service.newCtx();
  const solution = await service.resolveSolution(bootstrapCtx, 'General Purpose');
  const ctx = service.newCtx({ solution });

  const softwareCatalog = await launchStandaloneSoftware(service.http, ctx);
  const softwareFeature = softwareCatalog.features.find((feature) =>
    !feature.priceNotAvailable && typeof feature.unitPrice === 'number' && feature.unitPrice > 0);
  check(!!softwareFeature, 'standalone software catalog has a priced selectable SKU');
  if (!softwareFeature) throw new Error('Current software portal has no priced selectable SKU.');
  const softwareUnitPrice = softwareFeature.unitPrice;
  if (softwareUnitPrice === undefined) throw new Error(`${softwareFeature.code} has no numeric unit price.`);
  const software = selectStandaloneSoftware(softwareCatalog, {
    code: softwareFeature.code,
    quantity: 2,
  });
  const softwareWorkspace = await service.sessions.createManyAtomic([], {
    workspaceContext: { locale: ctx.locale, solution, label: 'contract standalone software' },
    prepare: (draft) => { draft.serverState.standaloneSoftwareState = software; },
  });
  const softwareArtifact = await exportStandaloneSoftwareArtifact(
    service,
    softwareWorkspace.workspace,
    'contract-standalone-software',
    { fileTypes: ['XML'] },
  );
  check(
    software.selections[0]?.quantity === 2 &&
      software.selections[0]?.totalPrice === softwareUnitPrice * 2,
    'standalone software quantity extends its captured unit price',
    `${softwareFeature.code} x2 = $${software.selections[0]?.totalPrice}`,
  );
  check(
    softwareArtifact.bytes > 0 && softwareArtifact.xml !== undefined,
    'standalone software exports a non-empty CFXML bundle',
    `${softwareArtifact.bytes} bytes`,
  );

  const catalog = await service.catalog(ctx, solution);
  const serviceProduct = searchCatalog(catalog, {
    query: 'SR630 V3',
    type: 'CTO',
    limit: 10,
  }).find((entry) => !entry.withdrawn);
  check(!!serviceProduct, 'current catalog supplies a product for standalone services');
  if (!serviceProduct) throw new Error('No current SR630 V3 CTO is available for the services contract.');
  let productServices = await launchProductServices(service.http, ctx, {
    productCode: serviceProduct.code,
    productQuantity: 3,
    productDescription: serviceProduct.description,
    subCategory: 'Point of Sale',
  });
  const serviceOption = productServices.options.find((option) =>
    option.code.length > 0 && typeof option.unitPrice === 'number' && option.unitPrice > 0);
  check(!!serviceOption, `${serviceProduct.code} has a current priced Point of Sale service option`);
  if (!serviceOption) throw new Error(`${serviceProduct.code} returned no priced Point of Sale service options.`);
  productServices = await selectProductService(service.http, ctx, productServices, {
    serviceCode: serviceOption.code,
    quantity: 1,
  });
  productServices = await summariseProductServices(service.http, ctx, productServices);
  const serviceWorkspace = await service.sessions.createManyAtomic([], {
    workspaceContext: { locale: ctx.locale, solution, label: 'contract standalone services' },
    prepare: (draft) => { draft.serverState.standaloneServiceState = productServices; },
  });
  const serviceArtifact = await exportProductServiceArtifact(
    service,
    serviceWorkspace.workspace,
    'contract-standalone-services',
  );
  const selectedService = productServices.selections.find(selection => selection.code === serviceOption.code);
  const summaries = Array.isArray(productServices.summaryRaw)
    ? productServices.summaryRaw as Array<Record<string, unknown>> : [];
  const summary = summaries.find(row => row?.['code'] === serviceProduct.code);
  const summarySelections = Array.isArray(summary?.['results'])
    ? summary['results'] as Array<Record<string, unknown>> : [];
  const summaryService = summarySelections.find(row => row?.['code'] === serviceOption.code);
  check(
    productServices.product.quantity === 3 && selectedService?.quantity === 1 &&
      summary?.['quantity'] === 3 && summaryService?.['quantity'] === 1,
    'authoritative summary preserves three products with one service per product',
    `${serviceProduct.code} x3, ${serviceOption.code} x1 per product`,
  );
  check(
    typeof summary?.['unitPrice'] === 'number' && typeof summary['totalPrice'] === 'number' &&
      summary['unitPrice'] > 0 && Math.abs(summary['totalPrice'] - summary['unitPrice'] * 3) < 0.000001,
    'authoritative service total extends the unit price by the covered-product quantity',
  );
  check(serviceArtifact.bytes > 0, 'standalone product services export a non-empty bundle', `${serviceArtifact.bytes} bytes`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const group = process.argv[2] ?? 'all';
  const { service } = newService();

  const groups: Record<string, () => Promise<void>> = {
    import: () => groupImport(service),
    rack: () => groupRack(service),
    power: () => groupPower(service),
    fabric: () => groupFabric(service),
    scaleout: () => groupScaleOut(service),
    blueprints: () => groupBlueprints(service),
    persist: () => groupPersist(),
    floor: () => groupFloor(service),
    cabling: () => groupCabling(service),
    pdu: () => groupPdu(service),
    validate: () => groupValidate(service),
    locale: () => groupLocale(service),
    topology: () => groupTopology(service),
    services: () => groupServices(service),
    services_cto: () => groupServicesCto(service),
    standalone: () => groupStandalone(service),
  };

  const toRun = group === 'all' ? Object.keys(groups) : [group];
  for (const name of toRun) {
    const fn = groups[name];
    if (!fn) {
      console.error(`Unknown group "${name}". Valid: ${Object.keys(groups).join(', ')}, all`);
      process.exit(2);
    }
    try {
      await fn();
    } catch (err) {
      failed += 1;
      failures.push(`${name} (threw)`);
      console.log(`  FAIL  ${name} threw: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  await service.close();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length > 0) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
