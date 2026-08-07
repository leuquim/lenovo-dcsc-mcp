/**
 * Live verification of the mutation + export round trip.
 *
 * launch -> change the processor via autoDerive -> export a populated ZIP.
 * Proves the contracts recovered from the browser capture actually work from
 * plain Node.
 *
 * Run with: npx tsx scripts/export-smoke.ts
 */
import { writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import { loadConfig } from '../src/config/load.js';
import { fetchSolutionModes, toSolutionContext } from '../src/domain/context.js';
import {
  applyChange,
  buildAutoDeriveRequest,
  buildExportData,
  buildExportForm,
  buildGroups,
  newConfigurationId,
  reduceConfiguration,
  type ExportFileType,
} from '../src/domain/reduce.js';
import { DcscHttpClient, RequestBudget } from '../src/http/request.js';
import { configureLogger, newCorrId } from '../src/http/trace.js';
import type { RawConfiguration } from '../src/model/types.js';

const OUT = 'artifacts';

async function main(): Promise<void> {
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const budget = new RequestBudget(config.pacing.perToolRequestBudget);
  const base = { corrId: newCorrId(), locale: config.locale, budget };

  try {
    const modes = await fetchSolutionModes(http, base);
    const solution = toSolutionContext(modes, 'General Purpose');
    const ctx = { ...base, solution };

    console.log('1. launch 7D73CTO1WW');
    const launched = await http.send({
      endpoint: 'cto_launch',
      method: 'POST',
      path: '/ctos/7D73CTO1WW/launch',
      query: { hardwareOnly: false, controlExpressModal: false },
      body: { kind: 'json', value: {} },
      responseKind: 'json',
      ctx,
    });
    const raw = launched.raw as RawConfiguration;
    console.log(`   total=${raw.totalPrice} ${config.locale.currency}`);

    const configurationId = newConfigurationId(config.locale.country);
    let reduced = reduceConfiguration(raw, configurationId);
    console.log(`   reduced to ${reduced.sections.length} sections (from full tree)`);

    const currentCpu = reduced.sections.find((s) => s.name === 'PROCESSOR')?.results[0];
    console.log(`   current CPU: ${currentCpu?.code}`);

    const derive = async (label: string): Promise<RawConfiguration | undefined> => {
      const res = await http.send({
        endpoint: 'cto_autoDerive',
        method: 'POST',
        path: '/ctos/autoDerive',
        query: { configurationId, entranceFlag: 'customize' },
        body: {
          kind: 'json',
          value: buildAutoDeriveRequest(reduced, { validationMode: 'guided' }),
        },
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
      });
      const body = res.raw as Record<string, unknown>;
      console.log(`   ${label} -> HTTP ${res.status} in ${res.durationMs}ms`);
      console.log(`      response keys: ${Object.keys(body).slice(0, 10).join(', ')}`);
      const configs = body.configurations as RawConfiguration[] | undefined;
      return configs?.[0];
    };

    // 2. The SPA runs an initial autoDerive on page load, with no delta. That
    // pass materialises the derived sections (fillers, labels, voltage, service
    // and software rows) that the launch response does not contain. Skipping it
    // and jumping straight to a change makes the rule engine return HTTP 500.
    console.log('\n2. initial autoDerive (no delta) — materialises derived sections');
    const primed = await derive('priming');
    if (primed) {
      reduced = reduceConfiguration(primed, configurationId);
      console.log(`      sections now: ${reduced.sections.length}`);
    }

    // 3. Now apply the real change.
    console.log('\n3. autoDerive: swap processor to BYWK (Xeon Gold 6530 32C 270W)');
    reduced = applyChange(reduced, {
      sectionName: 'PROCESSOR',
      code: 'BYWK',
      quantity: 1,
    });
    const updated = await derive('change');
    if (updated) {
      reduced = reduceConfiguration(updated, configurationId);
      console.log(`      new totalPrice = ${updated.totalPrice}`);
      console.log(`      PROCESSOR now: ${findSelected(updated, 'PROCESSOR').join(', ')}`);
    }

    // 3. Export with the format flags recovered from the capture.
    console.log('\n4. export_zip with exportFileTypes');
    const fileTypes: ExportFileType[] = ['XML', 'QUOTE', 'SUMMARY', 'POWER_REPORT'];
    const exportData = buildExportData({
      raw: updated ?? raw,
      config: reduced,
      solution,
      fileTypes,
      validationMode: 'guided',
    });
    const form = buildExportForm({
      data: exportData,
      groups: buildGroups(updated ?? raw, configurationId),
    });

    const res = await http.send({
      endpoint: 'cto_export_zip',
      method: 'POST',
      path: '/ctos/export_zip',
      // The export endpoint takes a minimal query — no geo/solutionMode/masterSlices.
      query: { fileName: 'mcp-export-test' },
      requiresSolution: false,
      body: { kind: 'form', fields: form },
      responseKind: 'stream',
      timeoutClass: 'export',
      ctx: { ...ctx, solution: undefined },
    });

    console.log(`   -> HTTP ${res.status}`);
    console.log(`   -> ${res.contentDisposition ?? '(no content-disposition)'}`);

    const path = `${OUT}/mcp-export-test.zip`;
    await pipeline(res.stream, createWriteStream(path));
    const { statSync } = await import('node:fs');
    const size = statSync(path).size;
    console.log(`   -> wrote ${path} (${size} bytes)`);

    const yauzl = await import('yauzl');
    await new Promise<void>((resolve, reject) => {
      yauzl.open(path, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        const names: string[] = [];
        zip.on('entry', (e) => {
          names.push(`${e.fileName} (${e.uncompressedSize} B)`);
          zip.readEntry();
        });
        zip.on('end', () => {
          console.log(`\n   ZIP CONTENTS (${names.length}):`);
          for (const n of names) console.log(`     - ${n}`);
          if (names.length === 0) console.log('     (EMPTY — exportFileTypes not accepted)');
          resolve();
        });
        zip.readEntry();
      });
    });

    writeFileSync(`${OUT}/export-form-sent.json`, JSON.stringify(exportData, null, 1));
    console.log(`\nBudget used: ${budget.used}/${budget.limit}`);
    console.log('EXPORT SMOKE DONE');
  } finally {
    await http.close();
  }
}

function findSelected(cfg: RawConfiguration, sectionName: string): string[] {
  const out: string[] = [];
  for (const tab of cfg.tabs ?? []) {
    for (const sub of tab.subTabs ?? []) {
      for (const s of sub.sections ?? []) {
        if (s.name !== sectionName) continue;
        for (const r of s.results ?? []) if (r.code) out.push(`${r.code} x${r.quantity ?? 1}`);
      }
    }
  }
  return out;
}

main().catch((err: unknown) => {
  console.error('\nEXPORT SMOKE FAILED');
  console.error(err);
  process.exitCode = 1;
});
