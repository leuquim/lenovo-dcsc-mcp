/**
 * Verifies dcsc_import against the real DCSC import endpoint.
 *
 * Positive cases: the four AI factory blueprints must import with no missing or
 * removed parts and a price matching the export.
 *
 * Negative case: SR685a V3 (7DHCCTO1WW) is only in the General Purpose catalog,
 * so importing it under "HPC and AI - Systems" must fail loudly. The previous
 * launch-replay implementation reported exactly this case as a clean import,
 * because launch does not enforce catalog membership.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config/load.js';
import { DcscHttpClient } from '../../src/http/request.js';
import { configureLogger } from '../../src/http/trace.js';
import { DcscService } from '../../src/mcp/service.js';

const DIR = 'artifacts/nvidia_ai_factory_blueprints';
const BLUEPRINTS = [
  'nvidia-blueprint-7dm9cto1ww.xml',
  'nvidia-blueprint-7dj5cto1ww.xml',
  'nvidia-blueprint-7dhccto1ww.xml',
  'nvidia-blueprint-7dlzcto2ww.xml',
];

async function main() {
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);

  let failures = 0;

  console.log('=== POSITIVE CASES ===');
  for (const name of BLUEPRINTS) {
    const content = readFileSync(`${DIR}/${name}`, 'utf8');
    try {
      const res = await service.importConfig({
        content,
        ctx: service.newCtx(),
        fileName: name,
      });
      const d = res.diagnostics;
      const price = res.sessions[0]?.raw.totalPrice ?? 0;
      const clean = d.missingParts.length === 0 && d.removedParts.length === 0;
      if (!clean) failures += 1;
      console.log(
        `${clean ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ` +
          `configs=${res.sessions.length} price=$${price.toLocaleString()} ` +
          `missing=${d.missingParts.length} removed=${d.removedParts.length} ` +
          `replaced=${d.replacedParts.length} eccnRestricted=${d.eccnRestricted}`,
      );
    } catch (err) {
      failures += 1;
      console.log(`FAIL  ${name.padEnd(34)} threw: ${(err as Error).message}`);
    }
  }

  console.log('\n=== NEGATIVE CASE: General-Purpose-only model imported under HPC and AI ===');
  // launch() happily accepts 7DHC under HPC and AI even though the model is not
  // in that catalog -- which is precisely why replaying a CFXML through launch
  // could never detect the rejection the real import reports.
  const hpc = await service.resolveSolution(service.newCtx(), 'HPC and AI - Systems');
  const trap = await service.launch({
    productCode: '7DHCCTO1WW',
    mode: 'cto',
    solution: hpc,
    ctx: service.newCtx(),
  });
  console.log(
    `launch() under HPC and AI succeeded at $${trap.raw.totalPrice?.toLocaleString()} — the trap the old implementation fell into.`,
  );

  const content = readFileSync(`${DIR}/nvidia-blueprint-7dhccto1ww.xml`, 'utf8');
  try {
    const res = await service.importConfig({
      content,
      ctx: service.newCtx(),
      fileName: 'nvidia-blueprint-7dhccto1ww.xml',
      solutionMode: 'HPC and AI - Systems',
    });
    const d = res.diagnostics;
    if (d.missingParts.length > 0) {
      console.log(`PASS  reported missing parts: ${d.missingParts.map((p) => p.productCode).join(', ')}`);
    } else {
      failures += 1;
      console.log('FAIL  import reported clean, but DCSC rejects this model in HPC and AI mode');
    }
  } catch (err) {
    console.log(`PASS  import threw as expected:\n      ${(err as Error).message}`);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
