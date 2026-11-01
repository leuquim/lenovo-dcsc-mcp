/**
 * Real use case: "8 × ThinkSystem SR680a V4, rack solution with networking".
 *
 * Demonstrates a complete solution workspace holding 8 server nodes, a rack enclosure,
 * a switch, placement, and cabling — exported as a single solution ZIP with CFXML,
 * rack diagram, floor report and P2P cabling report.
 *
 * Run with: npx tsx scripts/usecase-cluster.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedChildEnv } from './lib/isolated-runtime.js';

const NODES = 8;

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp/server.js'],
    env: isolatedChildEnv({ DCSC_LOG_LEVEL: 'error' }),
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
    workspace?: string;
    currency: string;
    totalPrice: number;
    quantity: number;
    extendedPrice: number;
    constraints: Array<{ name: string; used: number; capacity: number }>;
  }

  console.log('=== 8 x ThinkSystem SR680a V4 Rack Solution with Networking ===\n');

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
  console.log(`2. launched  : ${s.session} (workspace ${s.workspace})`);
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

  // Add Switch into the same workspace
  const switches = await call<{ total: number; products: Product[] }>('dcsc_find_products', {
    query: 'ThinkSystem switch',
    limit: 5,
  });
  const swProduct = switches.products[0];
  if (!swProduct) throw new Error('No switch found in catalog');
  console.log(`\n4. switch    : ${swProduct.code}  ${swProduct.description.slice(0, 58)}`);

  const swLaunch = await call<Summary>('dcsc_launch', {
    productCode: swProduct.code,
    session: s.session,
    label: 'top-of-rack-switch',
  });
  console.log(`   launched  : ${swLaunch.session} in workspace ${swLaunch.workspace}`);

  // Add Rack Enclosure
  const rack = await call<{ rack: { id: string; uheight: number } }>('dcsc_add_rack', {
    session: s.session,
    rackCode: '7D6DCTO1WW',
    description: 'ThinkSystem 42U Onyx Heavy Duty Rack Cabinet',
    uheight: 42,
  });
  console.log(`\n5. rack      : ${rack.rack.id} (42U)`);

  // Place products in rack
  await call('dcsc_place_in_rack', {
    session: s.session,
    configId: s.session,
    rackId: rack.rack.id,
    uPosition: 1,
    height: 8,
  });
  await call('dcsc_place_in_rack', {
    session: s.session,
    configId: swLaunch.session,
    rackId: rack.rack.id,
    uPosition: 41,
    height: 1,
  });
  console.log('   placed    : 8 x SR680a V4 @ U1-U8, Switch @ U41');

  // Add Cabling
  const cable = await call<{ cabling: { id: string } }>('dcsc_add_cabling', {
    session: s.session,
    fromConfigId: s.session,
    fromPort: 'IB-Port-1',
    toConfigId: swLaunch.session,
    toPort: 'Port-1',
    cableCode: '6400',
    description: 'InfiniBand High-Speed Cable',
  });
  console.log(`\n6. cabling   : ${cable.cabling.id} (SR680a V4 IB-Port-1 -> Switch Port-1)`);

  // Export full multi-product solution ZIP
  const ex = await call<{ zipPath: string; members: Array<{ name: string; bytes: number }> }>('dcsc_export', {
    session: s.session,
    fileName: 'sr680a-v4-rack-solution',
    fileTypes: ['XML', 'QUOTE', 'SUMMARY', 'RACK_DIAGRAM', 'FLOOR', 'P2P_REPORT', 'RACK_REPORT'],
  });
  console.log(`\n7. export    : ${ex.zipPath}`);
  for (const m of ex.members) console.log(`   ${m.name} (${m.bytes} B)`);

  console.log('\n--- what this run could NOT express ---');
  console.log('   (none - full solution expressed: rack enclosure, switch in workspace, placement, cabling, P2P report & rack diagram)');

  await client.close();
}

main().catch((err: unknown) => {
  console.error('USE CASE FAILED');
  console.error(err);
  process.exitCode = 1;
});
