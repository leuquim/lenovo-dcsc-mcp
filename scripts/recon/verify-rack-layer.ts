/**
 * Verifies the server-backed rack layer against live DCSC.
 *
 * Checks that placements are validated by DCSC (not invented locally), that
 * rejected placements surface, and that a populated rack finally makes
 * RACK_REPORT / RACK_DIAGRAM export real files.
 */
import { fetchRackCabinets } from '../../src/domain/rack.js';
import { loadConfig } from '../../src/config/load.js';
import { DcscHttpClient } from '../../src/http/request.js';
import { configureLogger } from '../../src/http/trace.js';
import { DcscService } from '../../src/mcp/service.js';
import { writeFileSync } from 'node:fs';
import yauzl from 'yauzl';

async function zipMembers(buf: Buffer, path: string): Promise<string[]> {
  writeFileSync(path, buf);
  return new Promise((resolve) => {
    const names: string[] = [];
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return resolve(names);
      zip.on('entry', (e) => {
        names.push(`${e.fileName} (${e.uncompressedSize} bytes)`);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

async function main() {
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const service = new DcscService(config, new DcscHttpClient(config));
  let failures = 0;
  const check = (ok: boolean, label: string, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');

  console.log('=== rack catalog ===');
  const racks = await fetchRackCabinets(service.http, { ...ctx, solution });
  check(racks.length > 0, `rack_get returns cabinets`, `${racks.length} found`);
  console.log('   e.g.', racks.slice(0, 3).map((r) => `${r.code} ${r.description}`).join(' | '));

  console.log('\n=== build a workspace ===');
  const s1 = await service.launch({ productCode: '7DM9CTO1WW', mode: 'cto', solution, ctx });
  console.log(`launched ${s1.id} (SR680a V3, $${s1.raw.totalPrice?.toLocaleString()})`);

  const added = await service.addRack(s1.id, '7D6DCTO1WW', service.newCtx());
  const rack = added.racks[0];
  check(!!rack && rack.sizeU === 42, 'rack added with DCSC-reported size', `sizeU=${rack?.sizeU}`);
  check(rack?.stableStatus === 'PASSED', 'empty rack is stable', `stableStatus=${rack?.stableStatus}`);
  const rackId = rack!.id;

  console.log('\n=== placement at a rule-violating position (U1) ===');
  const bad = await service.placeInRack(s1.id, { rackId, sessionId: s1.id, position: 1, ctx: service.newCtx() });
  check(
    bad.unplaced.length > 0 || bad.errors.length > 0,
    'DCSC rejects a placement that breaks its own rule',
    bad.errors.map((e) => e.message).join('; ').slice(0, 120),
  );

  console.log('\n=== placement at a legal position (U3) ===');
  const good = await service.placeInRack(s1.id, { rackId, sessionId: s1.id, position: 3, ctx: service.newCtx() });
  const r2 = good.racks[0];
  check((r2?.items.length ?? 0) > 0, 'server placed in rack', `items=${r2?.items.length} usedU=${r2?.usedU}`);
  check(
    (r2?.totalWeightKg ?? 0) > (rack?.totalWeightKg ?? 0),
    'rack weight grew by the server weight',
    `${rack?.totalWeightKg} -> ${r2?.totalWeightKg} kg`,
  );
  for (const it of r2?.items ?? []) console.log(`   U${it.position}-${it.endPosition}  ${it.code}`);

  console.log('\n=== export with rack reports ===');
  const exp = await service.exportZip(s1.id, {
    fileName: 'rack-verify',
    fileTypes: ['XML', 'QUOTE', 'RACK_REPORT', 'RACK_DIAGRAM', 'POWER_REPORT'],
    validationMode: 'guided',
    ctx: service.newCtx(),
  });
  const members = await zipMembers(Buffer.from(await exp.stream.arrayBuffer()), '/tmp/rack-verify.zip');
  console.log('   zip members:');
  for (const m of members) console.log('     ', m);
  check(members.length >= 2, 'export still succeeds with a rack in the workspace', `${members.length} members`);
  check(
    !exp.rackDataOmitted,
    'rack layout accepted by the export endpoint',
    exp.rackDataOmitted
      ? 'KNOWN GAP: export rejects the /racks/customize rack shape, so rack diagrams are not generated; ' +
        'the rack is still in the BOM and the layout is readable via dcsc_workspace_get'
      : '',
  );

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
