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
 *           floor, cabling, pdu, validate, locale, topology, services, all
 */
import { readFileSync, rmSync } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { extractPowerReport, aggregatePower } from '../src/domain/power.js';
import { BLUEPRINTS } from '../src/domain/blueprints.js';
import { stateFile } from '../src/session/persist.js';

const BLUEPRINT_DIR = 'artifacts/nvidia_ai_factory_blueprints';

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
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  return { service: new DcscService(config), config };
}

// ---------------------------------------------------------------------------

async function groupImport(service: DcscService): Promise<void> {
  console.log('\n=== import: CFXML round-trips through DCSC\'s own importer ===');
  for (const name of [
    'nvidia-blueprint-7dm9cto1ww.xml',
    'nvidia-blueprint-7dhccto1ww.xml',
  ]) {
    const content = readFileSync(`${BLUEPRINT_DIR}/${name}`, 'utf8');
    const res = await service.importConfig({ content, ctx: service.newCtx(), fileName: name });
    const d = res.diagnostics;
    check(
      d.missingParts.length === 0 && d.removedParts.length === 0,
      `${name} imports with no lost parts`,
      `price=$${res.sessions[0]?.raw.totalPrice?.toLocaleString()}`,
    );
  }

  // The regression that started all this: a General-Purpose-only model must be
  // rejected under HPC and AI rather than silently "succeeding".
  const gpOnly = readFileSync(`${BLUEPRINT_DIR}/nvidia-blueprint-7dhccto1ww.xml`, 'utf8');
  let threw = false;
  try {
    const res = await service.importConfig({
      content: gpOnly,
      ctx: service.newCtx(),
      solutionMode: 'HPC and AI - Systems',
    });
    threw = res.diagnostics.missingParts.length > 0;
  } catch {
    threw = true;
  }
  check(threw, 'General-Purpose-only model is rejected under HPC and AI');
}

async function groupRack(service: DcscService): Promise<void> {
  console.log('\n=== rack: placement validated by DCSC, not by us ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');

  const cabinets = await service.rackCabinets(ctx, solution);
  check(cabinets.length > 0, 'rack cabinets listed', `${cabinets.length} cabinets`);
  check(
    cabinets.every((c) => /rack|cabinet/i.test(c.description)),
    'rack list contains only cabinets, not accessories',
  );

  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  check(added.racks[0]?.sizeU === 42, 'rack size comes from DCSC', `${added.racks[0]?.sizeU}U`);
  const emptyWeight = added.racks[0]?.totalWeightKg ?? 0;
  const rackId = added.racks[0]!.id;

  const bad = await service.placeInRack(node.id, {
    rackId,
    sessionId: node.id,
    position: 1,
    ctx: service.newCtx(),
  });
  check(
    bad.errors.length > 0 || bad.unplaced.length > 0,
    'illegal U position is refused by DCSC',
    bad.errors[0]?.message.slice(0, 80) ?? '',
  );

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
    validationMode: 'guided',
    ctx: service.newCtx(),
  });
  const bytes = Buffer.from(await exported.stream.arrayBuffer()).length;
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
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });

  const report = extractPowerReport(node.raw);
  check(report !== undefined, 'power report present on a launched configuration');
  if (!report) return;
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
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });

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
  console.log('\n=== blueprints: every reference config still launches ===');
  for (const bp of BLUEPRINTS) {
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, bp.solutionMode);
    try {
      const s = await service.launch({
        productCode: bp.productCode,
        mode: 'cto',
        solution,
        ctx,
      });
      const price = s.raw.totalPrice ?? 0;
      const drift = Math.abs(price - bp.verifiedListPriceUsd) / (bp.verifiedListPriceUsd || 1);
      check(price > 0, `${bp.id} launches`, `$${price.toLocaleString()}`);
      if (drift > 0.02) {
        console.log(
          `  NOTE  ${bp.id} list price moved ${(drift * 100).toFixed(1)}% since ${bp.verifiedOn} ` +
            `($${bp.verifiedListPriceUsd.toLocaleString()} -> $${price.toLocaleString()})`,
        );
      }
    } catch (err) {
      check(false, `${bp.id} launches`, (err as Error).message.slice(0, 100));
    }
  }

  // A blueprint declaring the wrong mode is the exact trap this guards against.
  const modes = await service.modesContaining(
    service.newCtx(),
    BLUEPRINTS.map((b) => b.productCode),
  );
  for (const bp of BLUEPRINTS) {
    const available = modes.get(bp.productCode.toUpperCase()) ?? [];
    check(
      available.includes(bp.solutionMode),
      `${bp.id} declares a mode whose catalog contains it`,
      available.join(' | '),
    );
  }
}

