/**
 * Verifies the fixes made after the B200 AI factory build, across several
 * different configuration shapes rather than just the one that found them.
 *
 * Shapes covered: single CTO node, multi-config workspace with and without
 * racks, a current General Purpose CTO, an LFO model, and
 * a non-standard cabinet (GB300 tray + MGX rack).
 *
 * Run: npx tsx scripts/verify-fixes.ts
 */
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadConfig } from '../src/config/load.js';
import { searchCatalog } from '../src/domain/catalog.js';
import { assessRackDensity } from '../src/domain/power.js';
import { listPduCatalog } from '../src/domain/pdu.js';
import { writeExportBundle } from '../src/files/artifactStore.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { registerTools } from '../src/mcp/tools.js';
import { isolateRuntime } from './lib/isolated-runtime.js';

type VerificationStatus = 'pass' | 'fail' | 'blocked';
interface VerificationResult {
  name: string;
  status: VerificationStatus;
  detail: string;
  reason?: 'upstream-unavailable' | 'dependency-blocked';
}

interface ToolReply {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

const results: VerificationResult[] = [];
let activeCli: ReturnType<typeof commandLine> | undefined;
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, status: ok ? 'pass' : 'fail', detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
}

function blocked(
  name: string,
  reason: 'upstream-unavailable' | 'dependency-blocked',
  detail: string,
): void {
  results.push({ name, status: 'blocked', reason, detail });
  console.log(`  BLOCKED  ${name}\n        ${detail}`);
}

function registeredHandlers(service: DcscService): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerTools(
    {
      registerTool(name: string, _config: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
        return { remove() {}, update() {} };
      },
    } as unknown as McpServer,
    service,
  );
  return handlers;
}

function parseToolReply(reply: ToolReply): Record<string, unknown> {
  const text = reply.content.find((item) => item.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (reply.isError) throw new Error(`dcsc_scale_out failed: ${text.slice(0, 240)}`);
  return parsed;
}

function commandLine(argv = process.argv.slice(2)): { summaryPath: string; releaseStrict: boolean } {
  let summaryPath = process.env.DCSC_VERIFY_SUMMARY ?? 'artifacts/verify-fixes-summary.json';
  let releaseStrict = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--summary') {
      const value = argv[index + 1];
      if (!value) throw new Error('--summary requires a file path.');
      summaryPath = value;
      index += 1;
    } else if (argument === '--allow-blocked') {
      releaseStrict = false;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { summaryPath: resolve(summaryPath), releaseStrict };
}

function writeSummary(summaryPath: string, releaseStrict: boolean): {
  failed: number;
  blocked: number;
  exitCode: number;
} {
  const failed = results.filter((result) => result.status === 'fail').length;
  const blockedCount = results.filter((result) => result.status === 'blocked').length;
  const passed = results.filter((result) => result.status === 'pass').length;
  const exitCode = failed > 0 ? 1 : releaseStrict && blockedCount > 0 ? 2 : 0;
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseStrict,
    outcome: failed > 0 ? 'failed' : blockedCount > 0 ? 'blocked' : 'passed',
    exitCode,
    totals: { checks: results.length, passed, failed, blocked: blockedCount },
    results,
  };
  fs.mkdirSync(dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`Machine-readable summary: ${summaryPath}`);
  return { failed, blocked: blockedCount, exitCode };
}

/**
 * Reads scope-comparison signals from CFXML.
 *
 * CFXML has no one-element-per-configuration marker. A configured product can
 * emit several attached service lines, so use these only to compare otherwise
 * identical single- and multi-configuration exports.
 */
function productsInXml(xmlPath: string): { topLevelLines: number; partBlocks: number } {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  return {
    // ProductLineItem is a top-level product/service line. It is useful for
    // comparing scope, but is not itself a configuration count: one configured
    // product can emit several attached service lines.
    topLevelLines: (xml.match(/<ProductLineItem>/g) ?? []).length,
    partBlocks: (xml.match(/<ProductIdentification/g) ?? []).length,
  };
}

