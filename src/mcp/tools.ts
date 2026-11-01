import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerCatalogTools } from './catalogTools.js';
import { registerConfigurationTools } from './configurationTools.js';
import { registerFabricPowerTools } from './fabricPowerTools.js';
import { registerImportExportTools } from './importExportTools.js';
import { registerManualCablingTools } from './manualCablingTools.js';
import { registerPciWizardTools } from './pciWizardTools.js';
import { registerPowerControlTools } from './powerControlTools.js';
import { registerRackLayoutTools } from './rackLayoutTools.js';
import { registerReconciliationTools } from './reconciliationTools.js';
import { registerRecoveryTools } from './recoveryTools.js';
import { registerReferenceSolutionTools } from './referenceSolutionTools.js';
import type { DcscService } from './service.js';
import { registerSessionTools } from './sessionTools.js';
import { registerStandaloneTools } from './standaloneTools.js';
import { registerStorageTools } from './storageTools.js';
import { registerStorageWizardTools } from './storageWizardTools.js';
import { registerCapabilitiesResource } from './toolSupport.js';
import { registerUnconfiguredTools } from './unconfiguredTools.js';
import { registerValidationTools } from './validationTools.js';
import { registerVlhTools } from './vlhTools.js';

export function registerTools(server: McpServer, service: DcscService): void {
  registerCapabilitiesResource(server);

  registerReferenceSolutionTools(server, service);
  registerUnconfiguredTools(server, service);
  registerStorageTools(server, service);
  registerManualCablingTools(server, service);
  registerPowerControlTools(server, service);
  registerPciWizardTools(server, service);
  registerStorageWizardTools(server, service);
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
}