async function groupPersist(): Promise<void> {
  console.log('\n=== persistence: sessions survive a restart ===');
  const path = `/tmp/dcsc-contract-sessions-${Date.now()}.json`;
  const config = loadConfig({ logLevel: 'silent' });
  const withFile = { ...config, files: { ...config.files, sessionFile: path, persistSessions: true } };

  const first = new DcscService(withFile);
  const ctx = first.newCtx();
  const solution = await first.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await first.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
  const price = node.raw.totalPrice;
  await first.addRack(node.id, '7D6DCTO1WW', first.newCtx());
  // Persistence is debounced; give the timer a chance to fire.
  await new Promise((r) => setTimeout(r, 800));
  await first.close();

  const second = new DcscService(withFile);
  const restoredWs = second.sessions.listWorkspaces();
  check(restoredWs.length > 0, 'workspace restored after restart', `${restoredWs.length} workspace(s)`);
  const restoredSession = second.sessions.list().find((s) => s.product.code === '7DM9CTO1WW');
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
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
  const added = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rackId = added.racks[0]!.id;

  const placed = service.placeOnFloor(node.id, rackId, 1, 2);
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
    service.placeOnFloor(node.id, 'not-a-real-rack', 0, 0);
  } catch {
    refusedUnknown = true;
  }
  check(refusedUnknown, 'unknown rack id is refused');

  // Second rack, same tile — collision.
  const second = await service.addRack(node.id, '7D6DCTO1WW', service.newCtx());
  const rack2 = second.racks.find((r) => r.id !== rackId)?.id ?? second.racks[0]!.id;
  let refusedCollision = false;
  try {
    service.placeOnFloor(node.id, rack2, 1, 2);
  } catch {
    refusedCollision = true;
  }
  check(refusedCollision, 'occupied tile is refused');
}

async function groupCabling(service: DcscService): Promise<void> {
  console.log('\n=== cabling: auto-connect is DCSC-backed ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
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
  const manual = service.addManualCabling(node.id, {
    fromConfigId: node.configurationId,
    fromPort: 'eth0',
    toConfigId: node.configurationId,
    toPort: 'eth1',
  });
  check(!!manual.id, 'manual cable can still be recorded for planning', manual.id);
}

async function groupPdu(service: DcscService): Promise<void> {
  console.log('\n=== pdu: selection goes through DCSC autoDerive ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
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
    applied.totalPrice > before,
    'rack LIST price increases after PDU is ordered',
    `$${before.toLocaleString()} -> $${applied.totalPrice.toLocaleString()}`,
  );
  check(applied.selection.pduCode === pick.code, 'workspace powerSelection records accepted code');
}

async function groupValidate(service: DcscService): Promise<void> {
  console.log('\n=== validate: LMC handoff from DCSC export-shaped payload ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
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
  const locales = await service.listLocales(ctx);
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
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const node = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
  const fabric = await service.fabricOptions(ctx, solution);
  const topo = fabric.topologies.find((t) => t.shortName.includes('IB')) ?? fabric.topologies[0]!;
  check(!!topo, 'a topology shortName is available', topo?.shortName);
  const applied = await service.applyTopology({
    sessionHandle: node.id,
    topology: topo.shortName,
    autoConnect: false,
    ctx: service.newCtx(),
  });
  check(applied.topology === topo.shortName, 'topology applied', applied.topology);
  check(
    Object.values(applied.selectedTopologies).includes(topo.shortName),
    'selectedTopologies map contains the choice',
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
    const still =
      Object.values(after.reduced.selectedTopologies ?? {}).includes(topo.shortName) ||
      Object.values((after.raw as { selectedTopologies?: Record<string, string> }).selectedTopologies ?? {}).includes(
        topo.shortName,
      );
    check(still, 'selectedTopologies survives configure/autoDerive', topo.shortName);
  }
}

async function groupServices(service: DcscService): Promise<void> {
  console.log('\n=== services: portal categories available anonymously ===');
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const root = await service.servicePortalCategories(ctx, solution);
  check(!!root, 'services portal root returned');
  check((root?.children.length ?? 0) > 0, 'service categories listed', `${root?.children.length} top-level`);
  check(
    (root?.children.some((c) => /advise|deploy|support|maintain|service/i.test(c.title)) ?? false),
    'category titles look like services',
    root?.children.map((c) => c.title).slice(0, 5).join(', '),
  );
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
