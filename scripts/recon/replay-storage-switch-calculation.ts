/**
 * Diagnostic only: replays a captured /switch_calculation request with and without the placed SAN switch.
 *
 * npx tsx scripts/recon/replay-storage-switch-calculation.ts <request.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../../src/config/load.js';
import { fetchSolutionModes, toSolutionContext } from '../../src/domain/context.js';
import { DcscHttpClient, RequestBudget } from '../../src/http/request.js';
import { configureLogger, newCorrId } from '../../src/http/trace.js';
const [reqPath, outPath] = process.argv.slice(2);
if (!reqPath || !outPath) throw new Error('usage: <switch-calculation-request.json> <out.json>');
const config = loadConfig({ logLevel: 'warn' });
configureLogger(config.logLevel);
const http = new DcscHttpClient(config);
const base = { corrId: newCorrId(), locale: config.locale, budget: new RequestBudget(20) };
const solution = toSolutionContext(await fetchSolutionModes(http, base), 'HPC and AI - Systems');
const original = JSON.parse(readFileSync(reqPath!, 'utf8'));
const sanIds = new Set<string>((original.storageConnectionNetworks ?? []).flatMap((n: any) => [n.mainSwitch?.id, ...(original.cloneDependency?.[n.mainSwitch?.id] ?? [])]).filter(Boolean));
const unplaced = structuredClone(original);
for (const rack of unplaced.rackArea) rack.rackItems = (rack.rackItems ?? []).filter((i: any) => !sanIds.has(i.id));
const out: Record<string, unknown> = {};
for (const [name, body] of Object.entries({ control: original, 'san-unplaced': unplaced })) {
  const res = await http.send({ endpoint: 'switch_calculation', method: 'POST', path: '/switch_calculation',
    query: { sbSlices: '', countryName: 'United States', current_country_or_region: 'US' },
    body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'interactive', ctx: { ...base, solution } });
  out[name] = res.raw;
  console.log(name, res.status, JSON.stringify(res.raw).slice(0, 600));
}
writeFileSync(outPath!, JSON.stringify({ sanIds: [...sanIds], results: out }, null, 2));
