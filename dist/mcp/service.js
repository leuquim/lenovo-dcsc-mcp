import { downloadReferenceSolutionArtifact, referenceSolutions, launchReferenceSolution, customizeSid, importConfig, exportZip, summaryInsights, exportPowerReport, shareUrlFields } from '../app/importExport.js';
import { modesContaining, launch, configure, loadUnconfigured, setUnconfigured, setConfigurationControls, setExpressMode, setQuantity, undo, closeSession } from '../app/launch.js';
import { inspectAutoFix, autoFix, validate, validationJobs, diffSessions } from '../app/validation.js';
import { inspectStorageWizard, setStorageWizard, inspectPciWizard, setPciWizard, inspectWorkspacePowerControls, setPowerControls, placeStorageNetwork, openStorageController, openStorageSwitch, assignStorageNetwork, addStorageNetwork, editStorageNetwork, reconfigureStorageNetwork, setNetworkPreferences } from '../app/storage.js';
import { assertTrustedWorkspace, proposeReconciliation, reconciliationProposal, acceptReconciliation } from '../app/reconciliation.js';
import { scaleOut, addRack, addHardware, changeRackModel, placeInRack, editLayout, placeOnFloor, setFloorPreferences, setLayoutControls, setRackItemColor, setRackLock, copyRackItem, cloneConfiguration, configurePdu } from '../app/rack.js';
import { runAutoConnect, inspectManualCabling, inspectManualCableChoices, createNativeManualCabling, inspectNativeManualCabling, editManualCabling, inspectCabling, applyCablingChanges, applyTopology } from '../app/cabling.js';
import { Runtime } from '../app/runtime.js';
/** Facade over the app modules; tools and tests call these until they call the modules directly. */
export class DcscService extends Runtime {
    downloadReferenceSolution(...args) {
        return downloadReferenceSolutionArtifact(this, ...args);
    }
    referenceSolutions(...args) {
        return referenceSolutions(this, ...args);
    }
    launchReferenceSolution(...args) {
        return launchReferenceSolution(this, ...args);
    }
    customizeSid(...args) {
        return customizeSid(this, ...args);
    }
    importConfig(...args) {
        return importConfig(this, ...args);
    }
    exportZip(...args) {
        return exportZip(this, ...args);
    }
    summaryInsights(...args) {
        return summaryInsights(this, ...args);
    }
    exportPowerReport(...args) {
        return exportPowerReport(this, ...args);
    }
    shareUrlFields(...args) {
        return shareUrlFields(this, ...args);
    }
    modesContaining(...args) {
        return modesContaining(this, ...args);
    }
    launch(...args) {
        return launch(this, ...args);
    }
    configure(...args) {
        return configure(this, ...args);
    }
    loadUnconfigured(...args) {
        return loadUnconfigured(this, ...args);
    }
    setUnconfigured(...args) {
        return setUnconfigured(this, ...args);
    }
    setConfigurationControls(...args) {
        return setConfigurationControls(this, ...args);
    }
    setExpressMode(...args) {
        return setExpressMode(this, ...args);
    }
    setQuantity(...args) {
        return setQuantity(this, ...args);
    }
    undo(...args) {
        return undo(this, ...args);
    }
    closeSession(...args) {
        return closeSession(this, ...args);
    }
    inspectAutoFix(...args) {
        return inspectAutoFix(this, ...args);
    }
    autoFix(...args) {
        return autoFix(this, ...args);
    }
    validate(...args) {
        return validate(this, ...args);
    }
    validationJobs(...args) {
        return validationJobs(this, ...args);
    }
    diffSessions(...args) {
        return diffSessions(this, ...args);
    }
    inspectStorageWizard(...args) {
        return inspectStorageWizard(this, ...args);
    }
    setStorageWizard(...args) {
        return setStorageWizard(this, ...args);
    }
    inspectPciWizard(...args) {
        return inspectPciWizard(this, ...args);
    }
    setPciWizard(...args) {
        return setPciWizard(this, ...args);
    }
    inspectPowerControls(...args) {
        return inspectWorkspacePowerControls(this, ...args);
    }
    setPowerControls(...args) {
        return setPowerControls(this, ...args);
    }
    placeStorageNetwork(...args) {
        return placeStorageNetwork(this, ...args);
    }
    openStorageController(...args) {
        return openStorageController(this, ...args);
    }
    openStorageSwitch(...args) {
        return openStorageSwitch(this, ...args);
    }
    assignStorageNetwork(...args) {
        return assignStorageNetwork(this, ...args);
    }
    addStorageNetwork(...args) {
        return addStorageNetwork(this, ...args);
    }
    editStorageNetwork(...args) {
        return editStorageNetwork(this, ...args);
    }
    reconfigureStorageNetwork(...args) {
        return reconfigureStorageNetwork(this, ...args);
    }
    setNetworkPreferences(...args) {
        return setNetworkPreferences(this, ...args);
    }
    assertTrustedWorkspace(...args) {
        return assertTrustedWorkspace(this, ...args);
    }
    proposeReconciliation(...args) {
        return proposeReconciliation(this, ...args);
    }
    reconciliationProposal(...args) {
        return reconciliationProposal(this, ...args);
    }
    acceptReconciliation(...args) {
        return acceptReconciliation(this, ...args);
    }
    scaleOut(...args) {
        return scaleOut(this, ...args);
    }
    addRack(...args) {
        return addRack(this, ...args);
    }
    addHardware(...args) {
        return addHardware(this, ...args);
    }
    changeRackModel(...args) {
        return changeRackModel(this, ...args);
    }
    placeInRack(...args) {
        return placeInRack(this, ...args);
    }
    editLayout(...args) {
        return editLayout(this, ...args);
    }
    placeOnFloor(...args) {
        return placeOnFloor(this, ...args);
    }
    setFloorPreferences(...args) {
        return setFloorPreferences(this, ...args);
    }
    setLayoutControls(...args) {
        return setLayoutControls(this, ...args);
    }
    setRackItemColor(...args) {
        return setRackItemColor(this, ...args);
    }
    setRackLock(...args) {
        return setRackLock(this, ...args);
    }
    copyRackItem(...args) {
        return copyRackItem(this, ...args);
    }
    cloneConfiguration(...args) {
        return cloneConfiguration(this, ...args);
    }
    configurePdu(...args) {
        return configurePdu(this, ...args);
    }
    runAutoConnect(...args) {
        return runAutoConnect(this, ...args);
    }
    inspectManualCabling(...args) {
        return inspectManualCabling(this, ...args);
    }
    inspectManualCableChoices(...args) {
        return inspectManualCableChoices(this, ...args);
    }
    createNativeManualCabling(...args) {
        return createNativeManualCabling(this, ...args);
    }
    inspectNativeManualCabling(...args) {
        return inspectNativeManualCabling(this, ...args);
    }
    editManualCabling(...args) {
        return editManualCabling(this, ...args);
    }
    inspectCabling(...args) {
        return inspectCabling(this, ...args);
    }
    applyCablingChanges(...args) {
        return applyCablingChanges(this, ...args);
    }
    applyTopology(...args) {
        return applyTopology(this, ...args);
    }
}
//# sourceMappingURL=service.js.map