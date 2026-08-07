/**
 * Discovery probe for the rack / multi-product surface.
 *
 * The single-configuration session model cannot express "8 nodes in a rack with
 * a switch and cables". This maps what the rack endpoints actually accept, so
 * the workspace model can be designed against evidence rather than guesses.
 *
 * Read-only where possible; every mutating call operates on a workspace we
 * created ourselves. Paced and capped.
 *
 * Run with: npx tsx scripts/probe-rack.ts
 */
import { loadConfig } from '../src/config/load.js';
import { fetchSolutionModes, toSolutionContext } from '../src/domain/context.js';
import { DcscHttpClient, RequestBudget, type RequestCtx } from '../src/http/request.js';
import { configureLogger, newCorrId } from '../src/http/trace.js';

const PRODUCT = process.argv[2] ?? '7DMKCTO1WW';

function summarise(value: unknown, depth = 0, name = 'root'): string {
  const pad = '  '.repeat(depth);
  if (Array.isArray(value)) {
    const head = value[0];
    let out = `${pad}${name}: array[${value.length}]`;
    if (head !== undefined && depth < 2) out += `\n${summarise(head, depth + 1, `${name}[0]`)}`;
    return out;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object);
    let out = `${pad}${name}: object(${keys.length}) {${keys.slice(0, 14).join(', ')}${keys.length > 14 ? ', …' : ''}}`;
    if (depth < 1) {
      for (const k of keys.slice(0, 6)) {
        const v = (value as Record<string, unknown>)[k];
        if (v && typeof v === 'object') out += `\n${summarise(v, depth + 1, k)}`;
      }
    }
    return out;
  }
  return `${pad}${name}: ${JSON.stringify(value)?.slice(0, 70)}`;
}

async function main(): Promise<void> {
  const config = loadConfig({ logLevel: 'error' });
  configureLogger('error');
  const http = new DcscHttpClient(config);
  const budget = new RequestBudget(30);
  const base = { corrId: newCorrId(), locale: config.locale, budget };
  const solution = toSolutionContext(await fetchSolutionModes(http, base), 'General Purpose');
  const ctx: RequestCtx = { ...base, solution };

  const attempt = async (
    label: string,
    opts: {
      method: 'GET' | 'POST';
      path: string;
      query?: Record<string, string | number | boolean>;
      body?: unknown;
    },
  ): Promise<unknown> => {
    try {
      const res = await http.send({
        endpoint: 'probe',
        method: opts.method,
        path: opts.path,
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.body !== undefined ? { body: { kind: 'json' as const, value: opts.body } } : {}),
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
      });
      console.log(`\n--- ${label}  [HTTP ${res.status}]`);
      console.log(summarise(res.raw));
      return res.raw;
    } catch (err) {
      const e = err as { status?: number; internal?: string };
      console.log(`\n--- ${label}  [HTTP ${e.status ?? '?'}]`);
      console.log(`    ${String(e.internal ?? err).slice(0, 200)}`);
      return undefined;
    } finally {
      await new Promise((r) => setTimeout(r, 1200));
    }
  };

  console.log(`Probing rack surface with product ${PRODUCT}\n${'='.repeat(60)}`);

  const cats = (await attempt('GET /ctos/racks/categories', {
    method: 'GET',
    path: '/ctos/racks/categories',
  })) as Array<Record<string, unknown>> | undefined;

  // Walk the rack tree for concrete rack products.
  const rackProducts: Array<{ code: string; description: string; path: string }> = [];
  const walk = (nodes: Array<Record<string, unknown>>, trail: string[]): void => {
    for (const n of nodes) {
      const name = String(n.name ?? n.id);
      for (const p of (n.products as Array<Record<string, unknown>>) ?? []) {
        rackProducts.push({
          code: String(p.code),
          description: String(p.description ?? ''),
          path: [...trail, name].join(' > '),
        });
      }
      if (Array.isArray(n.children)) walk(n.children as Array<Record<string, unknown>>, [...trail, name]);
    }
  };
  if (cats) walk(cats, []);
  console.log(`\n    rack products found: ${rackProducts.length}`);
  for (const r of rackProducts.slice(0, 8)) console.log(`      ${r.code}  ${r.description.slice(0, 62)}`);

  await attempt('GET /ctos/racks/compatible_categories', {
    method: 'GET',
    path: '/ctos/racks/compatible_categories',
    query: { code: PRODUCT },
  });

  // Launch a RACK (not the server) — racks are themselves configurable products.
  const rack = rackProducts[0];
  if (rack) {
    await attempt(`POST /ctos/racks/${rack.code}/launch`, {
      method: 'POST',
      path: `/ctos/racks/${rack.code}/launch`,
      query: { hardwareOnly: false, controlExpressModal: false },
      body: {},
    });
  }

  // What networking products (switches) does the catalog expose?
  const cat = (await attempt('GET /category_hierarchies', {
    method: 'GET',
    path: '/category_hierarchies',
  })) as Array<Record<string, unknown>> | undefined;
  if (cat) {
    const nets: string[] = [];
    const walkNet = (nodes: Array<Record<string, unknown>>, trail: string[]): void => {
      for (const n of nodes) {
        const name = String(n.name ?? n.id);
        const t = [...trail, name];
        if (/network|switch/i.test(t.join(' '))) {
          for (const p of (n.products as Array<Record<string, unknown>>) ?? [])
            nets.push(`${String(p.code)}  ${String(p.description ?? '').slice(0, 55)}  [${t.join(' > ')}]`);
        }
        if (Array.isArray(n.children)) walkNet(n.children as Array<Record<string, unknown>>, t);
      }
    };
    walkNet(cat, []);
    console.log(`\n    networking products: ${nets.length}`);
    for (const n of nets.slice(0, 8)) console.log(`      ${n}`);
  }

  console.log(`\n${'='.repeat(60)}\nBudget used: ${budget.used}/${budget.limit}`);
  await http.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
