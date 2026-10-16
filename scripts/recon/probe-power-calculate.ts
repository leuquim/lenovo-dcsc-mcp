/**
 * Posts the website's exact power-panel request (bundle powerReportQuerySelector)
 * for freshly launched products, to learn whether a numeric report exists
 * outside launch/derive. Diagnostic only; nothing is persisted outside outDir.
 *
 * npx tsx scripts/recon/probe-power-calculate.ts <outDir> <productCode...>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { configureLogger } from '../../src/http/trace.js';
import { DcscService } from '../../src/mcp/service.js';
import { isolateRuntime } from '../lib/isolated-runtime.js';

type Json = Record<string, any>;

function powerReportQuery(configs: Json[]): Json[] {
  return configs.map((cfg) => {
    const features: Json[] = [];
    for (const tab of cfg.tabs ?? []) for (const sub of tab.subTabs ?? []) for (const section of sub.sections ?? []) {
      for (const r of section.results ?? []) {
        features.push({ characterName: section.name, featureCode: r.code, ctoCode: r.ctoCode, derived: r.derived, quantity: r.quantity });
      }
    }
    for (const u of cfg.unSelectableCharacters ?? cfg.unSelectableCharacterResults ?? []) {
      for (const r of u.results ?? []) {
        features.push({ characterName: u.name ?? u.characterName, featureCode: r.code, ctoCode: r.ctoCode, derived: r.derived, quantity: r.quantity });
      }
    }
    return {
      features,
      operationVoltage: cfg.voltage,
      type: cfg.type,
      productNumber: cfg.code,
      utilization: cfg.powerReportResponse?.powerReport?.loadFactor,
      currentPowerPolicy: cfg.currentPowerPolicy,
    };
  });
}

async function main(): Promise<void> {
  const [outDir, ...codes] = process.argv.slice(2);
  if (!outDir || codes.length === 0) throw new Error('usage: <outDir> <productCode...>');
  const config = isolateRuntime(loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'error' }));
  configureLogger(config.logLevel);
  const service = new DcscService(config);
  mkdirSync(outDir, { recursive: true });

  for (const code of codes) {
    const modes = await service.modesContaining(service.newCtx(), [code]);
    const mode = modes.get(code.toUpperCase())?.[0];
    if (!mode) throw new Error(`${code} absent from every current solution catalog`);
    const ctx = service.newCtx();
    const solution = await service.resolveSolution(ctx, mode);
    const session = await service.launch({ productCode: code, mode: 'cto', solution, ctx, label: `power probe ${code}` });
    const raw = session.raw as Json;
    const body = powerReportQuery([raw]);
    const res = await service.http.send({
      endpoint: 'power_calculate', method: 'POST', path: '/powercalculation/powercalculate',
      body: { kind: 'json', value: body }, responseKind: 'json', timeoutClass: 'interactive', ctx: { ...ctx, solution },
    }).catch((error: Error) => ({ status: 'error', raw: { error: error.message } }));
    const report = (res.raw as Json)?.powerReport;
    const summary = {
      code, mode, launchPowerReportResponse: raw.powerReportResponse ?? null,
      launchVoltage: raw.voltage ?? null, optionalVoltages: raw.optionalVoltages ?? null,
      currentPowerPolicy: raw.currentPowerPolicy ?? null, powerPolicies: raw.powerPolicies ?? null,
      requestFeatureCount: body[0]?.features.length, status: res.status,
      responseKeys: Object.keys((res.raw as Json) ?? {}), errorMsg: (res.raw as Json)?.errorMsg ?? null,
      powerReportKeys: report ? Object.keys(report) : null,
      inputPower: report?.inputPower ?? report?.inputPowerW ?? null,
    };
    writeFileSync(join(outDir, `${code}-request.json`), JSON.stringify(body));
    writeFileSync(join(outDir, `${code}-response.json`), JSON.stringify(res.raw));
    writeFileSync(join(outDir, `${code}-summary.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary).slice(0, 1500));
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
