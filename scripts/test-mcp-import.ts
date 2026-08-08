import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { DcscHttpClient, RequestBudget } from '../src/http/request.js';
import { configureLogger, newCorrId } from '../src/http/trace.js';
import { DcscService } from '../src/mcp/service.js';

async function main() {
  const config = loadConfig({ logLevel: 'info' });
  configureLogger(config.logLevel);
  const http = new DcscHttpClient(config);
  const budget = new RequestBudget(100);
  const service = new DcscService(config, http);

  try {
    const xmlContent = readFileSync('artifacts/mcp-export-test.xml', 'utf8');
    const ctx = service.newCtx();

    console.log('Testing DcscService.importConfig with mcp-export-test.xml...');
    const result = await service.importConfig({
      content: xmlContent,
      ctx,
      mode: 'cto',
    });

    console.log('\nIMPORT SUCCESSFUL!');
    console.log(`Workspace ID: ${result.workspaceId}`);
    console.log(`Sessions count: ${result.sessions.length}`);
    for (const s of result.sessions) {
      console.log(`- Session ${s.id}: Code=${s.product.code}, Price=${s.raw.totalPrice}`);
    }
  } finally {
    await service.close();
  }
}

main().catch((err) => {
  console.error('MCP import failed:', err);
  process.exitCode = 1;
});
