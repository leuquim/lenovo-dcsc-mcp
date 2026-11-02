import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerCatalogTools } from './catalogTools.js';
import { registerConfigurationTools } from './configurationTools.js';
import { registerFabricPowerTools } from './fabricPowerTools.js';
import { registerImportExportTools } from './importExportTools.js';
import { registerManualCablingTools } from './manualCablingTools.js';
import { registerPowerControlTools } from './powerControlTools.js';
import { registerRackLayoutTools } from './rackLayoutTools.js';
import { registerReconciliationTools } from './reconciliationTools.js';
import { registerRecoveryTools } from './recoveryTools.js';
import { registerReferenceSolutionTools } from './referenceSolutionTools.js';
import { registerSessionTools } from './sessionTools.js';
import { registerStandaloneTools } from './standaloneTools.js';
import { registerStorageTools } from './storageTools.js';
import { registerCapabilitiesResource } from './toolSupport.js';
import { registerWizardTools } from './wizardTools.js';
import { registerValidationTools } from './validationTools.js';
import { registerVlhTools } from './vlhTools.js';
export function registerTools(server, service) {
    registerCapabilitiesResource(server);
    registerReferenceSolutionTools(server, service);
    registerStorageTools(server, service);
    registerManualCablingTools(server, service);
    registerPowerControlTools(server, service);
    registerStandaloneTools(server, service);
    registerReconciliationTools(server, service);
    registerValidationTools(server, service);
    registerRecoveryTools(server, service);
    registerCatalogTools(server, service);
    registerSessionTools(server, service);
    registerRackLayoutTools(server, service);
    registerFabricPowerTools(server, service);
    registerConfigurationTools(server, service);
    registerImportExportTools(server, service);
    registerVlhTools(server, service);
    registerWizardTools(server, service);
    compactToolList(server);
}
/** Drops list-time boilerplate (draft-07 marker, task-support flag, safe-integer bound) that every definition repeats. */
function stripBoilerplate(node) {
    if (Array.isArray(node)) {
        node.forEach(stripBoilerplate);
        return;
    }
    if (node === null || typeof node !== 'object')
        return;
    const record = node;
    if (record['maximum'] === Number.MAX_SAFE_INTEGER)
        delete record['maximum'];
    Object.values(record).forEach(stripBoilerplate);
}
export function compactToolList(server) {
    const inner = server.server;
    const listTools = inner?._requestHandlers?.get('tools/list');
    if (!listTools)
        return;
    server.server.removeRequestHandler('tools/list');
    server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const result = await listTools(request, extra);
        for (const tool of result.tools) {
            delete tool['execution'];
            delete tool['inputSchema']['$schema'];
            stripBoilerplate(tool['inputSchema']);
        }
        return result;
    });
}
//# sourceMappingURL=tools.js.map