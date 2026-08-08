/**
 * Figure out how to select/install a PDU so configure_pdu has a DCSC-backed path.
 */
import * as fs from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import {
  buildRackItem,
  buildRackObject,
  customizeLayout,
  fetchEnvelopes,
  fetchRackCabinets,
} from '../src/domain/rack.js';

const OUT = 'artifacts/rack_probe';
type Obj = Record<string, unknown>;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const fullCtx = { ...ctx, solution };

  const node = await service.launch({
    productCode: '7DM9CTO1WW',
    mode: 'cto',
    solution,
    ctx,
  });

  // Try launching the rack as a configurable product.
  let rackCfg: Awaited<ReturnType<typeof service.launch>> | undefined;
  try {
    rackCfg = await service.launch({
      productCode: '7D6DCTO1WW',
      mode: 'cto',
      solution,
      ctx,
    });
    console.log('rack-as-config', rackCfg.id, '$', rackCfg.raw.totalPrice);
    const raw = rackCfg.raw as Obj;
    console.log(
      '  groups-ish keys',
      Object.keys(raw).filter((k) => /feature|tab|group|pdu|power|option/i.test(k)).slice(0, 40),
    );
    // dump reduced if available
    console.log('  reduced tabs', rackCfg.reduced?.tabs?.map((t) => t.name).slice(0, 20));
  } catch (e) {
    console.log('rack launch failed:', (e as Error).message.slice(0, 250));
  }

  const cabinets = await fetchRackCabinets(http, fullCtx);
  const rackCode = cabinets[0]?.code ?? '7D6DCTO1WW';
  const envs = await fetchEnvelopes(http, fullCtx, [
    { code: rackCode, type: 'rack' },
    { code: node.product.code, type: 'server' },
  ]);
  const rackEnv = envs.get(rackCode.toUpperCase())!;
  const nodeEnv = envs.get(node.product.code.toUpperCase())!;
  const rackId = rackCfg?.configurationId ?? `rack_${Date.now()}`;
  const item = buildRackItem(nodeEnv, node.configurationId, 3, 1);
  let rack = buildRackObject(rackEnv, rackId, [item]);

  // First customize to get pduPlacementRules + features from auto_connect
  let layout = await customizeLayout(http, fullCtx, { rackArea: [rack], nonRackArea: [] }, {
    autoArrange: true,
  });
  console.log('after customize features', (layout.rawRackArea[0] as Obj)?.['features']);

  // auto_connect to get features catalog
  const ac = await http.send({
    endpoint: 'auto_connect',
    method: 'POST',
    path: '/auto_connect',
    body: {
      kind: 'json',
      value: {
        rackArea: layout.rawRackArea,
        nonRackArea: layout.rawNonRackArea,
        configurations: [node.raw, ...(rackCfg ? [rackCfg.raw] : [])],
      },
    },
    responseKind: 'json',
    timeoutClass: 'heavy',
    ctx: fullCtx,
  });
  const acRaw = ac.raw as {
    rackArea?: Obj[];
    nonRackArea?: Obj[];
    connections?: unknown[];
  };
  console.log(
    'auto_connect features count',
    ((acRaw.rackArea?.[0]?.['features'] as unknown[]) ?? []).length,
    'featureItems',
    ((acRaw.rackArea?.[0]?.['featureItems'] as unknown[]) ?? []).length,
    'connections',
    (acRaw.connections ?? []).length,
  );
  fs.writeFileSync(`${OUT}/pdu-auto-connect.json`, JSON.stringify(ac.raw, null, 2));

  rack = { ...(acRaw.rackArea?.[0] ?? layout.rawRackArea[0]!) };

  // Try setting a PDU feature quantity and re-customizing.
  const features = (rack['features'] as Obj[] | undefined) ?? [];
  const pduCodes = features
    .flatMap((f) => ((f['results'] as Obj[]) ?? []).map((r) => String(r['code'] ?? '')))
    .filter(Boolean);
  console.log('available PDU feature codes from auto_connect:', [...new Set(pduCodes)].join(', '));

  // Pick first non-C9JN code (C9JN looks like a filler/repeat)
  const pick = [...new Set(pduCodes)].find((c) => c !== 'C9JN') ?? pduCodes[0];
  if (pick) {
    // Mutate features qty=1 for pick
    const nextFeatures = features.map((f) => {
      const results = ((f['results'] as Obj[]) ?? []).map((r) =>
        r['code'] === pick ? { ...r, quantity: 1, quantityChanged: true } : r,
      );
      return { ...f, results };
    });
    const withFeat = { ...rack, features: nextFeatures };
    try {
      layout = await customizeLayout(
        http,
        fullCtx,
        { rackArea: [withFeat], nonRackArea: acRaw.nonRackArea ?? [] },
        { autoArrange: false },
      );
      const r0 = layout.rawRackArea[0] as Obj | undefined;
      console.log(
        'after qty=1 customize: featureItems=',
        JSON.stringify(r0?.['featureItems'])?.slice(0, 400),
        'features qty pick=',
        JSON.stringify(
          ((r0?.['features'] as Obj[]) ?? [])
            .flatMap((f) => (f['results'] as Obj[]) ?? [])
            .filter((r) => r['code'] === pick),
        )?.slice(0, 300),
      );
      fs.writeFileSync(
        `${OUT}/pdu-after-qty.json`,
        JSON.stringify({ rackArea: layout.rawRackArea, nonRackArea: layout.rawNonRackArea }, null, 2),
      );
    } catch (e) {
      console.log('qty customize failed', (e as Error).message.slice(0, 200));
    }

    // Try featureItems install using pduPlacementRules
    const rules = rack['pduPlacementRules'] as Obj | undefined;
    const typeRules = (rules?.['pduTypeRules'] as Obj[]) ?? [];
    const matching = typeRules.find((tr) =>
      ((tr['features'] as string[]) ?? []).includes(pick),
    );
    console.log('matching rule for', pick, matching?.['groupName'], matching?.['features']);

    const featureItem: Obj = {
      code: pick,
      type: 'pdu',
      quantity: 1,
      position: 1,
      location: 'SIDE_WALL',
      align: 'left',
      occupiedBay: 1,
      occupiedSlots: [1],
      id: `${rackId}_pdu_${pick}`,
    };
    const withItem = {
      ...rack,
      featureItems: [featureItem],
      features: nextFeatures,
    };
    try {
      layout = await customizeLayout(
        http,
        fullCtx,
        { rackArea: [withItem], nonRackArea: [] },
        { autoArrange: false },
      );
      const r0 = layout.rawRackArea[0] as Obj | undefined;
      console.log(
        'after featureItem customize: featureItems=',
        JSON.stringify(r0?.['featureItems'])?.slice(0, 600),
        'errors=',
        JSON.stringify(r0?.['errors'])?.slice(0, 300),
      );
      fs.writeFileSync(
        `${OUT}/pdu-after-featureitem.json`,
        JSON.stringify({ rackArea: layout.rawRackArea, nonRackArea: layout.rawNonRackArea }, null, 2),
      );
    } catch (e) {
      console.log('featureItem customize failed', (e as Error).message.slice(0, 200));
    }
  }

  // PDU preference after rack-as-config
  if (rackCfg) {
    for (const codes of [rackCfg.product.code, rackCode, `${rackCode},${node.product.code}`]) {
      try {
        const res = await http.send({
          endpoint: 'pdu_pref',
          method: 'GET',
          path: '/pdu/pduPreference',
          query: { codes },
          responseKind: 'json',
          timeoutClass: 'fast',
          ctx: fullCtx,
        });
        console.log('pduPreference codes=', codes, '=>', JSON.stringify(res.raw).slice(0, 500));
        fs.writeFileSync(
          `${OUT}/pdu-pref-${codes.replace(/[^A-Z0-9]+/gi, '_')}.json`,
          JSON.stringify(res.raw, null, 2),
        );
      } catch (e) {
        console.log('pduPreference codes=', codes, 'FAIL', (e as Error).message.slice(0, 150));
      }
    }

    // Dump rack configuration tabs for PDU-related options
    const summary = rackCfg.reduced;
    if (summary) {
      for (const tab of summary.tabs ?? []) {
        for (const sec of tab.sections ?? []) {
          const name = `${tab.name}/${sec.name}`;
          if (/pdu|power|cord|voltage|inlet/i.test(name)) {
            console.log('section', name, 'options', sec.options?.length);
            for (const o of (sec.options ?? []).slice(0, 8)) {
              console.log('  ', o.code, o.description?.slice(0, 60), o.selected, o.quantity);
            }
          }
        }
      }
    }
  }

  // Try customize with autoConnect query true (already a flag)
  try {
    layout = await customizeLayout(
      http,
      fullCtx,
      { rackArea: layout.rawRackArea.length ? layout.rawRackArea : [rack], nonRackArea: [] },
      { autoArrange: true, autoConnect: true },
    );
    const r0 = layout.rawRackArea[0] as Obj | undefined;
    console.log(
      'customize autoConnect=true featureItems=',
      JSON.stringify(r0?.['featureItems'])?.slice(0, 400),
      'features sample=',
      JSON.stringify(((r0?.['features'] as Obj[]) ?? []).slice(0, 2))?.slice(0, 400),
      'connections=',
      layout.connections.length,
    );
  } catch (e) {
    console.log('autoConnect customize failed', (e as Error).message.slice(0, 200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
