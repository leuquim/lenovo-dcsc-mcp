/**
 * Probes /ctos/racks/customize to establish the rackArea payload shape.
 *
 * Strategy: take the canonical placement object DCSC itself returns from
 * /racks/customize/non_rack, promote it into rackArea as a rack cabinet, and
 * see what the server fills in (capacity, positions, placement errors).
 */
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

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
  const rctx = { ...ctx, solution };

  const nonRack = async (code: string, type: string): Promise<Obj> => {
    const res = await http.send({
      endpoint: 'racks_customize_non_rack',
      method: 'POST',
      path: '/ctos/racks/customize/non_rack',
      body: { kind: 'json', value: [{ type, asVLH: false, code }] },
      responseKind: 'json',
      timeoutClass: 'interactive',
      ctx: rctx,
    });
    return ((res.raw as Obj[])[0] ?? {}) as Obj;
  };

  const rackTemplate = await nonRack('7D6DCTO1WW', 'rack');
  const serverTemplate = await nonRack('7DM9CTO1WW', 'server');
  console.log('rack template keys:', Object.keys(rackTemplate).length);
  console.log('server size:', serverTemplate['size'], 'weight:', serverTemplate['weight']);

  const customize = async (label: string, value: unknown) => {
    try {
      const res = await http.send({
        endpoint: 'racks_customize',
        method: 'POST',
        path: '/ctos/racks/customize',
        query: { autoArrange: false, autoConnect: false, cogValidation: true },
        body: { kind: 'json', value },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx: rctx,
      });
      const raw = res.raw as { rackArea?: Obj[]; nonRackArea?: Obj[] };
      const rack = raw.rackArea?.[0] as Obj | undefined;
      console.log(`\n[${label}] HTTP ${res.status}`);
      console.log(
        `  rackArea=${raw.rackArea?.length ?? 0} nonRackArea=${raw.nonRackArea?.length ?? 0}` +
          (rack
            ? ` | size=${rack['size']}U items=${(rack['rackItems'] as unknown[])?.length ?? 0}` +
              ` totalWeight=${rack['totalWeight']} stableStatus=${rack['stableStatus']}` +
              ` errors=${JSON.stringify(rack['errors'])}`
            : ''),
      );
      fs.writeFileSync(`${OUT}/customize-${label}.json`, JSON.stringify(res.raw, null, 2));
      return raw;
    } catch (err) {
      console.log(`\n[${label}] FAILED: ${(err as Error).message.slice(0, 300)}`);
      return undefined;
    }
  };

  // A: empty rack cabinet, using DCSC's own placement object as the template.
  const rackId = `US__${randomUUID()}0`;
  const emptyRack: Obj = {
    ...rackTemplate,
    id: rackId,
    code: '7D6DCTO1WW',
    sliceCtoCode: '7D6DCTO1WW',
    type: 'rack',
    quantity: 1,
    position: 1,
    nodes: [],
  };
  await customize('A-empty-rack', { rackArea: [emptyRack], nonRackArea: [] });

  // Placements live in rackItems, not nodes.
  const item = (position: number): Obj => ({
    ...serverTemplate,
    id: `US__${randomUUID()}0`,
    code: '7DM9CTO1WW',
    sliceCtoCode: '7DM9CTO1WW',
    type: 'server',
    quantity: 1,
    position,
    endPosition: position + (serverTemplate['size'] as number) - 1,
  });

  // B: one 8U server at the bottom of the rack.
  await customize('B-rack-with-server', {
    rackArea: [{ ...emptyRack, rackItems: [item(1)] }],
    nonRackArea: [],
  });

  // C: five 8U servers — 40U in a 42U rack, should fit and change the weight.
  await customize('C-five-servers', {
    rackArea: [{ ...emptyRack, rackItems: [1, 9, 17, 25, 33].map(item) }],
    nonRackArea: [],
  });

  // D: deliberately overhanging the top of the rack. Confirms that placement
  // validation is genuinely server-side rather than something we must invent.
  await customize('D-overflow', {
    rackArea: [{ ...emptyRack, rackItems: [item(40)] }],
    nonRackArea: [],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
