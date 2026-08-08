/**
 * Derives the /ctos/racks/* contract experimentally.
 *
 * The SPA builds its rack layout client-side and only posts it to
 * /ctos/racks/customize for validation, so the payload shape has to be
 * reconstructed rather than observed. /racks/customize/non_rack is the key:
 * it returns the canonical placement object for any product code, which is
 * the same shape rackArea entries use.
 */
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import * as fs from 'node:fs';

const OUT = 'artifacts/rack_probe';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const rctx = { ...ctx, solution };

  // 1. Physical envelope of a rack cabinet and of a server.
  for (const [label, body] of [
    ['rack 7D6DCTO1WW (42U Onyx)', [{ type: 'rack', asVLH: false, code: '7D6DCTO1WW' }]],
    ['rack 7DJVCTO2WW (48U MGX)', [{ type: 'rack', asVLH: false, code: '7DJVCTO2WW' }]],
    ['server 7DM9CTO1WW (SR680a V3)', [{ type: 'server', asVLH: false, code: '7DM9CTO1WW' }]],
    ['server 7DLZCTO2WW (GB300 tray)', [{ type: 'server', asVLH: false, code: '7DLZCTO2WW' }]],
  ] as Array<[string, unknown]>) {
    const res = await http.send({
      endpoint: 'racks_customize_non_rack',
      method: 'POST',
      path: '/ctos/racks/customize/non_rack',
      body: { kind: 'json', value: body },
      responseKind: 'json',
      timeoutClass: 'interactive',
      ctx: rctx,
    });
    const arr = res.raw as Array<Record<string, unknown>>;
    const o = arr[0] ?? {};
    console.log(
      `${label.padEnd(32)} size=${o['size']}U weight=${o['weight']} capacity=${o['capacity']} ` +
        `type=${o['type']} chassisModel=${o['chassisModel']} height=${o['height']}`,
    );
    fs.writeFileSync(`${OUT}/nonrack-${String(o['code'])}.json`, JSON.stringify(arr, null, 2));
  }

  // 2. Rack categories, for the rack picker.
  const cats = await http.send({
    endpoint: 'racks_categories',
    method: 'GET',
    path: '/ctos/racks/categories',
    responseKind: 'json',
    timeoutClass: 'fast',
    ctx: rctx,
  });
  fs.writeFileSync(`${OUT}/rack-categories.json`, JSON.stringify(cats.raw, null, 2));
  const tree = cats.raw as Array<{ products?: Array<Record<string, unknown>> }>;
  const racks = tree.flatMap((n) => n.products ?? []);
  console.log(`\nRack cabinets available: ${racks.length}`);
  for (const r of racks.slice(0, 12)) console.log(`   ${r['code']}  ${r['description']}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
