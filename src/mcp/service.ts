import { downloadReferenceSolutionArtifact, referenceSolutions, launchReferenceSolution, retrieveConfigId, customizeSid, importConfig, exportZip, summaryInsights, exportWorkspace, shareUrlFields } from '../app/importExport.js';
import { generateConfigId, modesContaining, launch, configure, loadUnconfigured, setUnconfigured, setConfigurationControls, setQuantity, undo, closeSession } from '../app/launch.js';
import { inspectAutoFix, autoFix, validate, validationJobs, diffSessions } from '../app/validation.js';
import { inspectStorageWizard, setStorageWizard, inspectPciWizard, setPciWizard, inspectWorkspacePowerControls, setPowerControls, placeStorageNetwork, openStorageController, openStorageSwitch, assignStorageNetwork, addStorageNetwork, editStorageNetwork, reconfigureStorageNetwork, setNetworkPreferences } from '../app/storage.js';
import { assertTrustedWorkspace, proposeReconciliation, reconciliationProposal, acceptReconciliation } from '../app/reconciliation.js';
import { scaleOut, addRack, placeInRack, editLayout, placeOnFloor, setRackLock, copyRackItem, cloneConfiguration, configurePdu } from '../app/rack.js';
import { runAutoConnect, inspectManualCabling, inspectManualCableChoices, createNativeManualCabling, inspectNativeManualCabling, editManualCabling, addManualCabling, applyTopology } from '../app/cabling.js';
import { Runtime } from '../app/runtime.js';

type AppArgs<F> = F extends (rt: Runtime, ...args: infer A) => unknown ? A : never;

/** Facade over the app modules; tools and tests call these until they call the modules directly. */
export class DcscService extends Runtime {
  downloadReferenceSolution(...args: AppArgs<typeof downloadReferenceSolutionArtifact>): ReturnType<typeof downloadReferenceSolutionArtifact> {
    return downloadReferenceSolutionArtifact(this, ...args);
  }

  referenceSolutions(...args: AppArgs<typeof referenceSolutions>): ReturnType<typeof referenceSolutions> {
    return referenceSolutions(this, ...args);
  }

  launchReferenceSolution(...args: AppArgs<typeof launchReferenceSolution>): ReturnType<typeof launchReferenceSolution> {
    return launchReferenceSolution(this, ...args);
  }

  retrieveConfigId(...args: AppArgs<typeof retrieveConfigId>): ReturnType<typeof retrieveConfigId> {
    return retrieveConfigId(this, ...args);
  }

  customizeSid(...args: AppArgs<typeof customizeSid>): ReturnType<typeof customizeSid> {
    return customizeSid(this, ...args);
  }

  importConfig(...args: AppArgs<typeof importConfig>): ReturnType<typeof importConfig> {
    return importConfig(this, ...args);
  }

  exportZip(...args: AppArgs<typeof exportZip>): ReturnType<typeof exportZip> {
    return exportZip(this, ...args);
  }

  summaryInsights(...args: AppArgs<typeof summaryInsights>): ReturnType<typeof summaryInsights> {
    return summaryInsights(this, ...args);
  }

  exportWorkspace(...args: AppArgs<typeof exportWorkspace>): ReturnType<typeof exportWorkspace> {
    return exportWorkspace(this, ...args);
  }

  shareUrlFields(...args: AppArgs<typeof shareUrlFields>): ReturnType<typeof shareUrlFields> {
    return shareUrlFields(this, ...args);
  }

  generateConfigId(...args: AppArgs<typeof generateConfigId>): ReturnType<typeof generateConfigId> {
    return generateConfigId(this, ...args);
  }

  modesContaining(...args: AppArgs<typeof modesContaining>): ReturnType<typeof modesContaining> {
    return modesContaining(this, ...args);
  }

  launch(...args: AppArgs<typeof launch>): ReturnType<typeof launch> {
    return launch(this, ...args);
  }

  configure(...args: AppArgs<typeof configure>): ReturnType<typeof configure> {
    return configure(this, ...args);
  }

