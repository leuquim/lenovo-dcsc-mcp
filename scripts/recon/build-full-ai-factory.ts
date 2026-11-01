/**
 * Builds the complete liquid-cooled B200 AI factory end to end.
 *
 * Exercises every path that used to fail silently: selections into empty
 * sections on both a server and a rack, PDU install through DCSC rather than
 * local bookkeeping, placement, and export.
 *
 * Run: npx tsx scripts/recon/build-full-ai-factory.ts
 */
import * as fs from 'node:fs';
import { loadConfig } from '../../src/config/load.js';
import { DcscHttpClient } from '../../src/http/request.js';
import { configureLogger } from '../../src/http/trace.js';
import { DcscService } from '../../src/mcp/service.js';
import { resolveSection } from '../../src/model/index.js';
import { defaultExportTypes } from '../../src/domain/reduce.js';
import { aggregatePower, extractPowerReport } from '../../src/domain/power.js';

const NODE = '7DJ5CTO1WW'; // ThinkSystem SR780a V3, HGX B200 liquid-cooled
const RACK = '7D6DCTO1WW'; // 42U Onyx heavy duty

type Change = { section: string; code: string; quantity: number; why: string };

const NODE_CHANGES: Change[] = [
  // 8 front bays of mixed-use NVMe: dataset staging and checkpoint scratch.
  { section: 'Front HDD not in RAID Array', code: 'C4HM', quantity: 8, why: '8x 6.4TB MU NVMe = 51.2TB scratch' },
  // Mirror the boot pair instead of leaving two independent M.2s.
  { section: 'M.2 RAID Controller', code: 'BS7M', quantity: 1, why: 'Intel VROC for M.2 RAID' },
  { section: 'M.2 NVMe RAID Array 1', code: 'BS7F', quantity: 1, why: 'RAID1 boot mirror' },
];

const RACK_CHANGES: Change[] = [
  { section: 'Power Distribution Unit', code: 'C0D6', quantity: 2, why: '2x 32A 3ph WYE PDU, A/B feeds' },
  { section: 'Line Cord', code: '6504', quantity: 2, why: '32A 380-415V 3ph wye line cords' },
];

async function applyAll(
  service: DcscService,
  session: Awaited<ReturnType<DcscService['launch']>>,
  changes: Change[],
  label: string,
) {
  let current = session;
  for (const c of changes) {
    const ref = resolveSection(current.index, c.section);
    if (!ref) {
      console.log(`  SKIP ${c.code}: section "${c.section}" not found on ${label}`);
      continue;
    }
    const before = current.raw.totalPrice as number;
    try {
      current = await service.configure(
        current,
        [{ section: c.section, code: c.code, quantity: c.quantity }],
        service.newCtx({ locale: current.locale, solution: current.solution }),
      );
    } catch (e) {
      console.log(`  FAIL ${c.code}: ${(e as Error).message.slice(0, 160)}`);
      continue;
    }
    const got = current.index.selected.get(c.code) ?? 0;
    const after = current.raw.totalPrice as number;
    const ok = got === c.quantity;
    console.log(
      `  ${ok ? 'OK  ' : 'MISS'} ${c.code} x${c.quantity} (${c.why}) -> qty ${got}, ` +
        `price ${before.toFixed(2)} -> ${after.toFixed(2)} (+${(after - before).toFixed(2)})`,
    );
  }
  return current;
}

async function main() {
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');

  console.log('1. Launching node', NODE);
  let node = await service.launch({
    productCode: NODE,
    mode: 'cto',
    solution,
    ctx,
    label: 'AI Factory - SR780a V3 B200 DWC',
  });
  const ws = node.workspaceId ?? node.id;
  console.log(`   workspace=${ws} session=${node.id} base=$${(node.raw.totalPrice as number).toFixed(2)}`);

  console.log('2. Configuring node storage');
  node = await applyAll(service, node, NODE_CHANGES, 'node');

  console.log('3. Tagging node role Compute');
  const fabric = await service.fabricOptions(ctx, solution);
  const compute = fabric.nodeRoles.find((r) => r.role === 'Compute');
  if (compute) node.reduced.nodeRole = compute.role;
  console.log(`   nodeRole=${node.reduced.nodeRole}`);

  console.log('4. Adding rack', RACK);
  const layout = await service.addRack(ws, RACK, ctx);
  const rackId = layout.racks[0]?.id ?? '';
  console.log(`   rackId=${rackId} ${layout.racks[0]?.sizeU}U`);

  const rackSession = service.sessions.findByConfigurationId(ws, rackId);
  if (!rackSession) throw new Error('rack session missing');

  console.log('5. Configuring rack PDUs');
  await applyAll(service, rackSession, RACK_CHANGES, 'rack');

  console.log('6. Placing node in rack');
  const placed = await service.placeInRack(ws, { rackId, sessionId: node.id, ctx });
  const r = placed.racks[0];
  console.log(
    `   usedU=${r?.usedU} freeU=${r?.freeU} weight=${r?.totalWeightKg}kg stability=${r?.stableStatus}`,
  );
  for (const item of r?.items ?? []) {
    console.log(`   - ${item.code} @ U${item.position}-U${item.endPosition} (${item.sizeU}U)`);
  }
  if (placed.errors?.length) console.log('   errors:', placed.errors);

  console.log('7. Power');
  const wsForPower = service.sessions.getWorkspace(ws);
  const reports = [...(wsForPower?.configurations.values() ?? [])]
    .map((s) => ({ report: extractPowerReport(s.raw), quantity: s.raw.quantity ?? 1 }))
    .filter((p): p is { report: NonNullable<typeof p.report>; quantity: number } => p.report !== undefined);
  const total = aggregatePower(reports);
  console.log(
    `   expected=${total.expectedKW}kW max=${total.maxKW}kW worst=${total.worstKW}kW ` +
      `@${reports[0]?.report.operatingVoltage}`,
  );

  console.log('8. Validate');
  const val = await service.validate(ws, ctx);
  console.log(
    `   valid=${val.isValid} errors=${val.errorCount} warnings=${val.warningCount} ` +
      `rackDataOmitted=${val.rackDataOmitted}`,
  );
  if (val.warning) console.log(`   warning: ${val.warning}`);
  for (const m of val.messages.slice(0, 5)) console.log('   msg:', m.severity, m.text?.slice(0, 120));

  console.log("9. Totals");
  const info = service.sessions.getWorkspace(ws);
  let grand = 0;
  for (const s of info?.configurations.values() ?? []) {
    const p = (s.raw.totalPrice as number) ?? 0;
    grand += p;
    console.log(`   ${s.reduced.sliceCtoCode}  $${p.toFixed(2)}`);
  }
  console.log(`   TOTAL $${grand.toFixed(2)} USD LIST`);

  console.log('10. Export');
  const out = await service.exportZip(ws, {
    fileTypes: defaultExportTypes(),
    fileName: 'ai-factory-b200-dwc-complete',
    ctx,
  });
  const dir = 'artifacts/full-factory';
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = `${dir}/ai-factory-b200-dwc-complete.zip`;
  await new Promise<void>((resolve, reject) => {
    const w = fs.createWriteStream(zipPath);
    out.stream.pipe(w);
    w.on('finish', () => resolve());
    w.on('error', reject);
  });
  console.log(`   zip=${zipPath} bytes=${fs.statSync(zipPath).size} rackDataOmitted=${out.rackDataOmitted}`);
  console.log(`\nworkspace=${ws}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
