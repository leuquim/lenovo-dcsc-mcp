/**
 * Probes the power/PDU endpoints so dcsc_power can be built on real numbers.
 */
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
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

  // A real, fully derived configuration to feed the power calculator.
  const session = await service.launch({
    productCode: '7DM9CTO1WW',
    mode: 'cto',
    solution,
    ctx,
  });
  console.log('launched', session.id, '$', session.raw.totalPrice);
  const raw = session.raw as Obj;
  console.log('powerReportResponse present:', raw['powerReportResponse'] !== undefined && raw['powerReportResponse'] !== null);
  console.log('powerPolicies:', JSON.stringify(raw['powerPolicies'])?.slice(0, 300));
  console.log('currentPowerPolicy:', JSON.stringify(raw['currentPowerPolicy'])?.slice(0, 200));
  console.log('optionalVoltages:', JSON.stringify(raw['optionalVoltages'])?.slice(0, 300));
  fs.writeFileSync(`${OUT}/power-from-launch.json`, JSON.stringify({
    powerReportResponse: raw['powerReportResponse'],
    powerPolicies: raw['powerPolicies'],
    currentPowerPolicy: raw['currentPowerPolicy'],
    optionalVoltages: raw['optionalVoltages'],
    resourceTrackers: raw['resourceTrackers'],
  }, null, 2));

  const tryCall = async (label: string, method: 'GET' | 'POST', path: string, value?: unknown, query?: Obj) => {
    try {
      const res = await http.send({
        endpoint: label,
        method,
        path,
        ...(query ? { query: query as Record<string, string | number | boolean | undefined> } : {}),
        ...(value !== undefined ? { body: { kind: 'json' as const, value } } : {}),
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx: { ...ctx, solution },
      });
      const s = JSON.stringify(res.raw);
      console.log(`\n[${label}] HTTP ${res.status} len=${s.length}`);
      console.log('  ', s.slice(0, 600));
      fs.writeFileSync(`${OUT}/${label}.json`, JSON.stringify(res.raw, null, 2));
    } catch (err) {
      console.log(`\n[${label}] FAILED: ${(err as Error).message.slice(0, 250)}`);
    }
  };

  await tryCall('pdu_preference', 'GET', '/pdu/pduPreference');
  await tryCall('node_roles', 'GET', '/node_roles');
  await tryCall('topologies', 'GET', '/getTopologies');
  await tryCall('storage_prefs', 'GET', '/getStoragePreferences');

  // The power calculator: shape unknown, so try the obvious candidates.
  await tryCall('powercalculate_cfg', 'POST', '/powercalculation/powercalculate', {
    configurations: [session.raw],
  });
  await tryCall('powercalculate_ws', 'POST', '/powercalculation/powercalculate', {
    rackArea: [],
    nonRackArea: [],
    configurations: [session.raw],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