  loadUnconfigured(...args: AppArgs<typeof loadUnconfigured>): ReturnType<typeof loadUnconfigured> {
    return loadUnconfigured(this, ...args);
  }

  setUnconfigured(...args: AppArgs<typeof setUnconfigured>): ReturnType<typeof setUnconfigured> {
    return setUnconfigured(this, ...args);
  }

  setConfigurationControls(...args: AppArgs<typeof setConfigurationControls>): ReturnType<typeof setConfigurationControls> {
    return setConfigurationControls(this, ...args);
  }

  setQuantity(...args: AppArgs<typeof setQuantity>): ReturnType<typeof setQuantity> {
    return setQuantity(this, ...args);
  }

  undo(...args: AppArgs<typeof undo>): ReturnType<typeof undo> {
    return undo(this, ...args);
  }

  closeSession(...args: AppArgs<typeof closeSession>): ReturnType<typeof closeSession> {
    return closeSession(this, ...args);
  }

  inspectAutoFix(...args: AppArgs<typeof inspectAutoFix>): ReturnType<typeof inspectAutoFix> {
    return inspectAutoFix(this, ...args);
  }

  autoFix(...args: AppArgs<typeof autoFix>): ReturnType<typeof autoFix> {
    return autoFix(this, ...args);
  }

  validate(...args: AppArgs<typeof validate>): ReturnType<typeof validate> {
    return validate(this, ...args);
  }

  validationJobs(...args: AppArgs<typeof validationJobs>): ReturnType<typeof validationJobs> {
    return validationJobs(this, ...args);
  }

  diffSessions(...args: AppArgs<typeof diffSessions>): ReturnType<typeof diffSessions> {
    return diffSessions(this, ...args);
  }

  inspectStorageWizard(...args: AppArgs<typeof inspectStorageWizard>): ReturnType<typeof inspectStorageWizard> {
    return inspectStorageWizard(this, ...args);
  }

  setStorageWizard(...args: AppArgs<typeof setStorageWizard>): ReturnType<typeof setStorageWizard> {
    return setStorageWizard(this, ...args);
  }

  inspectPciWizard(...args: AppArgs<typeof inspectPciWizard>): ReturnType<typeof inspectPciWizard> {
    return inspectPciWizard(this, ...args);
  }

  setPciWizard(...args: AppArgs<typeof setPciWizard>): ReturnType<typeof setPciWizard> {
    return setPciWizard(this, ...args);
  }

  inspectPowerControls(...args: AppArgs<typeof inspectWorkspacePowerControls>): ReturnType<typeof inspectWorkspacePowerControls> {
    return inspectWorkspacePowerControls(this, ...args);
  }

  setPowerControls(...args: AppArgs<typeof setPowerControls>): ReturnType<typeof setPowerControls> {
    return setPowerControls(this, ...args);
  }

  placeStorageNetwork(...args: AppArgs<typeof placeStorageNetwork>): ReturnType<typeof placeStorageNetwork> {
    return placeStorageNetwork(this, ...args);
  }

  openStorageController(...args: AppArgs<typeof openStorageController>): ReturnType<typeof openStorageController> {
    return openStorageController(this, ...args);
  }

  openStorageSwitch(...args: AppArgs<typeof openStorageSwitch>): ReturnType<typeof openStorageSwitch> {
    return openStorageSwitch(this, ...args);
  }

  assignStorageNetwork(...args: AppArgs<typeof assignStorageNetwork>): ReturnType<typeof assignStorageNetwork> {
    return assignStorageNetwork(this, ...args);
  }

  addStorageNetwork(...args: AppArgs<typeof addStorageNetwork>): ReturnType<typeof addStorageNetwork> {
    return addStorageNetwork(this, ...args);
  }

  editStorageNetwork(...args: AppArgs<typeof editStorageNetwork>): ReturnType<typeof editStorageNetwork> {
    return editStorageNetwork(this, ...args);
  }

