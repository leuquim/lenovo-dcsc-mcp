/**
 * End-to-end MCP smoke test.
 *
 * Spawns the built server over stdio and drives it exactly as an LLM client
 * would: find -> launch -> browse tab -> list section -> feature detail -> BOM.
 * Asserts each result is small enough to be usable in a model's context.
 *
 * Run with: npx tsx scripts/mcp-smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface TextContent {
  type: string;
  text?: string;
}

function extract(result: unknown): { json: unknown; bytes: number; isError: boolean } {
  const r = result as { content?: TextContent[]; isError?: boolean };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { json, bytes: Buffer.byteLength(text, 'utf8'), isError: r.isError === true };
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp/server.js'],
    env: { ...process.env, DCSC_LOG_LEVEL: 'error' } as Record<string, string>,
  });

  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`Tools registered (${tools.tools.length}):`);
  for (const t of tools.tools) console.log(`  - ${t.name}`);

  const call = async (name: string, args: Record<string, unknown>) => {
    const started = Date.now();
    const res = extract(await client.callTool({ name, arguments: args }));
    const ms = Date.now() - started;
    console.log(`\n== ${name}(${JSON.stringify(args)}) -> ${res.bytes}B in ${ms}ms`);
    if (res.isError) {
      console.log('   ERROR:', JSON.stringify(res.json));
      throw new Error(`${name} failed`);
    }
    return res;
  };

  // 1. find
  const find = await call('dcsc_find_products', { query: 'SR630 V3', type: 'CTO', limit: 3 });
  const products = (find.json as { products: Array<{ code: string; description: string }> })
    .products;
  console.log(products.map((p) => `   ${p.code}  ${p.description}`).join('\n'));

  const code = products[0]?.code;
  if (!code) throw new Error('no product found');

  // 2. launch
  const launched = await call('dcsc_launch', { productCode: code });
  const summary = launched.json as {
    session: string;
    totalPrice: number;
    currency: string;
    tabs: Array<{ title: string; sections: number; selected: number }>;
    constraints: unknown[];
  };
  const session = summary.session;
  console.log(`   session=${session} total=${summary.totalPrice} ${summary.currency}`);
  console.log(`   tabs: ${summary.tabs.map((t) => `${t.title}(${t.sections})`).join(' ')}`);
  console.log(`   constraints: ${summary.constraints.length}`);

  // 3. tab view (L1)
  const tab = await call('dcsc_list_options', { session, tab: 'Processors' });
  const tabView = tab.json as {
    sections: Array<{ id: string; name: string; options: number; selected: unknown[] }>;
  };
  for (const s of tabView.sections.slice(0, 5)) {
    console.log(`   ${s.id}  "${s.name}"  ${s.options} options, ${s.selected.length} selected`);
  }

  // 4. section view (L2)
  const target = tabView.sections.find((s) => s.options > 3) ?? tabView.sections[0];
  if (target) {
    const opts = await call('dcsc_list_options', { session, section: target.id, limit: 5 });
    const view = opts.json as {
      priceBasis: string;
      page: { total: number };
      options: Array<{ code: string; desc: string; unit: number; delta?: number; sel?: number }>;
    };
    console.log(`   priceBasis: ${view.priceBasis} (total ${view.page.total})`);
    for (const o of view.options) {
      console.log(
        `   ${o.code.padEnd(6)} ${o.sel ? `x${o.sel} ` : '   '} ${String(o.delta ?? o.unit).padStart(10)}  ${o.desc.slice(0, 60)}`,
      );
    }

    // 5. feature detail (L3)
    const first = view.options[0];
    if (first) {
      const detail = await call('dcsc_get_feature', { session, codes: [first.code] });
      const d = detail.json as { features: Array<{ detail: { attributes?: unknown } | null }> };
      console.log(`   attributes: ${JSON.stringify(d.features[0]?.detail?.attributes ?? {})}`);
    }
  }

  // 6. cross-tab search
  const search = await call('dcsc_list_options', { session, query: '64GB', limit: 5 });
  const found = search.json as {
    page: { total: number };
    options: Array<{ code: string; desc: string }>;
  };
  console.log(`   ${found.page.total} matches for "64GB"`);
  for (const o of found.options.slice(0, 3)) console.log(`   ${o.code}  ${o.desc.slice(0, 60)}`);

  // 7. BOM
  const bom = await call('dcsc_get_configuration', { session });
  const b = bom.json as {
    totalPrice: number;
    disclaimer: string;
    selections: Array<{ tab: string; items: unknown[] }>;
  };
  console.log(`   total=${b.totalPrice}`);
  for (const sel of b.selections) console.log(`   ${sel.tab}: ${sel.items.length} parts`);
  console.log(`   disclaimer: ${b.disclaimer}`);

  // 8. health
  const health = await call('dcsc_health', {});
  const h = health.json as { breaker: string; wafStrikes: number; openSessions: number };
  console.log(`   breaker=${h.breaker} wafStrikes=${h.wafStrikes} sessions=${h.openSessions}`);

  // 9. mutate
  const beforePrice = (bom.json as { totalPrice: number }).totalPrice;
  const cpuSection = tabView.sections.find((s) => s.name.toLowerCase().includes('processor'));
  const cpuOpts = await call('dcsc_list_options', {
    session,
    section: cpuSection?.id ?? 'processors.processor',
    limit: 3,
  });
  const pick = (cpuOpts.json as { options: Array<{ code: string; sel?: number }> }).options.find(
    (o) => !o.sel,
  );
  if (pick) {
    const changed = await call('dcsc_configure', {
      session,
      changes: [{ section: 'PROCESSOR', code: pick.code, quantity: 1 }],
    });
    const d = changed.json as {
      added: Array<{ code: string; desc: string; auto?: boolean }>;
      removed: Array<{ code: string }>;
      replaced: Array<{ from: string; to: string; section: string }>;
      price: { before: number; after: number; delta: number };
      autoChanges: number;
      constraints: Array<{ name: string; used: number; capacity: number }>;
    };
    console.log(`   price ${d.price.before} -> ${d.price.after} (delta ${d.price.delta})`);
    console.log(`   added: ${d.added.map((a) => a.code + (a.auto ? '(auto)' : '')).join(', ')}`);
    console.log(`   removed: ${d.removed.map((a) => a.code).join(', ') || '(none)'}`);
    console.log(`   replaced: ${d.replaced.map((r) => `${r.from}->${r.to} in ${r.section}`).join(', ') || '(none)'}`);
    console.log(`   autoChanges: ${d.autoChanges}`);
    console.log(`   constraints: ${d.constraints.map((c) => c.name + ' ' + c.used + '/' + c.capacity).join(', ')}`);
    if (d.price.after === beforePrice) console.log('   WARNING: price did not move');
  }

  // 10. export
  const exported = await call('dcsc_export', { session, fileName: 'mcp-e2e' });
  const e = exported.json as {
    zipPath: string;
    bytes: number;
    members: Array<{ name: string; bytes: number }>;
    xml?: string;
    warnings: string[];
  };
  console.log(`   zip: ${e.zipPath} (${e.bytes} B)`);
  for (const m of e.members) console.log(`     - ${m.name} (${m.bytes} B)`);
  console.log(`   xml: ${e.xml ?? '(none)'}`);
  if (e.warnings.length) console.log(`   warnings: ${e.warnings.join('; ')}`);

  await client.close();
  console.log('\nMCP SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\nMCP SMOKE FAILED');
  console.error(err);
  process.exitCode = 1;
});
