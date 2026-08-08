import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
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
  console.log('Launching 7DHCCTO1WW...');
  const session = await service.launch({
    productCode: '7DHCCTO1WW',
    mode: 'cto',
    solution: sol,
    ctx,
  });

  console.log('Exporting ZIP via service.exportZip...');
  const res = await service.exportZip(session.id, {
    fileName: 'mcp-test-7dhccto1ww',
    fileTypes: ['XML'],
    ctx,
  });

  const yauzl = await import('yauzl');
  const zipBuf = Buffer.from(await res.stream.arrayBuffer());
  const xmlSavePath = path.resolve('artifacts/mcp_test_7dhccto1ww.xml');

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
              writeFileSync(xmlSavePath, data);
              console.log(`Saved exported XML to ${xmlSavePath} (${data.length} bytes)`);
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
