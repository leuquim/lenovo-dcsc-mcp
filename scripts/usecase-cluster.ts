/**
 * Real use case: "8 × ThinkSystem SR680a V4, rack solution with networking".
 *
 * Exercises the parts the MCP can express today and reports precisely which
 * parts of the request it cannot, rather than quietly producing something
 * that looks complete.
 *
 * Run with: npx tsx scripts/usecase-cluster.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const NODES = 8;

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp/server.js'],
    env: { ...process.env, DCSC_LOG_LEVEL: 'error' } as Record<string, string>,
  });
  const client = new Client({ name: 'usecase', version: '1.0.0' });
  await client.connect(transport);

  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const json = JSON.parse(r.content[0]?.text ?? '{}') as T;
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(json)}`);
    return json;
  };

  interface Product { code: string; description: string }
  interface Summary {
    session: string;
    currency: string;
    totalPrice: number;
    quantity: number;
    extendedPrice: number;
    constraints: Array<{ name: string; used: number; capacity: number }>;
  }

  console.log('=== 8 x ThinkSystem SR680a V4 ===\n');

  const found = await call<{ products: Product[] }>('dcsc_find_products', {
    query: 'SR680a V4',
    type: 'CTO',
    limit: 3,
  });
  const node = found.products.find((p) => /SR680a V4/i.test(p.description));
  if (!node) throw new Error('SR680a V4 not found in the catalog');
  console.log(`1. node      : ${node.code}  ${node.description}`);

  const s = await call<Summary>('dcsc_launch', {
    productCode: node.code,
    label: 'ai-cluster-node',
  });
  console.log(`2. launched  : ${s.session}`);
  console.log(`   per node  : $${s.totalPrice.toLocaleString()} ${s.currency}`);
  console.log(
    `   headroom  : ${s.constraints.map((c) => `${c.name} ${c.used}/${c.capacity}`).join(', ')}`,
  );

  const q = await call<Summary>('dcsc_set_quantity', { session: s.session, quantity: NODES });
  console.log(`3. quantity  : ${q.quantity} nodes`);
  console.log(`   extended  : $${q.extendedPrice.toLocaleString()} ${q.currency}`);
  const expected = Math.round(s.totalPrice * NODES * 100) / 100;
  console.log(
    `   check     : ${q.extendedPrice === expected ? 'OK' : `WRONG (expected ${expected})`}`,
  );

  // Networking: is a switch reachable as its own configuration?
  const switches = await call<{ total: number; products: Product[] }>('dcsc_find_products', {
    query: 'ThinkSystem switch',
    limit: 5,
  });
  console.log(`\n4. switches found in catalog: ${switches.total}`);
  for (const p of switches.products.slice(0, 3)) {
    console.log(`   ${p.code}  ${p.description.slice(0, 58)}`);
  }

  const ex = await call<{ zipPath: string; members: Array<{ name: string; bytes: number }> }>('dcsc_export', {
    session: s.session,
    fileName: 'sr680a-v4-cluster',
    fileTypes: ['XML', 'QUOTE', 'SUMMARY'],
  });
  console.log(`\n5. export    : ${ex.zipPath}`);
  for (const m of ex.members) console.log(`   ${m.name} (${m.bytes} B)`);

  console.log('\n--- what this run could NOT express ---');
  console.log('   * rack enclosure + U placement   (no rack tools)');
  console.log('   * switch as part of the SAME solution (no multi-product workspace)');
  console.log('   * cabling / port-to-port report   (needs the rack workspace)');

  await client.close();
}

main().catch((err: unknown) => {
  console.error('USE CASE FAILED');
  console.error(err);
  process.exitCode = 1;
});
