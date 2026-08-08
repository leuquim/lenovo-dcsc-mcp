import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient, RequestBudget } from '../src/http/request.js';
import { configureLogger, newCorrId } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';

interface BlueprintResult {
  name: string;
  code: string;
  description: string;
  totalPrice: number;
  currency: string;
  bomCount: number;
  sectionsCount: number;
  exportZipPath?: string;
  xmlPath?: string;
  reimportSuccess: boolean;
  reimportedPrice?: number;
  sampleOptions: Array<{ section: string; code: string; description: string; qty: number }>;
}

async function main(): Promise<void> {
  const outDir = 'artifacts/nvidia_ai_factory_blueprints';
  mkdirSync(outDir, { recursive: true });

  const config = loadConfig({ logLevel: process.env.DCSC_LOG_LEVEL ?? 'info' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();

  console.log('================================================================');
  console.log('      BUILDING NVIDIA BLUEPRINT AI FACTORY CONFIGURATIONS       ');
  console.log('================================================================\n');

  const hpcSolution = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const gpSolution = await service.resolveSolution(ctx, 'General Purpose');

  const blueprintsToBuild = [
    {
      name: 'Blueprint 1: NVIDIA B200 8-GPU AI Enterprise Factory Node',
      code: '7DM9CTO1WW',
      solution: hpcSolution,
      mode: 'cto' as const,
      description: 'ThinkSystem SR680a V3 with B200 8-GPU SXM Baseboard, Dual Intel Xeon CPUs, NVMe AI Storage, Quantum-2 NDR InfiniBand',
    },
    {
      name: 'Blueprint 2: Liquid-Cooled 8-GPU Direct Water Cooled Supernode',
      code: '7DJ5CTO1WW',
      solution: hpcSolution,
      mode: 'cto' as const,
      description: 'ThinkSystem SR780a V3 Direct Water Cooled 8-GPU HGX AI System with High-Density Cooling Manifold',
    },
    {
      name: 'Blueprint 3: AMD EPYC + NVIDIA HGX 8-GPU AI Acceleration Platform',
      code: '7DHCCTO1WW',
      // SR685a V3 is only catalogued under General Purpose; dcsc_find_products
      // returns nothing for it under HPC and AI. Launch does not enforce that,
      // so building it under HPC "works" and yields a byte-equivalent export --
      // but the model is genuinely outside the HPC catalog, and importing it
      // requires General Purpose. Build it where it actually lives.
      solution: gpSolution,
      mode: 'cto' as const,
      description: 'ThinkSystem SR685a V3 8-GPU SXM5 System driven by Dual AMD EPYC Processors',
    },
    {
      name: 'Blueprint 4: Next-Gen Grace Blackwell NVL72 DWC Compute Tray',
      code: '7DLZCTO2WW',
      solution: hpcSolution,
      mode: 'cto' as const,
      description: 'Lenovo NVIDIA GB300 4GPU Direct Water Cooled Compute Tray for MGX Rack Architectures',
    },
  ];

  const results: BlueprintResult[] = [];

  for (const bp of blueprintsToBuild) {
    console.log(`\n----------------------------------------------------------------`);
    console.log(`Building: ${bp.name} (${bp.code})`);
    console.log(`Description: ${bp.description}`);
    console.log(`----------------------------------------------------------------`);

    try {
      // 1. Launch configuration
      const session = await service.launch({
        productCode: bp.code,
        mode: bp.mode,
        solution: bp.solution,
        ctx,
      });

      console.log(`  Launched session: ${session.id}`);
      console.log(`  Initial List Price: $${session.raw.totalPrice?.toLocaleString()} USD`);

      // 2. Prime session with initial autoDerive if needed
      await service.configure(session, [], ctx);

      // 3. Inspect available options & sections
      const sections = session.reduced.sections;
      console.log(`  Configurator Sections available: ${sections.length}`);
      
      // Collect key selected options
      const sampleOptions: Array<{ section: string; code: string; description: string; qty: number }> = [];
      for (const sec of sections) {
        for (const res of sec.results) {
          const feat = session.index.features.find((f) => f.code === res.code);
          sampleOptions.push({
            section: sec.name,
            code: res.code,
            description: feat?.description ?? res.code,
            qty: res.quantity,
          });
        }
      }

      // Print first 10 selected components
      console.log(`  Key Components pre-selected by Lenovo DCSC Rules:`);
      sampleOptions.slice(0, 8).forEach((opt) => {
        console.log(`    - [${opt.section}] ${opt.code} x${opt.qty}: ${opt.description}`);
      });

      // 4. Export ZIP & CFXML
      const zipFileName = `nvidia-blueprint-${bp.code.toLowerCase()}`;
      const exportRes = await service.exportZip(session.id, {
        fileName: zipFileName,
        fileTypes: ['XML', 'QUOTE', 'SUMMARY'],
        validationMode: 'guided',
        ctx,
      });

      const yauzl = await import('yauzl');
      let extractedXml = '';
      const zipBuf = Buffer.from(await exportRes.stream.arrayBuffer());
      const zipPath = `${outDir}/${zipFileName}.zip`;
      writeFileSync(zipPath, zipBuf);
      console.log(`  Exported package to ${zipPath} (${zipBuf.length.toLocaleString()} bytes)`);

      await new Promise<void>((resolve) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
          if (err || !zip) return resolve();
          zip.on('entry', (entry) => {
            if (entry.fileName.endsWith('.xml')) {
              zip.openReadStream(entry, (err, readStream) => {
                if (err || !readStream) return resolve();
                let data = '';
                readStream.on('data', (c) => (data += c));
                readStream.on('end', () => {
                  extractedXml = data;
                  const xmlPath = `${outDir}/${zipFileName}.xml`;
                  writeFileSync(xmlPath, data);
                  console.log(`  Extracted CFXML 2.6 file: ${xmlPath} (${data.length.toLocaleString()} bytes)`);
                  resolve();
                });
              });
            } else {
              zip.readEntry();
            }
          });
          zip.readEntry();
        });
      });

      // 5. Test Re-Import of exported CFXML
      let reimportSuccess = false;
      let reimportedPrice: number | undefined;
      if (extractedXml) {
        console.log(`  Testing re-import of exported CFXML...`);
        const importRes = await service.importConfig({
          content: extractedXml,
          mode: bp.mode,
          ctx,
        });

        if (importRes.sessions.length > 0) {
          reimportSuccess = true;
          reimportedPrice = importRes.sessions[0]?.raw.totalPrice;
          console.log(`  Re-import SUCCESS! Re-imported Price: $${reimportedPrice?.toLocaleString()} USD`);
        }
      }

      results.push({
        name: bp.name,
        code: bp.code,
        description: bp.description,
        totalPrice: session.raw.totalPrice ?? 0,
        currency: 'USD',
        bomCount: sampleOptions.length,
        sectionsCount: sections.length,
        exportZipPath: `${outDir}/${zipFileName}.zip`,
        xmlPath: `${outDir}/${zipFileName}.xml`,
        reimportSuccess,
        reimportedPrice,
        sampleOptions,
      });

    } catch (err: any) {
      console.error(`  ERROR building ${bp.name}:`, err?.message || err);
    }
  }

  // Write summary report
  const summaryReport = {
    generatedAt: new Date().toISOString(),
    totalBlueprints: results.length,
    results: results.map((r) => ({
      name: r.name,
      code: r.code,
      totalPrice: `$${r.totalPrice.toLocaleString()} USD`,
      bomItemCount: r.bomCount,
      exportZip: r.exportZipPath,
      cfxml: r.xmlPath,
      reimportSuccess: r.reimportSuccess,
      reimportedPrice: r.reimportedPrice ? `$${r.reimportedPrice.toLocaleString()} USD` : 'N/A',
      keyComponents: r.sampleOptions.slice(0, 10),
    })),
  };

  writeFileSync(`${outDir}/blueprints_summary.json`, JSON.stringify(summaryReport, null, 2));
  console.log(`\n================================================================`);
  console.log(`  NVIDIA BLUEPRINT GENERATION COMPLETE (${results.length} BLUEPRINTS)`);
  console.log(`  Summary report written to ${outDir}/blueprints_summary.json`);
  console.log(`================================================================\n`);

  await service.close();
}

main().catch((err) => {
  console.error('Fatal blueprint error:', err);
  process.exitCode = 1;
});
