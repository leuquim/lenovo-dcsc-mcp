#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/load.js';
import { configureLogger, logger } from '../http/trace.js';
import { DcscService } from './service.js';
import { registerTools } from './tools.js';
async function main() {
    const config = loadConfig();
    configureLogger(config.logLevel);
    if (config.logRawErrors) {
        logger().warn('DCSC_LOG_RAW_ERRORS is enabled — upstream error bodies will be logged unredacted. Do not use this in production.');
    }
    const service = new DcscService(config);
    const server = new McpServer({ name: 'lenovo-dcsc', version: '0.1.0' }, {
        instructions: 'Drives the Lenovo Data Center Solution Configurator (DCSC).\n\n' +
            'Typical flow: dcsc_find_products -> dcsc_launch -> dcsc_list_options -> dcsc_get_feature -> dcsc_get_configuration.\n\n' +
            'Important: all prices are LIST prices for the configured country and currency, retrieved anonymously. ' +
            'They are not a quote, and partner or bid pricing is not available without a Lenovo login. ' +
            'Always state this when reporting a price to a user.',
    });
    registerTools(server, service);
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown)
            return;
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
main().catch((err) => {
    logger().error({ err: err instanceof Error ? err.stack : String(err) }, 'Fatal startup error');
    process.exit(1);
});
//# sourceMappingURL=server.js.map