  reconfigureStorageNetwork(...args: AppArgs<typeof reconfigureStorageNetwork>): ReturnType<typeof reconfigureStorageNetwork> {
    return reconfigureStorageNetwork(this, ...args);
  }

  setNetworkPreferences(...args: AppArgs<typeof setNetworkPreferences>): ReturnType<typeof setNetworkPreferences> {
    return setNetworkPreferences(this, ...args);
  }

  assertTrustedWorkspace(...args: AppArgs<typeof assertTrustedWorkspace>): ReturnType<typeof assertTrustedWorkspace> {
    return assertTrustedWorkspace(this, ...args);
  }

  proposeReconciliation(...args: AppArgs<typeof proposeReconciliation>): ReturnType<typeof proposeReconciliation> {
    return proposeReconciliation(this, ...args);
  }

  reconciliationProposal(...args: AppArgs<typeof reconciliationProposal>): ReturnType<typeof reconciliationProposal> {
    return reconciliationProposal(this, ...args);
  }

  acceptReconciliation(...args: AppArgs<typeof acceptReconciliation>): ReturnType<typeof acceptReconciliation> {
    return acceptReconciliation(this, ...args);
  }

  scaleOut(...args: AppArgs<typeof scaleOut>): ReturnType<typeof scaleOut> {
    return scaleOut(this, ...args);
  }

  addRack(...args: AppArgs<typeof addRack>): ReturnType<typeof addRack> {
    return addRack(this, ...args);
  }

  placeInRack(...args: AppArgs<typeof placeInRack>): ReturnType<typeof placeInRack> {
    return placeInRack(this, ...args);
  }

  editLayout(...args: AppArgs<typeof editLayout>): ReturnType<typeof editLayout> {
    return editLayout(this, ...args);
  }

  placeOnFloor(...args: AppArgs<typeof placeOnFloor>): ReturnType<typeof placeOnFloor> {
    return placeOnFloor(this, ...args);
  }

  setRackLock(...args: AppArgs<typeof setRackLock>): ReturnType<typeof setRackLock> {
    return setRackLock(this, ...args);
  }

  copyRackItem(...args: AppArgs<typeof copyRackItem>): ReturnType<typeof copyRackItem> {
    return copyRackItem(this, ...args);
  }

  cloneConfiguration(...args: AppArgs<typeof cloneConfiguration>): ReturnType<typeof cloneConfiguration> {
    return cloneConfiguration(this, ...args);
  }

  configurePdu(...args: AppArgs<typeof configurePdu>): ReturnType<typeof configurePdu> {
    return configurePdu(this, ...args);
  }

  runAutoConnect(...args: AppArgs<typeof runAutoConnect>): ReturnType<typeof runAutoConnect> {
    return runAutoConnect(this, ...args);
  }

  inspectManualCabling(...args: AppArgs<typeof inspectManualCabling>): ReturnType<typeof inspectManualCabling> {
    return inspectManualCabling(this, ...args);
  }

  inspectManualCableChoices(...args: AppArgs<typeof inspectManualCableChoices>): ReturnType<typeof inspectManualCableChoices> {
    return inspectManualCableChoices(this, ...args);
  }

  createNativeManualCabling(...args: AppArgs<typeof createNativeManualCabling>): ReturnType<typeof createNativeManualCabling> {
    return createNativeManualCabling(this, ...args);
  }

  inspectNativeManualCabling(...args: AppArgs<typeof inspectNativeManualCabling>): ReturnType<typeof inspectNativeManualCabling> {
    return inspectNativeManualCabling(this, ...args);
  }

  editManualCabling(...args: AppArgs<typeof editManualCabling>): ReturnType<typeof editManualCabling> {
    return editManualCabling(this, ...args);
  }

  addManualCabling(...args: AppArgs<typeof addManualCabling>): ReturnType<typeof addManualCabling> {
    return addManualCabling(this, ...args);
  }

  applyTopology(...args: AppArgs<typeof applyTopology>): ReturnType<typeof applyTopology> {
    return applyTopology(this, ...args);
  }
}
