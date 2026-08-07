/**
 * Live smoke test for the client foundation.
 *
 * Exercises the real bootstrap sequence against dcsc.lenovo.com:
 *   /solution_modes -> /category_hierarchies -> search -> /ctos/{code}/launch
 *
 * Deliberately small: ~4 requests, sequential, well inside the pacing policy.
 * Run with: npx tsx scripts/smoke.ts
 */
import { loadConfig } from '../src/config/load.js';
import { fetchCatalog, searchCatalog } from '../src/domain/catalog.js';
import { fetchSolutionModes, toSolutionContext } from '../src/domain/context.js';
import { DcscHttpClient, RequestBudget } from '../src/http/request.js';
import { configureLogger, newCorrId } from '../src/http/trace.js';

async function main(): Promise<void> {
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);

  const http = new DcscHttpClient(config);
  const corrId = newCorrId();
  const budget = new RequestBudget(config.pacing.perToolRequestBudget);
  const base = { corrId, locale: config.locale, budget };

  try {
    console.log('1. GET /solution_modes');
    const modes = await fetchSolutionModes(http, base);
    console.log(`   -> ${modes.length} modes:`, modes.map((m) => m.mode).join(' | '));

    const solution = toSolutionContext(modes, 'General Purpose');
    console.log(`   -> using "${solution.solutionMode}" slices=${solution.masterSlices.join(',')}`);

    const ctx = { ...base, solution };

    console.log('2. GET /category_hierarchies');
    const catalog = await fetchCatalog(http, ctx);
    console.log(`   -> ${catalog.tree.length} roots, ${catalog.entries.length} products indexed`);

    console.log('3. search "SR630 V3"');
    const hits = searchCatalog(catalog, { query: 'SR630 V3', limit: 5 });
    for (const h of hits) {
      console.log(`   -> ${h.code}  ${h.type.padEnd(4)}  ${h.description}`);
      console.log(`      ${h.path.join(' > ')}`);
    }

    const target = hits.find((h) => h.type === 'CTO') ?? hits[0];
    if (!target) throw new Error('No catalog hits — cannot continue.');

    console.log(`4. POST /ctos/${target.code}/launch`);
    const res = await http.send({
      endpoint: 'cto_launch',
      method: 'POST',
      path: `/ctos/${encodeURIComponent(target.code)}/launch`,
      query: { hardwareOnly: false, controlExpressModal: false },
      body: { kind: 'json', value: {} },
      responseKind: 'json',
      timeoutClass: 'interactive',
      ctx,
    });

    const cfg = res.raw as Record<string, unknown>;
    const tabs = (cfg.tabs ?? []) as Array<{ title?: string }>;
    console.log(`   -> HTTP ${res.status} in ${res.durationMs}ms, requestId=${res.requestId}`);
    console.log(`   -> ${Object.keys(cfg).length} top-level fields`);
    console.log(`   -> totalPrice=${String(cfg.totalPrice)} ${config.locale.currency}`);
    console.log(`   -> id=${String(cfg.id)} (null confirms client-held state)`);
    console.log(`   -> tabs: ${tabs.map((t) => t.title).join(', ')}`);

    console.log(`\nBudget used: ${budget.used}/${budget.limit}`);
    console.log('Health:', http.health);
    console.log('\nSMOKE OK');
  } finally {
    await http.close();
  }
}

main().catch((err: unknown) => {
  console.error('\nSMOKE FAILED');
  console.error(err);
  process.exitCode = 1;
});
