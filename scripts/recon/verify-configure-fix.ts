/**
 * Verifies that dcsc_configure actually writes through to DCSC.
 *
 * The regression this guards: a change aimed at a section that carries no
 * selections yet (front drive bays on a fresh node, PDUs on a fresh rack) was
 * accepted by autoDerive and silently dropped, because the reduced model had no
 * such section and the synthesized replacement carried neither DCSC's internal
 * section name nor its sub-tab.
 *
 * Run: npx tsx scripts/recon/verify-configure-fix.ts
 */
import { loadConfig } from '../../src/config/load.js';
import { DcscHttpClient } from '../../src/http/request.js';
import { configureLogger } from '../../src/http/trace.js';
import { DcscService } from '../../src/mcp/service.js';
import { resolveSection } from '../../src/model/index.js';

type Case = { product: string; section: string; code: string; qty: number; label: string };

const CASES: Case[] = [
  // Empty section on a server: front NVMe bays. Was a silent no-op.
  { product: '7DJ5CTO1WW', section: 'Front HDD not in RAID Array', code: 'C1F1', qty: 4, label: 'front NVMe (title)' },
  // Same section reached by synthetic id, to prove all identifier forms resolve.
  { product: '7DJ5CTO1WW', section: 'storage.front-nonraid-hdd', code: 'C4HM', qty: 2, label: 'front NVMe (id)' },
  // Empty section on a rack: PDUs. The configure_pdu path depends on this.
  { product: '7D6DCTO1WW', section: 'Power Distribution Unit', code: 'C0D6', qty: 2, label: 'rack PDU (title)' },
];

async function main() {
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');

  let failures = 0;

  for (const c of CASES) {
    const session = await service.launch({ productCode: c.product, mode: 'cto', solution, ctx });
    const ref = resolveSection(session.index, c.section);
    const before = session.index.selected.get(c.code) ?? 0;
    const priceBefore = session.raw.totalPrice as number;

    if (!ref) {
      console.log(`FAIL ${c.label}: section "${c.section}" did not resolve`);
      failures++;
      continue;
    }

    const updated = await service.configure(
      session,
      [{ section: c.section, code: c.code, quantity: c.qty }],
      service.newCtx({ locale: session.locale, solution }),
    );
    const after = updated.index.selected.get(c.code) ?? 0;
    const priceAfter = updated.raw.totalPrice as number;
    const ok = after === c.qty;
    if (!ok) failures++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${c.label}: resolved -> name="${ref.name}" subTab="${ref.subTab}" | ` +
        `${c.code} qty ${before} -> ${after} (asked ${c.qty}) | ` +
        `price ${priceBefore} -> ${priceAfter} (delta ${(priceAfter - priceBefore).toFixed(2)})`,
    );
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
