import { readFileSync, writeFileSync } from 'node:fs';
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

  const webPostRaw = readFileSync('artifacts/captured_export_network/export_post_data.txt', 'utf8');
  const webData = JSON.parse(webPostRaw);
  webData.exportFileTypes = ['XML'];
  webData.cloneDependencyColor = {};

  const sol = await service.resolveSolution(ctx, 'HPC and AI - Systems');

  console.log('Sending live Web UI captured export payload to DCSC /export_zip API...');
  const formPayload = {
    fileName: 'web_official_native_7dhccto1ww',
    data: JSON.stringify(webData),
    crnId: '',
    userGeneratedConfigId: '',
    lfoCode: '',
    cancelDownload: 'false',
    multipleProductData: '[]',
    excelData: '',
    groups: JSON.stringify([
      {
        name: 'Config 1',
        parent: null,
        index: -1,
        depth: 1,
        products: [
          {
            id: webData.configurations[0].id,
            code: '7DHCCTO1WW',
            description: 'ThinkSystem SR685a V3 - 3 Year Base Warranty for AI',
            quantity: 1,
            price: 668234.01,
            unitPrice: 668234.01,
            prices: [],
            type: 'hardware',
            groupId: 'Config 1',
            showPrice: true,
            priceNotAvailable: false,
            asMultiProd: false,
            specialBid: false,
            shippingStatus: [],
          },
        ],
      },
    ]),
    integrationParams: JSON.stringify({
      returnUrl: null,
      site: '',
      role: '',
      iad: false,
      error: null,
      context: '',
      serviceWithProductNumber: false,
    }),
    image: '',
    user: '',
    'dcsc-isFromIntegration': 'false',
    serviceAndorRequest: '',
    uuid: '',
  };

  const exportRes = await http.send({
    endpoint: 'cto_export_zip',
    method: 'POST',
    path: '/ctos/export_zip',
    query: {
      fileName: 'web_official_native_7dhccto1ww',
      geo: 'NA',
      language: 'en',
      country_or_region: 'US',
      currency: 'USD',
      solutionMode: 'HPC and AI - Systems',
      masterSlices: 'HPCGP,HPCRYO,HPCGPALL,HPCGPRYO',
      sbSlices: '',
      countryName: 'United States',
      current_country_or_region: 'US',
      _request: 'web',
    },
    body: { kind: 'form', fields: formPayload },
    responseKind: 'stream',
    ctx: { ...ctx, solution: sol },
  });

  const yauzl = await import('yauzl');
  const zipBuf = Buffer.from(await exportRes.stream.arrayBuffer());
  console.log('Downloaded zip length:', zipBuf.length);
  const xmlSavePath = path.resolve('artifacts/web_official_native_7dhccto1ww.xml');

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
              console.log(`Saved official Web UI XML to ${xmlSavePath} (${data.length} bytes)`);
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
