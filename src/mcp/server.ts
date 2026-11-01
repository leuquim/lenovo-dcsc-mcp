#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from '../config/load.js';
import { configureLogger, logger } from '../http/trace.js';
import { DcscService } from './service.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger(config.logLevel);

  if (config.logRawErrors) {
    logger().warn(
      'DCSC_LOG_RAW_ERRORS is enabled — upstream error bodies will be logged unredacted. Do not use this in production.',
    );
  }

  const service = new DcscService(config);

  const server = new McpServer(
    { name: 'lenovo-dcsc', version: '0.1.0' },
    {
      instructions:
        'Drives the Lenovo Data Center Solution Configurator (DCSC).\n\n' +
        'Workflow: dcsc_settings_get/dcsc_search -> dcsc_launch or dcsc_import -> dcsc_configuration_get/dcsc_configure -> dcsc_rack_add/dcsc_rack_edit/dcsc_floor_set -> network, cabling, storage, VLH, power -> dcsc_validate -> dcsc_export. Read the dcsc://docs/capabilities resource for the full guide.\n\n' +
        'Important: all prices are LIST prices for the configured country and currency, retrieved anonymously. ' +
        'They are not a quote, and partner or bid pricing is not available without a Lenovo login. ' +
        'Always state this when reporting a price to a user.',
    },
  );

  registerTools(server, service);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger().info({ signal }, 'Shutting down');
    void (async () => {
      await server.close();
      await service.close();
    })().then(() => process.exit(0), error => {
      logger().error({ err: error }, 'Shutdown failed');
      process.exit(1);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // stdout is the JSON-RPC channel from here on. All logging goes to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger().info({ host: config.host, locale: config.locale }, 'lenovo-dcsc MCP server ready');
}

main().catch((err: unknown) => {
  logger().error({ err: err instanceof Error ? err.stack : String(err) }, 'Fatal startup error');
  process.exit(1);
});
