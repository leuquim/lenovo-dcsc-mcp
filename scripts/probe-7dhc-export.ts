import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';

async function main() {
  const config = loadConfig({ logLevel: 'error' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();

  const sol = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  console.log('Resolved Solution:', sol);

  const session = await service.launch({
    productCode: '7DHCCTO1WW',
    mode: 'cto',
    solution: sol,
    ctx,
  });

  console.log('Launched 7DHCCTO1WW:', session.id, 'Price:', session.raw.totalPrice);
  await service.configure(session, [], ctx);

  const zipFileName = 'test-7dhc';
  const exportRes = await service.exportZip(session.id, {
    fileName: zipFileName,
    fileTypes: ['XML'],
    validationMode: 'guided',
    ctx,
  });

  const yauzl = await import('yauzl');
  const zipBuf = Buffer.from(await exportRes.stream.arrayBuffer());

  await new Promise<void>((resolve) => {
    yauzl.fromBuffer(zipBuf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return resolve();
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('.xml')) {
          zip.openReadStream(entry, (err, readStream) => {
            if (err || !readStream) return resolve();
            let data = '';
            readStream.on('data', (c) => (data += c));
            readStream.on('end', () => {
              console.log('\n=== Exported XML Header Snippet ===');
              console.log(data.slice(0, 1000));
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

  await service.close();
}

main().catch(console.error);