async function exportTo(
  service: DcscService,
  handle: string,
  fileName: string,
  scope: 'auto' | 'configuration' | 'workspace',
) {
  const out = await service.exportZip(handle, {
    fileTypes: ['XML', 'QUOTE'],
    fileName,
    ctx: service.newCtx(),
    scope,
  });
  const bundle = await writeExportBundle(out.stream, fileName, service.config);
  return { out, bundle };
}

async function launchCurrentCto(service: DcscService, productCode: string, label: string) {
  const modes = await service.modesContaining(service.newCtx(), [productCode]);
  const currentMode = modes.get(productCode.toUpperCase())?.[0];
  if (!currentMode) throw new Error(`${productCode} is absent from every current solution catalog.`);
  const ctx = service.newCtx();
  const solution = await service.resolveSolution(ctx, currentMode);
  const session = await service.launch({ productCode, mode: 'cto', solution, ctx, label });
  return { session, solution, currentMode };
}

async function main() {
  const cli = commandLine();
  activeCli = cli;
  const config = isolateRuntime(loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'error' }));
  configureLogger(config.logLevel);
  const service = new DcscService(config);
  const handlers = registeredHandlers(service);

  // ---------------------------------------------------------------- offline
  console.log('\n[0] Offline: density advisory across cooling types');
  check(
    'air-cooled 46.8kW rack is flagged',
    assessRackDensity(46.8, 'air')?.level === 'containment-required',
    `level=${assessRackDensity(46.8, 'air')?.level}`,
  );
  check(
    'direct-water rack is exempt',
    assessRackDensity(80, 'direct water') === undefined,
    'no advisory for DWC, as expected',
  );

  // ------------------------------------------------- shape 1: CTO + clones
  console.log('\n[1] CTO B200 node, cloned into a multi-config workspace');
  const { session: node, currentMode: b200Mode } = await launchCurrentCto(
    service,
    '7DM9CTO1WW',
    'verify B200',
  );
  const ws = node.workspaceId;
  console.log(`      workspace=${ws} node=${node.id} mode=${b200Mode} $${node.raw.totalPrice}`);

  const { clones } = await service.cloneConfiguration({ sessionHandle: node.id, count: 2 });
  const distinctIds = new Set([node.configurationId, ...clones.map((c) => c.configurationId)]);
  check(
    'clone creates distinct DCSC configuration ids',
    distinctIds.size === 3,
    `${distinctIds.size} unique configurationIds across 3 configurations`,
  );
  check(
    'clones price identically to the source',
    clones.every((c) => c.raw.totalPrice === node.raw.totalPrice),
    `source=$${node.raw.totalPrice} clones=${clones.map((c) => `$${c.raw.totalPrice}`).join(',')}`,
  );
  check(
    'clones carry the same selected feature codes',
    clones.every((c) => c.index.selected.size === node.index.selected.size),
    `source has ${node.index.selected.size} selected codes; clones ${clones
      .map((c) => c.index.selected.size)
      .join(',')}`,
  );

  // -------------------------------- shape 2: export scope, no racks present
  console.log('\n[2] Export scope on a 3-config workspace with no racks');
  let singleCount: ReturnType<typeof productsInXml> | undefined;
  try {
    const single = await exportTo(service, node.id, 'verify-scope-single', 'auto');
    const counted = productsInXml(single.bundle.xml!);
    singleCount = counted;
    check(
      'configuration handle reports exactly one exported configuration',
      single.out.scope === 'configuration' &&
        single.out.configurationsExported === 1 &&
        counted.topLevelLines > 0,
      `scope=${single.out.scope}; CFXML carries ${counted.topLevelLines} top-level product/service lines ` +
        `and ${counted.partBlocks} part blocks (${single.bundle.bytes}B zip)`,
    );
  } catch (err) {
    check('configuration-scope export', false, (err as Error).message.slice(0, 200));
  }

  try {
    const whole = await exportTo(service, ws, 'verify-scope-workspace', 'auto');
    const counted = productsInXml(whole.bundle.xml!);
    check(
      'workspace handle exports every configuration and proportionally more CFXML lines',
      whole.out.scope === 'workspace' &&
        whole.out.configurationsExported === 3 &&
        singleCount !== undefined &&
        counted.topLevelLines === singleCount.topLevelLines * 3 &&
        counted.partBlocks === singleCount.partBlocks * 3,
      `scope=${whole.out.scope}; CFXML carries ${counted.topLevelLines} top-level product/service lines ` +
        `and ${counted.partBlocks} part blocks — 3x the single-scope export`,
    );
  } catch (err) {
    check(
      'workspace-scope export without racks',
      false,
      `multi-config export is rejected even without racks: ${(err as Error).message.slice(0, 160)}`,
    );
  }

  // ------------------------------------ shape 3: racks, PDUs and line cords
  console.log('\n[3] Rack: PDU selection, line cord discovery, export fallback');
  try {
    const layout = await service.addRack(ws, '7D6DCTO1WW', service.newCtx());
    const rackId = String(layout.racks[0]?.id ?? '');
    const rackSession = service.sessions.findByConfigurationId(ws, rackId);

    const before = listPduCatalog({ index: rackSession!.index });
    const cordsBefore = before.options.filter((o) => o.section.toUpperCase() === 'LINECORD');
    const nonPdu = before.options.filter((o) => o.section.toUpperCase() !== 'PDU');
    const firstCordAt = nonPdu.findIndex((o) => o.section.toUpperCase() === 'LINECORD');

    const currentPdu = before.options.find((option) => option.section.toUpperCase() === 'PDU');
    if (!currentPdu) throw new Error('Current rack Power graph has no selectable PDU.');
    const pdu = await service.configurePdu(ws, rackId, {
      pduCode: currentPdu.code,
      quantity: 4,
      ctx: service.newCtx(),
    });
    const cordsAfter = pdu.powerReadiness?.availableLineCords ?? [];

    check(
      'line cords exist on the rack tree and sit past the old slice(0,20) cutoff',
      cordsBefore.length > 0 && firstCordAt >= 20,
      `${cordsBefore.length} LINECORD rows; first at non-PDU index ${firstCordAt} of ${nonPdu.length} ` +
        '(the flat 20-row truncation is what hid them, not a dependency)',
    );
    check(
      'line cords become discoverable after selecting a PDU',
      cordsAfter.length > 0,
      cordsAfter.length > 0
        ? `${cordsAfter.length} available, e.g. ${cordsAfter
            .slice(0, 3)
            .map((c) => `${c.code} ${c.description.slice(0, 40)}`)
            .join(' | ')}`
        : 'none appeared — investigate the rack Power tab directly',
    );
    check(
      'rack with PDUs and no line cord is reported incomplete',
      pdu.powerReadiness?.complete === false,
      `complete=${pdu.powerReadiness?.complete} warning="${(pdu.powerReadiness?.warning ?? '').slice(0, 90)}…"`,
    );

    // Actually fix the rack, then confirm the warning clears.
    const cord = cordsAfter[0];
    if (cord) {
      const fixed = await service.configurePdu(ws, rackId, {
        cordCode: cord.code,
        quantity: 4,
        ctx: service.newCtx(),
      });
      check(
        'adding line cords clears the incompleteness warning',
        fixed.powerReadiness?.complete === true,
        `complete=${fixed.powerReadiness?.complete} after ${cord.code} x4, rack $${fixed.totalPrice}`,
      );
    }

    await service.placeInRack(ws, { rackId, sessionId: node.id, ctx: service.newCtx() });

    const before5xx = Date.now();
    const racked = await exportTo(service, ws, 'verify-rack-export', 'workspace');
    const rackXml = racked.bundle.xml ? fs.readFileSync(racked.bundle.xml, 'utf8') : '';
    check(
      'rack-bearing export succeeds in one request and retains rack data',
      racked.out.rackDataOmitted === false && /7D6D-CTO1WW/i.test(rackXml),
      `rackDataOmitted=${racked.out.rackDataOmitted}, took ${Date.now() - before5xx}ms, ` +
        `${racked.bundle.bytes}B`,
    );
  } catch (err) {
    check('rack phase', false, (err as Error).message.slice(0, 220));
  }

  // ---------------------- shape 4: a current product in a different solution mode
  console.log('\n[4] Current General Purpose CTO discovered from its catalog');
  try {
    const gpCtx = service.newCtx();
    const gp = await service.resolveSolution(gpCtx, 'General Purpose');
    const gpCatalog = await service.catalog(gpCtx, gp);
    const currentGp = searchCatalog(gpCatalog, {
      query: 'SR630 V3',
      type: 'CTO',
      limit: 10,
    }).find((entry) => !entry.withdrawn) ?? gpCatalog.entries.find((entry) =>
      !entry.withdrawn && entry.type.toUpperCase() === 'CTO');
    if (!currentGp) throw new Error('General Purpose catalog has no current CTO product.');
    const gpSession = await service.launch({
      productCode: currentGp.code,
      mode: 'cto',
      solution: gp,
      ctx: service.newCtx(),
      label: 'verify current General Purpose CTO',
    });
    const gpExport = await exportTo(service, gpSession.id, 'verify-general-purpose', 'configuration');
    check(
      'General Purpose CTO launches and exports at configuration scope',
      gpExport.out.configurationsExported === 1 && (gpExport.bundle.bytes ?? 0) > 0,
      `${currentGp.code} $${gpSession.raw.totalPrice} → ${gpExport.bundle.bytes}B zip, ` +
        `scope=${gpExport.out.scope}`,
    );
  } catch (err) {
    check('General Purpose mode', false, (err as Error).message.slice(0, 220));
  }

  // ------------------------------------------- shape 5: LFO preconfigured
  console.log('\n[5] LFO preconfigured model');
  try {
    const lfoCtx = service.newCtx();
    const gpSolution = await service.resolveSolution(lfoCtx, 'General Purpose');
    const catalog = await service.catalog(lfoCtx, gpSolution);
    const lfo = searchCatalog(catalog, { query: 'SR630 V3', type: 'LFO', limit: 5 })[0];
    if (!lfo) {
      check('LFO shape', false, 'no LFO model found to test');
    } else {
      const lfoSession = await service.launch({
        productCode: lfo.code,
        mode: 'lfo',
        solution: gpSolution,
        ctx: service.newCtx(),
        label: 'verify LFO',
      });
      const lfoExport = await exportTo(service, lfoSession.id, 'verify-lfo', 'auto');
      check(
        'LFO launches and exports through the lfo endpoint family',
        (lfoExport.bundle.bytes ?? 0) > 0,
        `${lfo.code} $${lfoSession.raw.totalPrice} → ${lfoExport.bundle.bytes}B, scope=${lfoExport.out.scope}`,
      );
    }
  } catch (err) {
    check('LFO shape', false, (err as Error).message.slice(0, 220));
  }

  // ------------------------------- shape 6: GB300 tray in the MGX cabinet
  console.log('\n[6] GB300 tray sized against the 48U MGX rack');
  try {
    const { session: tray } = await launchCurrentCto(service, '7DLZCTO2WW', 'verify GB300');
    const scaleOut = handlers.get('dcsc_scale_out');
    if (!scaleOut) throw new Error('dcsc_scale_out is not registered.');
    const plan = parseToolReply(await scaleOut({
      session: tray.id,
      nodes: 18,
      rackCode: '7DJVCTO2WW',
    }));
    const powerPerRack = plan['powerPerRack'] as { maxKW?: number } | undefined;
    const maxRackKW = powerPerRack?.maxKW;
    const advisory = maxRackKW === undefined ? undefined : assessRackDensity(maxRackKW, 'direct water');
    check(
      'non-standard cabinet sizes against DCSC placement rules',
      Number(plan['nodesPerRack'] ?? 0) > 0,
      `${plan['nodesPerRack']}/rack, ${plan['racksNeeded']} rack(s) for 18 trays, ` +
        `${powerPerRack?.maxKW}kW max per rack`,
    );
    if (maxRackKW === undefined) {
      blocked(
        'GB300 scale-out includes DCSC power data',
        'upstream-unavailable',
        'Current DCSC launch/derive returned powerReportResponse=null; numeric rack power remains unverified.',
      );
      blocked(
        'liquid-cooled MGX rack raises no cooling advisory when power is available',
        'dependency-blocked',
        'No DCSC numeric rack-power value exists, so the DWC advisory cannot be evaluated.',
      );
      const powerNote = typeof plan['powerNote'] === 'string' ? plan['powerNote'] : '';
      check(
        'GB300 unavailable power is explicit and does not produce a cooling verdict',
        /no power report/i.test(powerNote) && /unknown/i.test(powerNote) && plan['coolingAdvisory'] === undefined,
        `powerNote=${JSON.stringify(powerNote)}; coolingAdvisory=${JSON.stringify(plan['coolingAdvisory'])}`,
      );
    } else {
      check(
        'GB300 scale-out includes DCSC power data',
        maxRackKW > 0,
        `maxKW=${maxRackKW}`,
      );
      check(
        'liquid-cooled MGX rack raises no cooling advisory when power is available',
        maxRackKW > 0 && advisory === undefined,
        `maxKW=${maxRackKW} with DWC → ${advisory === undefined ? 'no advisory' : advisory.level}`,
      );
      check(
        'GB300 available power is not mislabeled unavailable',
        plan['powerNote'] === undefined,
        `powerNote=${JSON.stringify(plan['powerNote'])}`,
      );
    }
  } catch (err) {
    check('GB300 / MGX shape', false, (err as Error).message.slice(0, 220));
  }

  // ----------------------------------------------------------- validate
  console.log('\n[7] Validation scope honesty');
  try {
    const v = await service.validate(ws, service.newCtx());
    check(
      'validate reports what it actually covered',
      v.validatedScope !== undefined,
      `scope=${v.validatedScope.scope} configs=${v.validatedScope.configurations} ` +
        `racks ${v.validatedScope.racksValidated}/${v.validatedScope.racksInSolution} — "${v.validatedScope.covers.slice(0, 110)}"`,
    );
    check(
      'headroom is grouped per configuration, not a flat list',
      Array.isArray(v.headroom) && v.headroom.every((h) => typeof h.configuration === 'string'),
      `${v.headroom.length} group(s), each labelled with its configuration and breached list`,
    );
  } catch (err) {
    check('validate', false, (err as Error).message.slice(0, 220));
  }

  const failed = results.filter((result) => result.status === 'fail');
  const blockedResults = results.filter((result) => result.status === 'blocked');
  console.log(`\n${'='.repeat(70)}`);
  console.log(
    `${results.length - failed.length - blockedResults.length}/${results.length} checks passed; ` +
      `${failed.length} failed; ${blockedResults.length} blocked`,
  );
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  for (const result of blockedResults) {
    console.log(`  BLOCKED (${result.reason}): ${result.name} — ${result.detail}`);
  }
  await service.close();
  const summary = writeSummary(cli.summaryPath, cli.releaseStrict);
  process.exitCode = summary.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    results.push({
      name: 'verification script completed',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
    if (activeCli) {
      try {
        writeSummary(activeCli.summaryPath, activeCli.releaseStrict);
      } catch (summaryError) {
        console.error(`Could not write verification summary: ${String(summaryError)}`);
      }
    }
    process.exitCode = 1;
  });
}
