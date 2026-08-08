/**
 * Probes the three P0 surfaces: floor grid, auto-connect/cabling, PDU preference.
 *
 * Goal: establish which are server-validated vs SPA-local, and capture request/
 * response shapes so domain modules can take DCSC as authority where possible.
 *
 * Usage: npx tsx scripts/probe-p0-floor-cabling-pdu.ts
 */
import * as fs from 'node:fs';
import { loadConfig } from '../../src/config/load.js';
import { DcscHttpClient } from '../../src/http/request.js';
import { configureLogger } from '../../src/http/trace.js';
import { DcscService } from '../../src/mcp/service.js';
import {
  buildRackItem,
  buildRackObject,
  customizeLayout,
  fetchEnvelopes,
  fetchRackCabinets,
} from '../../src/domain/rack.js';

const OUT = 'artifacts/rack_probe';
type Obj = Record<string, unknown>;

async function tryCall(
  http: DcscHttpClient,
  ctx: ReturnType<DcscService['newCtx']> & { solution?: unknown },
  label: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { value?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<unknown> {
  try {
    const res = await http.send({
      endpoint: label,
      method,
      path,
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.value !== undefined ? { body: { kind: 'json' as const, value: opts.value } } : {}),
      responseKind: 'json',
      timeoutClass: 'heavy',
      ctx: ctx as never,
    });
    const s = JSON.stringify(res.raw);
    console.log(`\n[${label}] HTTP ${res.status} len=${s.length}`);
    console.log('  keys:', typeof res.raw === 'object' && res.raw ? Object.keys(res.raw as object).slice(0, 30) : typeof res.raw);
    console.log('  ', s.slice(0, 700));
    fs.writeFileSync(`${OUT}/${label}.json`, JSON.stringify(res.raw, null, 2));
    return res.raw;
  } catch (err) {
    console.log(`\n[${label}] FAILED: ${(err as Error).message.slice(0, 400)}`);
    return undefined;
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const fullCtx = { ...ctx, solution };

  // One node + one rack, placed, so auto_connect / PDU have something to work on.
  const session = await service.launch({
    productCode: '7DM9CTO1WW',
    mode: 'cto',
    solution,
    ctx,
  });
  console.log('launched', session.id, session.product.code, '$', session.raw.totalPrice);

  const cabinets = await fetchRackCabinets(http, fullCtx);
  const rackCode = cabinets[0]?.code ?? '7D6DCTO1WW';
  console.log('rack cabinet', rackCode, cabinets[0]?.description);

  const envelopes = await fetchEnvelopes(http, fullCtx, [
    { code: rackCode, type: 'rack' },
    { code: session.product.code, type: 'server' },
  ]);
  const rackEnv = envelopes.get(rackCode.toUpperCase());
  const nodeEnv = envelopes.get(session.product.code.toUpperCase());
  if (!rackEnv || !nodeEnv) throw new Error('missing envelopes');

  const rackId = `rack_${Date.now()}`;
  const item = buildRackItem(nodeEnv, session.configurationId, 3, session.raw.quantity ?? 1);
  const rack = buildRackObject(rackEnv, rackId, [item]);

  const layout = await customizeLayout(
    http,
    fullCtx,
    { rackArea: [rack], nonRackArea: [] },
    { autoArrange: true, cogValidation: true },
  );
  console.log(
    'layout racks=',
    layout.racks.length,
    'items=',
    layout.racks[0]?.items.length,
    'stable=',
    layout.racks[0]?.stableStatus,
    'connections=',
    layout.connections.length,
  );
  fs.writeFileSync(
    `${OUT}/p0-layout.json`,
    JSON.stringify({ rackArea: layout.rawRackArea, nonRackArea: layout.rawNonRackArea, connections: layout.connections }, null, 2),
  );

  // --- PDU preference: codes = rack product codes (handoff says codes query) ---
  await tryCall(http, fullCtx, 'pdu_preference_no_codes', 'GET', '/pdu/pduPreference');
  await tryCall(http, fullCtx, 'pdu_preference_rack', 'GET', '/pdu/pduPreference', {
    query: { codes: rackCode },
  });
  await tryCall(http, fullCtx, 'pdu_preference_node', 'GET', '/pdu/pduPreference', {
    query: { codes: session.product.code },
  });
  await tryCall(http, fullCtx, 'pdu_preference_both', 'GET', '/pdu/pduPreference', {
    query: { codes: `${rackCode},${session.product.code}` },
  });

  // --- auto_connect: SPA posts full workspace context ---
  const floorPreference = {
    growthRatioHorizontal: 1,
    growthRatioVertical: 1,
    rackDist: 0.01,
    vertDist: 0.5,
    coldDist: 3,
    hotDist: 2,
    slackDist: 0,
    useTrayCabling: false,
  };
  const autoBody = {
    rackArea: layout.rawRackArea,
    nonRackArea: layout.rawNonRackArea,
    configurations: [session.raw],
    clusterPreference: [],
    floorPreference,
    powerPreference: [],
    floorItems: [{ id: 'floor_1', rackId, x: 0, y: 0 }],
    cloneRackMapping: {},
    storageConnectionNetworks: [],
    switchMap: [],
    cloneDependency: { [session.configurationId]: [session.configurationId] },
  };
  await tryCall(http, fullCtx, 'auto_connect', 'POST', '/auto_connect', { value: autoBody });

  // Minimal body variants if the full one fails.
  await tryCall(http, fullCtx, 'auto_connect_min', 'POST', '/auto_connect', {
    value: {
      rackArea: layout.rawRackArea,
      nonRackArea: layout.rawNonRackArea,
      configurations: [session.raw],
    },
  });

  // --- p2p-report (export-style) ---
  await tryCall(http, fullCtx, 'p2p_report_empty', 'POST', '/p2p-report', {
    value: [],
  });
  await tryCall(http, fullCtx, 'p2p_report_layout_connections', 'POST', '/p2p-report', {
    value: layout.connections,
  });

  // --- calculateDistance ---
  await tryCall(http, fullCtx, 'calculate_distance', 'POST', '/calculateDistance', {
    value: {
      floorItems: [{ id: 'floor_1', rackId, x: 0, y: 0 }],
      floorPreference,
      cabling: [],
    },
  });

  // Floor: confirm no floor-related API exists by probing a few guesses
  for (const path of ['/floor', '/floorGrid', '/floor/grid', '/ctos/floor']) {
    await tryCall(http, fullCtx, `floor_guess_${path.replace(/\//g, '_')}`, 'GET', path);
  }

  console.log('\nDone. Artifacts in', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
