import { statSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import yauzl from 'yauzl';

import { loadConfig } from '../src/config/load.js';
import { fetchSolutionModes, toSolutionContext } from '../src/domain/context.js';
import {
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

const PRODUCT_CODE = '7DG9CTO1WW'; // ThinkSystem SR630 V4-3yr Base Warranty
const QUANTITY = 8;
const OUT_DIR = 'artifacts';

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'warn' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const budget = new RequestBudget(config.pacing.perToolRequestBudget);
  const base = { corrId: newCorrId(), locale: config.locale, budget };

  try {
    const modes = await fetchSolutionModes(http, base);
    const solution = toSolutionContext(modes, 'General Purpose');
    const ctx = { ...base, solution };

    console.log(`1. Launching configuration for ${PRODUCT_CODE} (SR630 V4)...`);
    const launched = await http.send({
      endpoint: 'cto_launch',
      method: 'POST',
      path: `/ctos/${PRODUCT_CODE}/launch`,
      query: { hardwareOnly: false, controlExpressModal: false },
      body: { kind: 'json', value: {} },
      responseKind: 'json',
      ctx,
    });

    let raw = launched.raw as RawConfiguration;
    raw.quantity = QUANTITY;
    const configurationId = newConfigurationId(config.locale.country);
    let reduced = reduceConfiguration(raw, configurationId);

    console.log(`   Initial total unit price: ${raw.totalPrice} ${config.locale.currency}`);
    console.log(`   Set quantity: ${QUANTITY}`);

    // AutoDerive priming call
    console.log('\n2. Priming autoDerive...');
    const deriveRes = await http.send({
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

    const body = deriveRes.raw as Record<string, unknown>;
    const configs = body.configurations as RawConfiguration[] | undefined;
    if (configs?.[0]) {
      raw = configs[0];
      raw.quantity = QUANTITY;
      reduced = reduceConfiguration(raw, configurationId);
      console.log(`   Updated total unit price: ${raw.totalPrice} ${config.locale.currency}`);
    }

    // Export ZIP
    console.log('\n3. Exporting quote and CFXML...');
    const fileTypes: ExportFileType[] = ['XML', 'QUOTE', 'SUMMARY', 'POWER_REPORT'];
    const exportData = buildExportData({
      raw,
      config: reduced,
      solution,
      fileTypes,
      validationMode: 'guided',
    });
    const form = buildExportForm({
      data: exportData,
      groups: buildGroups(raw, configurationId),
    });

    const res = await http.send({
      endpoint: 'cto_export_zip',
      method: 'POST',
      path: '/ctos/export_zip',
      query: { fileName: `SR630_V4_${QUANTITY}x` },
      requiresSolution: false,
      body: { kind: 'form', fields: form },
      responseKind: 'stream',
      timeoutClass: 'export',
      ctx: { ...ctx, solution: undefined },
    });

    const zipPath = path.join(OUT_DIR, `SR630_V4_${QUANTITY}x.zip`);
    await pipeline(res.stream, createWriteStream(zipPath));
    console.log(`   Exported ZIP to: ${zipPath} (${statSync(zipPath).size} bytes)`);

    // Extract XLSX
    let xlsxPath: string | null = null;
    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        zip.on('entry', (entry) => {
          if (entry.fileName.endsWith('.xlsx')) {
            const dest = path.join(OUT_DIR, entry.fileName);
            zip.openReadStream(entry, (err, readStream) => {
              if (err || !readStream) return reject(err);
              const writeStream = createWriteStream(dest);
              readStream.pipe(writeStream);
              writeStream.on('finish', () => {
                xlsxPath = dest;
                console.log(`   Extracted XLSX to: ${dest} (${entry.uncompressedSize} bytes)`);
                zip.readEntry();
              });
            });
          } else {
            zip.readEntry();
          }
        });
        zip.on('end', () => resolve());
        zip.readEntry();
      });
    });

    if (xlsxPath) {
      console.log(`\n4. Opening XLSX file: ${xlsxPath}`);
      try {
        execSync(`xdg-open "${xlsxPath}" &`, { stdio: 'ignore' });
        console.log('   Successfully launched xdg-open for XLSX!');
      } catch (e) {
        console.error('   Could not open with xdg-open:', e);
      }
    } else {
      console.error('   No XLSX file found in ZIP archive.');
    }

  } finally {
    await http.close();
  }
}

main().catch((err) => {
  console.error('Configuration creation failed:', err);
  process.exitCode = 1;
});
