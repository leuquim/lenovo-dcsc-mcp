import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient } from '../src/http/request.js';
import { configureLogger } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';
import { buildExportData } from '../src/domain/reduce.js';

async function main() {
  const config = loadConfig({ logLevel: 'error' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const service = new DcscService(config, http);
  const ctx = service.newCtx();

  const sol = await service.resolveSolution(ctx, 'HPC and AI - Systems');
  const session = await service.launch({
    productCode: '7DHCCTO1WW',
    mode: 'cto',
    solution: sol,
    ctx,
  });

  await service.configure(session, [], ctx);

  const mcpData = buildExportData({
    raw: session.raw,
    config: session.reduced,
    solution: sol,
    fileTypes: ['XML'],
    validationMode: 'guided',
  });

  const webRaw = readFileSync('artifacts/captured_export_network/export_post_data.txt', 'utf8');
  const webData = JSON.parse(webRaw);

  console.log('=== Web UI Data Keys ===');
  console.log(Object.keys(webData).sort());

  console.log('\n=== MCP Data Keys ===');
  console.log(Object.keys(mcpData).sort());

  const webConfig = webData.configurations[0];
  const mcpConfig = (mcpData.configurations as any[])[0];

  console.log('\n=== Web UI Config Object Keys ===');
  console.log(Object.keys(webConfig).sort());

  console.log('\n=== MCP Config Object Keys ===');
  console.log(Object.keys(mcpConfig).sort());

  // Find keys missing in MCP config object
  const missingInMcpConfig = Object.keys(webConfig).filter((k) => !(k in mcpConfig));
  console.log('\n=== Keys present in Web UI Config but MISSING in MCP Config ===');
  console.log(missingInMcpConfig);

  // Print values for missing keys
  missingInMcpConfig.forEach((k) => {
    console.log(`  ${k}:`, JSON.stringify(webConfig[k]));
  });

  await service.close();
}

main().catch(console.error);
