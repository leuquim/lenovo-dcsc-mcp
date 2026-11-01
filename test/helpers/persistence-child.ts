import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConfigSchema } from '../../src/config/schema.js';
import { selectStandaloneSoftware, type StandaloneSoftwareState } from '../../src/domain/standalone.js';
import {
  RECONCILIATION_HISTORY_STATE_KEY,
  RECONCILIATION_PROPOSALS_STATE_KEY,
} from '../../src/domain/reconciliation.js';
import { VALIDATION_JOBS_STATE_KEY, type ValidationJob } from '../../src/domain/validationJobs.js';
import { reduceConfiguration } from '../../src/domain/reduce.js';
import type { RawConfiguration } from '../../src/model/types.js';
import { DcscService } from '../../src/mcp/service.js';
import { registerStandaloneTools } from '../../src/mcp/standaloneTools.js';
import type { ConfigSession, WorkspaceSession } from '../../src/model/session.js';

type Scenario =
  | 'quantity'
  | 'configure'
  | 'controls'
  | 'import'
  | 'import-standalone-software'
  | 'import-standalone-service'
  | 'launch-new'
  | 'launch-join'
  | 'clone'
  | 'clone-racked'
  | 'copy-racked'
  | 'rack-lock'
  | 'add-rack'
  | 'pdu'
  | 'layout-auto-connect'
  | 'layout-unplace'
  | 'layout-remove'
  | 'layout-arrange'
  | 'layout-move'
  | 'layout-remove-rack-unplace'
  | 'layout-remove-rack-delete'
  | 'config-close'
  | 'role-preferences'
  | 'storage-definition'
  | 'storage-rename'
  | 'storage-remove'
  | 'topology-local'
  | 'topology-auto-connect'
  | 'floor-cabling'
  | 'undo-redo'
  | 'undo-only'
  | 'software-launch'
  | 'software-set-quantity'
  | 'software-remove'
  | 'software-refresh'
  | 'software-replace'
  | 'standalone-selection'
  | 'service-basket'
  | 'service-set-quantity'
  | 'service-set-product-quantity'
  | 'service-remove'
  | 'service-refresh'
  | 'service-replace'
  | 'reconciliation'
  | 'reconciliation-proposal'
  | 'validation-metadata'
  | 'standalone-close'
  | 'concurrent-workspaces';

const mode = process.argv[2];
const scenario = process.argv[3] as Scenario | undefined;
const sessionFile = process.argv[4];
if ((mode !== 'mutate' && mode !== 'verify') || !scenario || !sessionFile) {
  throw new Error('Usage: persistence-child.ts mutate|verify <scenario> <session-file>');
}

const config = ConfigSchema.parse({
  logLevel: 'error',
  files: { persistSessions: true, sessionFile },
});
const service = new DcscService(config);
installFixtureAdapter(service);

if (mode === 'mutate') {
  await mutate(service, scenario);
  process.stdout.write(`${JSON.stringify({ status: 'ack', scenario })}\n`);
  // The parent deliberately kills this process without calling service.close().
  setInterval(() => undefined, 60_000);
} else {
  await verify(service, scenario);
  await service.close();
  process.stdout.write(`${JSON.stringify({ status: 'verified', scenario })}\n`);
}

async function mutate(target: DcscService, selected: Scenario): Promise<void> {
  if (selected === 'software-launch' || selected === 'software-set-quantity' ||
      selected === 'software-remove' || selected === 'software-refresh' || selected === 'software-replace') {
    const handlers = standaloneHandlers(target);
    const launched = await handlers.get('dcsc_software_launch')!({ replace: false });
    assert(!launched.isError, `software launch failed: ${launched.content[0]?.text ?? ''}`);
    if (selected === 'software-launch') return;
    const workspace = String((JSON.parse(launched.content[0]?.text ?? '{}') as Record<string, unknown>)['workspace']);
    const selectedReply = await handlers.get('dcsc_software_select')!({
      session: workspace, code: '7S1S002WWW', quantity: 2,
    });
    assert(!selectedReply.isError, `software selection failed: ${selectedReply.content[0]?.text ?? ''}`);
    if (selected === 'software-refresh' || selected === 'software-replace') {
      const reply = await handlers.get('dcsc_software_launch')!({
        session: workspace, refresh: selected === 'software-refresh', replace: selected === 'software-replace',
      });
      assert(!reply.isError, `software ${selected} failed: ${reply.content[0]?.text ?? ''}`);
      return;
    }
    const mutation = selected === 'software-set-quantity'
      ? await handlers.get('dcsc_software_set_quantity')!({ session: workspace, code: '7S1S002WWW', quantity: 5 })
      : await handlers.get('dcsc_software_remove')!({ session: workspace, code: '7S1S002WWW' });
    assert(!mutation.isError, `software mutation failed: ${mutation.content[0]?.text ?? ''}`);
    return;
  }
  if (selected === 'service-basket' || selected === 'service-set-quantity' ||
      selected === 'service-set-product-quantity' || selected === 'service-remove' ||
      selected === 'service-refresh' || selected === 'service-replace') {
    const handlers = standaloneHandlers(target);
    const launched = await handlers.get('dcsc_services_launch')!({
      productCode: '7D73CTO1WW', productQuantity: 1, subCategory: 'Point of Sale',
    });
    assert(!launched.isError, `service basket launch failed: ${launched.content[0]?.text ?? ''}`);
    const launchedBody = JSON.parse(launched.content[0]?.text ?? '{}') as Record<string, unknown>;
    const workspace = String(launchedBody['workspace']);
    const selectedReply = await handlers.get('dcsc_services_select')!({
      session: workspace, serviceCode: '5WS7B99623', quantity: 2,
    });
    assert(!selectedReply.isError, `service basket selection failed: ${selectedReply.content[0]?.text ?? ''}`);
    if (selected === 'service-refresh' || selected === 'service-replace') {
      const reply = await handlers.get('dcsc_services_launch')!({
        session: workspace, productCode: '7D73CTO1WW', productQuantity: 1,
        subCategory: 'Point of Sale', refresh: selected === 'service-refresh',
        replace: selected === 'service-replace',
      });
      assert(!reply.isError, `service ${selected} failed: ${reply.content[0]?.text ?? ''}`);
    } else if (selected === 'service-set-quantity') {
      const reply = await handlers.get('dcsc_services_set_quantity')!({ session: workspace, quantity: 4 });
      assert(!reply.isError, `service quantity failed: ${reply.content[0]?.text ?? ''}`);
    } else if (selected === 'service-set-product-quantity') {
      const reply = await handlers.get('dcsc_services_set_product_quantity')!({ session: workspace, quantity: 3 });
      assert(!reply.isError, `service product quantity failed: ${reply.content[0]?.text ?? ''}`);
    } else if (selected === 'service-remove') {
      const reply = await handlers.get('dcsc_services_remove')!({ session: workspace });
      assert(!reply.isError, `service removal failed: ${reply.content[0]?.text ?? ''}`);
    }
    return;
  }
  if (selected === 'import') {
    const content = readFileSync(
      new URL('../fixtures/parity/xml/sr630-v3-qty1.xml', import.meta.url),
      'utf8',
    );
    await target.importConfig({
      content,
      ctx: target.newCtx({ solution: solution() }),
      solutionMode: 'General Purpose',
      fileName: 'durable-import.xml',
    });
    return;
  }
  if (selected === 'import-standalone-software' || selected === 'import-standalone-service') {
    const content = readFileSync(
      new URL('../fixtures/parity/xml/standalone-software-qty3.xml', import.meta.url),
      'utf8',
    );
    await target.importConfig({
      content,
      ctx: target.newCtx({ solution: solution() }),
      solutionMode: 'General Purpose',
      fileName: `${selected}.xml`,
    });
    return;
  }
  if (selected === 'launch-new' || selected === 'launch-join') {
    const first = await target.launch({
      productCode: '7D73CTO1WW', mode: 'cto', solution: solution(),
      ctx: target.newCtx({ solution: solution() }), label: 'Durable launch 1',
    });
    if (selected === 'launch-join') {
      const workspace = target.sessions.getWorkspace(first.id)!;
      await target.launch({
        productCode: '7D73CTO1WW', mode: 'cto', solution: solution(),
        ctx: target.newCtx({ solution: solution() }), workspaceId: workspace.id,
        expectedRevision: workspace.revision, label: 'Durable launch 2',
      });
    }
    return;
  }
  if (selected === 'standalone-selection' || selected === 'standalone-close') {
    const result = await target.sessions.createManyAtomic([], {
      newWorkspaceId: `ws_${selected}`,
      workspaceContext: { locale: target.locale, solution: solution() },
      workspaceState: {
        serverState:
          selected === 'standalone-selection'
            ? { standaloneSoftwareState: standaloneSoftwareState() }
            : { standaloneSoftwareState: standaloneSoftwareState() },
      },
    });
    if (selected === 'standalone-close') {
      const removed = await target.closeSession(result.workspace.id, result.workspace.revision);
      assert(removed, 'standalone workspace close returned false');
      return;
    }
    await target.sessions.transact(result.workspace.id, { keepEmptyWorkspace: true }, (workspace) => {
      workspace.serverState.standaloneSoftwareState = selectStandaloneSoftware(
        workspace.serverState.standaloneSoftwareState as StandaloneSoftwareState,
        { code: 'SW-1', quantity: 4, id: 'standalone-selection-1' },
      );
    });
    return;
  }

  if (selected === 'clone-racked') {
    const first = target.sessions.create(input('US__durable_a'));
    const rack = target.sessions.create(rackInput('US__durable_rack', first.workspaceId));
    const workspace = target.sessions.getWorkspace(first.id)!;
    workspace.rackArea = [{
      id: rack.configurationId, configurationId: rack.configurationId,
      code: 'RACKCTO', type: 'rack', size: 42, lockedSpace: [],
      rackItems: [{ ...physicalNode(first.configurationId, 1), configurationId: first.configurationId,
        lowestPosition: 1, highestPosition: 42, defaultPosition: 1, lock: false,
        rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [] }],
    }];
    workspace.serverState.cloneDependency = {
      [first.configurationId]: [first.configurationId],
      [rack.configurationId]: [rack.configurationId],
    };
    target.persist();
    await target.cloneConfiguration({
      sessionHandle: first.id, count: 1, labelPrefix: 'Durable racked clone', placement: 'same-rack',
      expectedRevision: workspace.revision, ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }

  if (selected === 'copy-racked') {
    const sourceInput = input('US__durable_a');
    sourceInput.raw.name = 'Server';
    const first = target.sessions.create(sourceInput);
    const rackInputValue = rackInput('US__durable_rack', first.workspaceId);
    rackInputValue.raw.name = 'Rack';
    const rack = target.sessions.create(rackInputValue);
    const workspace = target.sessions.getWorkspace(first.id)!;
    workspace.rackArea = [{
      id: rack.configurationId, configurationId: rack.configurationId,
      code: 'RACKCTO', name: 'Rack', type: 'rack', size: 42, lockedSpace: [],
      rackItems: [{ ...physicalNode(first.configurationId, 1), name: 'Server',
        configurationId: first.configurationId, lowestPosition: 1, highestPosition: 42,
        defaultPosition: 1, lock: false,
        rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [] }],
    }];
    workspace.serverState.cloneDependency = {
      [first.configurationId]: [first.configurationId],
      [rack.configurationId]: [rack.configurationId],
    };
    target.persist();
    await target.copyRackItem(first.id, {
      expectedRevision: workspace.revision,
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }

  const { first, second, workspace } = baseline(target);
  if (selected === 'rack-lock') {
    workspace.rackArea[0]!.lockedSpace = [];
    workspace.rackArea[0]!.rackItems = [{
      ...physicalNode(first.configurationId, 1), configurationId: first.configurationId,
      lowestPosition: 1, highestPosition: 42, defaultPosition: 1, lock: false,
      rule: { mtMinMaxRule: null, productMinMaxRule: null }, nodes: [],
    }];
    await target.setRackLock(first.id, {
      target: { itemId: first.configurationId }, locked: true,
      expectedRevision: workspace.revision, ctx: target.newCtx({ solution: workspace.solution }),
    });
    await target.setRackLock(workspace.id, {
      target: { rackId: 'rack-physical', position: 42 }, locked: true,
      expectedRevision: workspace.revision, ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'quantity') {
    await target.setQuantity(first, 6, first.revision);
    return;
  }
  if (selected === 'configure') {
    await target.configure(
      first,
      [{ section: 'MEMORY', code: 'DIMM', quantity: 8 }],
      target.newCtx({ solution: workspace.solution }),
      first.revision,
    );
    return;
  }
  if (selected === 'controls') {
    await target.setConfigurationControls(workspace.id, {
      validationMode: 'expert', autoCorrect: false,
      expectedRevision: workspace.revision,
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'clone') {
    await target.cloneConfiguration({
      sessionHandle: first.id,
      count: 1,
      labelPrefix: 'Durable clone',
      expectedRevision: workspace.revision,
    });
    return;
  }
  if (selected === 'add-rack') {
    await target.addRack(
      workspace.id,
      'RACKCTO',
      target.newCtx({ solution: workspace.solution }),
      workspace.revision,
    );
    return;
  }
  if (selected === 'pdu') {
    const rack = target.sessions.create(rackInput('US__durable_rack', workspace.id));
    workspace.rackArea = [{
      id: rack.configurationId, code: 'RACKCTO', type: 'rack', size: 42, rackItems: [],
    }];
    target.persist();
    await target.configurePdu(workspace.id, rack.configurationId, {
      pduCode: 'PDU1', quantity: 2, expectedRevision: workspace.revision,
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'layout-auto-connect') {
    await target.placeInRack(workspace.id, {
      rackId: 'rack-physical', sessionId: first.id, position: 3,
      expectedRevision: workspace.revision,
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    await target.runAutoConnect(
      workspace.id,
      target.newCtx({ solution: workspace.solution }),
      workspace.revision,
      { autoAddPDU: true, autoAddSwitch: false, p2pCabling: true },
    );
    return;
  }
  if (selected === 'layout-move') {
    workspace.rackArea = [
      { id: 'rack-source', code: 'RACKCTO', type: 'rack', size: 42,
        rackItems: [physicalNode(first.configurationId, 8)] },
      { id: 'rack-destination', code: 'RACKCTO', type: 'rack', size: 42, rackItems: [] },
    ];
    target.persist();
    await target.placeInRack(workspace.id, {
      rackId: 'rack-destination', sessionId: first.id, position: 12,
      expectedRevision: workspace.revision, ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'layout-remove-rack-unplace' || selected === 'layout-remove-rack-delete') {
    const rack = target.sessions.create(rackInput('US__durable_rack_remove', workspace.id));
    workspace.rackArea = [{ id: rack.configurationId, code: 'RACKCTO', type: 'rack', size: 42,
      rackItems: [physicalNode(first.configurationId, 8)] }];
    target.persist();
    await target.editLayout(workspace.id, {
      action: 'remove', configurationId: rack.id,
      contents: selected === 'layout-remove-rack-delete' ? 'delete' : 'unplace',
      expectedRevision: workspace.revision, ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'layout-unplace' || selected === 'layout-remove' || selected === 'layout-arrange') {
    workspace.rackArea[0]!.rackItems = [physicalNode(first.configurationId, 8)];
    workspace.serverState.connections = [activeConnection(first.configurationId, second.configurationId)];
    target.persist();
    if (selected === 'layout-unplace') {
      await target.editLayout(workspace.id, {
        action: 'unplace', configurationId: first.id, expectedRevision: workspace.revision,
        ctx: target.newCtx({ solution: workspace.solution }),
      });
    } else if (selected === 'layout-remove') {
      await target.editLayout(workspace.id, {
        action: 'remove', configurationId: first.id, expectedRevision: workspace.revision,
        ctx: target.newCtx({ solution: workspace.solution }),
      });
    } else {
      await target.editLayout(workspace.id, {
        action: 'arrange', expectedRevision: workspace.revision,
        ctx: target.newCtx({ solution: workspace.solution }),
      });
    }
    return;
  }
  if (selected === 'config-close') {
    workspace.rackArea[0]!.rackItems = [physicalNode(first.configurationId, 4)];
    workspace.cables = [{
      id: 'fixture-cable',
      fromConfigId: first.configurationId, fromPort: 'eth0',
      toConfigId: second.configurationId, toPort: 'eth1', cableCode: '3760',
    }];
    workspace.serverState.connections = [activeConnection(first.configurationId, second.configurationId)];
    workspace.serverState.imports = [{ sourceId: first.configurationId, retained: true }];
    target.persist();
    assert(await target.closeSession(first.id, first.revision), 'configuration close returned false');
    return;
  }
  if (selected === 'role-preferences') {
    await target.sessions.transact(first.id, { expectedRevision: first.revision }, (_draft, session) => {
      assert(session, 'first configuration missing');
      session.raw.nodeRole = 'Compute';
    });
    const fabric = await target.fabricOptions(target.newCtx({ solution: workspace.solution }), workspace.solution);
    const network = fabric.networkTypes[0];
    const device = fabric.networkDevices[0];
    const cable = fabric.cables[0];
    assert(network, 'fixture network type missing');
    assert(device, 'fixture network device missing');
    assert(cable, 'fixture cable missing');
    await target.setNetworkPreferences(workspace.id, {
      selections: [{ networkTypeId: network.id, mainDeviceId: device.id, cableId: cable.id }],
      expectedRevision: workspace.revision,
      autoConnect: false,
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'storage-definition' || selected === 'storage-rename' || selected === 'storage-remove') {
    const fabric = await target.fabricOptions(target.newCtx(), workspace.solution);
    assert(fabric.storageControllers[0], 'fixture storage controller missing');
    await target.addStorageNetwork(workspace.id, {
      input: { name: 'Durable Storage', controllerId: fabric.storageControllers[0].id },
      expectedRevision: workspace.revision, ctx: target.newCtx(),
    });
    if (selected !== 'storage-definition') {
      await target.editStorageNetwork(workspace.id, { action: 'rename', name: 'Durable Storage',
        newName: 'Renamed Storage', expectedRevision: workspace.revision });
    }
    if (selected === 'storage-remove') {
      await target.editStorageNetwork(workspace.id, { action: 'remove', name: 'Renamed Storage',
        expectedRevision: workspace.revision });
    }
    return;
  }
  if (selected === 'topology-local' || selected === 'topology-auto-connect') {
    await target.applyTopology({
      sessionHandle: first.id, topology: '1GbE_Copper', networkName: 'Management',
      expectedRevision: first.revision, autoConnect: selected === 'topology-auto-connect',
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    return;
  }
  if (selected === 'floor-cabling') {
    await target.placeOnFloor(workspace.id, 'rack-physical', 2, 3, workspace.revision);
    await target.addManualCabling(
      workspace.id,
      {
        fromConfigId: first.configurationId,
        fromPort: 'eth0',
        toConfigId: second.configurationId,
        toPort: 'eth1',
        cableCode: '3760',
      },
      workspace.revision,
    );
    return;
  }
  if (selected === 'undo-redo') {
    await target.setQuantity(first, 7, first.revision);
    assert(await target.sessions.undoWorkspace(workspace.id, workspace.revision), 'undo failed');
    assert(await target.sessions.redoWorkspace(workspace.id, workspace.revision), 'redo failed');
    return;
  }
  if (selected === 'undo-only') {
    await target.setQuantity(first, 7, first.revision);
    assert(await target.sessions.undoWorkspace(workspace.id, workspace.revision), 'undo failed');
    return;
  }
  if (selected === 'reconciliation' || selected === 'reconciliation-proposal') {
    workspace.rackArea = [];
    workspace.rackSummaries = [];
    workspace.integrity = 'legacy-unverified';
    workspace.integrityWarnings = ['Fixture requires explicit reconciliation acceptance.'];
    target.persist();
    const proposal = await target.proposeReconciliation(
      workspace.id,
      target.newCtx({ solution: workspace.solution }),
    );
    assert(
      Array.isArray(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY]),
      'reconciliation proposal metadata missing before acceptance',
    );
    if (selected === 'reconciliation-proposal') return;
    await target.acceptReconciliation(workspace.id, proposal.id);
    return;
  }
  if (selected === 'validation-metadata') {
    const result = await target.validate(first.id, target.newCtx({ solution: workspace.solution }));
    assert(result.isValid, 'fixture validation did not complete successfully');
    return;
  }
  if (selected === 'concurrent-workspaces') {
    const third = target.sessions.create(input('US__concurrent_other'));
    target.persist();
    await Promise.all([
      target.setQuantity(first, 8, first.revision),
      target.setQuantity(third, 9, third.revision),
    ]);
    return;
  }
  throw new Error(`Unknown scenario ${selected}`);
}

async function verify(target: DcscService, selected: Scenario): Promise<void> {
  const workspaces = target.sessions.listWorkspaces();
  if (selected === 'software-launch' || selected === 'software-set-quantity' ||
      selected === 'software-remove' || selected === 'software-refresh' || selected === 'software-replace') {
    assert(workspaces.length === 1, `expected one software workspace, found ${workspaces.length}`);
    const state = workspaces[0]?.serverState.standaloneSoftwareState as StandaloneSoftwareState;
    assert(state?.features[0]?.code === '7S1S002WWW', 'software launch catalog missing');
    assert((state.launchRaw as Record<string, unknown>)?.['capturedBase'] === true, 'software launch envelope missing');
    if (selected === 'software-launch' || selected === 'software-replace') {
      assert(state.selections.length === 0, `${selected} unexpectedly retained a selection`);
    } else if (selected === 'software-set-quantity') {
      assert(state.selections[0]?.code === '7S1S002WWW', 'software selection code missing');
      assert(state.selections[0]?.quantity === 5, 'software quantity missing');
    } else if (selected === 'software-refresh') {
      assert(state.selections[0]?.code === '7S1S002WWW', 'software refresh lost selection code');
      assert(state.selections[0]?.quantity === 2, 'software refresh lost selection quantity');
    } else assert(state.selections.length === 0, 'removed software selection was restored');
    return;
  }
  if (selected === 'service-basket' || selected === 'service-set-quantity' ||
      selected === 'service-set-product-quantity' || selected === 'service-remove' ||
      selected === 'service-refresh' || selected === 'service-replace') {
    assert(workspaces.length === 1, `expected one service workspace, found ${workspaces.length}`);
    const state = workspaces[0]?.serverState.standaloneServiceState as {
      selections?: Array<{ code?: string; quantity?: number }>;
      summaryRaw?: Record<string, unknown>;
      product?: { quantity?: number };
    };
    if (selected === 'service-remove' || selected === 'service-replace') {
      assert(state?.selections?.length === 0, 'removed service selection was restored');
      assert(state.product?.quantity === 1, 'removed service changed product quantity');
    } else {
      const serviceSelection = state?.selections?.[0];
      assert(serviceSelection, 'service selection missing');
      assert(serviceSelection.code === '5WS7B99623', 'service selection code missing');
      assert(serviceSelection.quantity === (selected === 'service-set-quantity' ? 4 : 2), 'service selection quantity missing');
      assert(state.summaryRaw?.['totalPrice'] === 3274, 'service summary price missing');
      assert(state.product?.quantity === (selected === 'service-set-product-quantity' ? 3 : 1), 'serviced product quantity missing');
    }
    return;
  }
  if (selected === 'import-standalone-software' || selected === 'import-standalone-service') {
    assert(workspaces.length === 1, `expected one standalone import workspace, found ${workspaces.length}`);
    assert(workspaces[0]?.configurations.size === 0, 'standalone import invented a hardware configuration');
    if (selected === 'import-standalone-software') {
      const state = workspaces[0]?.serverState.standaloneSoftwareState as StandaloneSoftwareState;
      assert(state.selections[0]?.code === '7S1S002WWW', 'imported software code missing');
      assert(state.selections[0]?.quantity === 3, 'imported software quantity missing');
      assert(state.selections[0]?.totalPrice === 703.5, 'imported software price missing');
    } else {
      const state = workspaces[0]?.serverState.standaloneServiceState as {
        product?: { quantity?: number }; selections?: Array<{ code?: string; quantity?: number }>;
      };
      assert(state.product?.quantity === 3, 'imported serviced-product quantity missing');
      assert(state.selections?.[0]?.quantity === 2, 'imported service quantity missing');
    }
    return;
  }
  if (selected === 'launch-new' || selected === 'launch-join') {
    assert(workspaces.length === 1, `expected one launched workspace, found ${workspaces.length}`);
    const configurations = [...workspaces[0]!.configurations.values()];
    assert(configurations.length === (selected === 'launch-join' ? 2 : 1),
      `launch restored ${configurations.length} configurations`);
    assert(configurations[0]?.label === 'Durable launch 1', 'first launch label missing');
    if (selected === 'launch-join') assert(configurations[1]?.label === 'Durable launch 2', 'joined launch label missing');
    assert(new Set(configurations.map(item => item.configurationId)).size === configurations.length,
      'launch configuration identities were not unique');
    return;
  }
  if (selected === 'import') {
    assert(workspaces.length === 1, `expected one imported workspace, found ${workspaces.length}`);
    const imported = workspaces[0]!;
    assert(imported.configurations.size === 2, `imported configuration count was ${imported.configurations.size}`);
    assert(imported.rackArea[0]?.id === 'US__rack-1', 'imported rack identity missing');
    const rackItems = imported.rackArea[0]?.rackItems as Array<Record<string, unknown>> | undefined;
    const importedRackItem = rackItems?.[0];
    assert(importedRackItem, 'imported rack child missing');
    assert(importedRackItem['id'] === 'US__server-1', 'imported rack child identity missing');
    assert(importedRackItem['position'] === 3, 'imported rack position missing');
    assert(imported.floorItems[0]?.x === 0 && imported.floorItems[0]?.y === 0, 'imported floor position missing');
    return;
  }
  if (selected === 'standalone-close') {
    assert(workspaces.length === 0, `closed standalone workspace resurrected (${workspaces.length})`);
    return;
  }
  if (selected === 'standalone-selection') {
    assert(workspaces.length === 1, `expected one standalone workspace, found ${workspaces.length}`);
    const state = workspaces[0]?.serverState.standaloneSoftwareState as StandaloneSoftwareState;
    assert(state?.selections[0]?.code === 'SW-1', 'standalone selection code missing');
    assert(state.selections[0]?.quantity === 4, 'standalone selection quantity missing');
    assert(state.selections[0]?.id === 'standalone-selection-1', 'standalone selection identity missing');
    return;
  }
  if (selected === 'clone-racked') {
    assert(workspaces.length === 1, `expected one racked-clone workspace, found ${workspaces.length}`);
    const workspace = workspaces[0]!;
    assert(workspace.configurations.size === 3,
      `racked clone restored ${workspace.configurations.size} configurations instead of three`);
    const source = findConfiguration(target, 'US__durable_a');
    const rack = findConfiguration(target, 'US__durable_rack');
    const clone = [...workspace.configurations.values()].find(item =>
      item.configurationId !== source.configurationId && item.configurationId !== rack.configurationId);
    assert(clone, 'racked clone configuration missing after restart');
    assert(clone.label === 'Durable racked clone 2', 'racked clone label missing after restart');
    const items = (workspace.rackArea[0]?.rackItems ?? []) as Array<Record<string, unknown>>;
    assert(items.length === 2, `racked clone restored ${items.length} physical items`);
    assert(items[0]?.['id'] === source.configurationId && items[0]?.['position'] === 1,
      'racked clone source placement changed after restart');
    assert(items[1]?.['id'] === clone.configurationId && items[1]?.['position'] === 2,
      'racked clone placement missing after restart');
    assert(JSON.stringify(workspace.serverState.cloneDependency) === JSON.stringify({
      [source.configurationId]: [source.configurationId, clone.configurationId],
      [rack.configurationId]: [rack.configurationId],
    }), 'racked clone dependency group changed after restart');
    const exported = await target.exportZip(workspace.id, {
      fileName: 'durable-racked-clone', fileTypes: ['XML'], scope: 'workspace',
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    assert(exported.configurationsExported === 3, 'follow-up export omitted a cloned configuration');
    const chunks: Buffer[] = [];
    for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
    assert(Buffer.concat(chunks).toString('utf8') === 'fixture-clone-export',
      'follow-up export stream was not readable after restart');
    return;
  }
  if (selected === 'copy-racked') {
    assert(workspaces.length === 1, `expected one racked-copy workspace, found ${workspaces.length}`);
    const workspace = workspaces[0]!;
    assert(workspace.configurations.size === 3,
      `racked copy restored ${workspace.configurations.size} configurations instead of three`);
    const source = findConfiguration(target, 'US__durable_a');
    const rack = findConfiguration(target, 'US__durable_rack');
    const copy = [...workspace.configurations.values()].find(item =>
      item.configurationId !== source.configurationId && item.configurationId !== rack.configurationId);
    assert(copy, 'racked copy configuration missing after restart');
    assert(copy.raw.name === 'Copy_Server' && copy.label === 'Copy_Server',
      'racked copy name metadata missing after restart');
    const items = (workspace.rackArea[0]?.rackItems ?? []) as Array<Record<string, unknown>>;
    assert(items.length === 2, `racked copy restored ${items.length} physical items`);
    assert(items[0]?.['id'] === source.configurationId && items[0]?.['position'] === 1,
      'racked copy source placement changed after restart');
    assert(items[1]?.['id'] === copy.configurationId && items[1]?.['position'] === 2,
      'racked copy placement missing after restart');
    assert(JSON.stringify(workspace.serverState.cloneDependency) === JSON.stringify({
      [source.configurationId]: [source.configurationId],
      [rack.configurationId]: [rack.configurationId],
      [copy.configurationId]: [copy.configurationId],
    }), 'racked copy dependency singletons changed after restart');
    const exported = await target.exportZip(workspace.id, {
      fileName: 'durable-racked-copy', fileTypes: ['XML'], scope: 'workspace',
      ctx: target.newCtx({ solution: workspace.solution }),
    });
    assert(exported.configurationsExported === 3, 'follow-up export omitted the copied configuration');
    const chunks: Buffer[] = [];
    for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
    assert(Buffer.concat(chunks).toString('utf8') === 'fixture-clone-export',
      'follow-up copy export stream was not readable after restart');
    return;
  }
  if (selected === 'rack-lock') {
    const source = findConfiguration(target, 'US__durable_a');
    const workspace = target.sessions.getWorkspace(source.id)!;
    const rack = workspace.rackArea.find(item => item.id === 'rack-physical');
    assert(rack, 'locked rack missing after restart');
    const item = (rack.rackItems as Array<Record<string, unknown>> | undefined)
      ?.find(candidate => candidate['id'] === source.configurationId);
    assert(item?.['lock'] === true && item['position'] === 1,
      'rack item lock missing after restart');
    assert(JSON.stringify(rack.lockedSpace) === JSON.stringify([42]),
      'empty-U lock missing or not one-based after restart');
    return;
  }
  if (selected === 'layout-remove' || selected === 'config-close') {
    const retained = findConfiguration(target, 'US__durable_b');
    const workspace = target.sessions.getWorkspace(retained.id)!;
    const items = workspace.rackArea[0]?.rackItems as Array<Record<string, unknown>> | undefined;
    assert(workspace.configurations.size === 1, `${selected} retained ${workspace.configurations.size} configurations`);
    assert(!target.sessions.list().some(item => item.configurationId === 'US__durable_a'),
      `${selected} restored the removed configuration`);
    assert(items?.length === 0, `${selected} restored the removed physical reference`);
    assert(!JSON.stringify(workspace.serverState.connections).includes('US__durable_a'),
      `${selected} restored an active connection reference`);
    if (selected === 'config-close') {
      assert(workspace.cables.length === 0, 'closed configuration cable reference remained');
      assert(JSON.stringify(workspace.serverState.imports).includes('US__durable_a'),
        'recovery provenance was pruned with active references');
    }
    return;
  }
  if (selected === 'layout-remove-rack-delete') {
    const retained = findConfiguration(target, 'US__durable_b');
    const workspace = target.sessions.getWorkspace(retained.id)!;
    assert(workspace.configurations.size === 1, 'rack removal with delete retained rack contents');
    assert(!target.sessions.list().some(item => item.configurationId === 'US__durable_a'),
      'deleted rack child was restored');
    assert(!target.sessions.list().some(item => item.configurationId === 'US__durable_rack_remove'),
      'deleted rack configuration was restored');
    return;
  }

  const first = findConfiguration(target, 'US__durable_a');
  if (selected === 'quantity') {
    assert(first.raw.quantity === 6, `quantity was ${String(first.raw.quantity)}`);
  } else if (selected === 'configure') {
    assert(first.index.selected.get('DIMM') === 8, 'configured DIMM quantity missing');
    assert(first.raw.tabs?.[0]?.subTabs?.[0]?.sections?.[0]?.results?.[0]?.quantity === 8,
      'configured canonical result missing');
  } else if (selected === 'controls') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.validationMode === 'expert', 'workspace Expert mode missing');
    assert([...workspace.configurations.values()].every((item) =>
      item.validationMode === 'expert' && item.autoCorrect === false), 'configuration controls missing');
  } else if (selected === 'clone') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.configurations.size === 3, `clone count was ${workspace.configurations.size}`);
    const identities = new Set([...workspace.configurations.values()].map((item) => item.configurationId));
    assert(identities.size === 3, 'clone configuration identity was duplicated');
    assert([...workspace.configurations.values()].some((item) => item.label === 'Durable clone 2'), 'clone label missing');
  } else if (selected === 'add-rack') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.configurations.size === 3, `rack configuration count was ${workspace.configurations.size}`);
    const rack = [...workspace.configurations.values()].find(item => item.product.code === 'RACKCTO');
    assert(rack, 'launched rack configuration missing');
    assert(workspace.rackArea.some(item => item.id === rack.configurationId), 'physical rack identity missing');
  } else if (selected === 'pdu') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const rack = [...workspace.configurations.values()].find(item => item.configurationId === 'US__durable_rack');
    assert(rack?.index.selected.get('PDU1') === 2, 'PDU selection missing');
    assert(workspace.powerSelections[0]?.pduCode === 'PDU1', 'workspace PDU preference missing');
  } else if (selected === 'layout-auto-connect') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const items = workspace.rackArea[0]?.rackItems as Array<Record<string, unknown>> | undefined;
    const placedItem = items?.[0];
    assert(placedItem, 'placed rack item missing');
    assert(placedItem['id'] === first.configurationId, 'placed rack item identity missing');
    assert(placedItem['position'] === 3, 'placed rack position missing');
    assert(workspace.cables[0]?.cableCode === '3760', 'auto-connect cable missing');
    assert(Array.isArray(workspace.serverState.connections), 'raw auto-connect connections missing');
    assert(workspace.serverState.autoConnectSettings &&
      (workspace.serverState.autoConnectSettings as Record<string, unknown>)['autoAddPDU'] === true,
    'auto-connect settings missing');
    const networking = workspace.serverState.networkingInformation as Record<string, unknown>;
    assert((networking.autoConnectSettings as Record<string, unknown>)?.['p2pCabling'] === true,
      'lossless networking auto-connect settings missing');
  } else if (selected === 'layout-unplace') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const items = workspace.rackArea[0]?.rackItems as Array<Record<string, unknown>> | undefined;
    assert(workspace.configurations.size === 2, 'unplace deleted a configuration');
    assert(items?.length === 0, 'unplaced item remained in rack');
    assert(workspace.nonRackArea[0]?.id === first.configurationId, 'unplaced item missing from non-rack area');
  } else if (selected === 'layout-arrange') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const items = workspace.rackArea[0]?.rackItems as Array<Record<string, unknown>> | undefined;
    const arranged = items?.[0];
    assert(arranged, 'arranged item missing');
    assert(arranged['id'] === first.configurationId, 'arranged item identity missing');
    assert(arranged['position'] === 5, `arranged position was ${String(arranged['position'])}`);
  } else if (selected === 'layout-move') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const source = workspace.rackArea.find(item => item.id === 'rack-source');
    const destination = workspace.rackArea.find(item => item.id === 'rack-destination');
    assert((source?.rackItems as unknown[] | undefined)?.length === 0, 'moved item remained in source rack');
    const moved = (destination?.rackItems as Array<Record<string, unknown>> | undefined)?.[0];
    assert(moved?.['id'] === first.configurationId && moved['position'] === 12, 'moved placement missing');
  } else if (selected === 'layout-remove-rack-unplace') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.configurations.size === 2, 'rack removal with unplace deleted a child configuration');
    assert(![...workspace.configurations.values()].some(item => item.configurationId === 'US__durable_rack_remove'),
      'removed rack configuration was restored');
    assert(workspace.nonRackArea.some(item => item.id === first.configurationId), 'rack child was not unplaced');
  } else if (selected === 'role-preferences') {
    assert(first.raw.nodeRole === 'Compute', 'node role missing');
    const workspace = target.sessions.getWorkspace(first.id)!;
    const selections = workspace.serverState.networkSelections as Array<Record<string, unknown>>;
    assert(selections?.[0]?.networkTypeId === 'network-type:Management', 'network preference missing');
    assert(Array.isArray(workspace.serverState.clusterPreference), 'cluster preference missing');
  } else if (selected === 'storage-definition' || selected === 'storage-rename' || selected === 'storage-remove') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const definitions = workspace.serverState.storageConnectionNetworks as Array<Record<string, unknown>>;
    if (selected === 'storage-remove') assert(definitions.length === 0, 'removed storage definition returned');
    else assert(definitions?.[0]?.name === (selected === 'storage-definition' ? 'Durable Storage' : 'Renamed Storage'), 'storage definition missing');
    const networking = workspace.serverState.networkingInformation as Record<string, unknown>;
    assert(JSON.stringify(networking.storageNetworks) === JSON.stringify(definitions), 'storage export mirror differs');
  } else if (selected === 'topology-local' || selected === 'topology-auto-connect') {
    const selectedTopologies = first.raw.selectedTopologies as Record<string, unknown>;
    assert(Object.keys(selectedTopologies ?? {}).length > 0, 'selected topology missing');
    assert(JSON.stringify(selectedTopologies).includes('1GbE_Copper'), 'topology shortName missing');
    if (selected === 'topology-auto-connect') {
      const workspace = target.sessions.getWorkspace(first.id)!;
      assert(workspace.cables[0]?.cableCode === '3760', 'topology auto-connect cable missing');
      assert(Array.isArray(workspace.serverState.connections), 'topology raw connections missing');
    }
  } else if (selected === 'floor-cabling') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.floorItems[0]?.rackId === 'rack-physical', 'floor rack missing');
    assert(workspace.floorItems[0]?.x === 2 && workspace.floorItems[0]?.y === 3, 'floor coordinates missing');
    assert(workspace.cables[0]?.cableCode === '3760', 'manual cable missing');
    const floor = workspace.serverState.floorInformation as Record<string, unknown>;
    assert(Array.isArray(floor?.floorGrid) && floor.floorGrid.length === 1, 'lossless floor grid missing');
  } else if (selected === 'undo-redo') {
    assert(first.raw.quantity === 7, `redo quantity was ${String(first.raw.quantity)}`);
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert((workspace.history?.undo.length ?? 0) > 0, 'undo history missing after redo');
  } else if (selected === 'undo-only') {
    assert(first.raw.quantity === 1, `undo restored quantity ${String(first.raw.quantity)}`);
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert((workspace.history?.redo.length ?? 0) > 0, 'redo history missing after acknowledged undo');
  } else if (selected === 'reconciliation') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.integrity === 'verified', `reconciled integrity was ${workspace.integrity}`);
    assert(workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY] === undefined,
      'accepted reconciliation proposal remained pending');
    const history = workspace.serverState[RECONCILIATION_HISTORY_STATE_KEY] as unknown[] | undefined;
    assert(history?.length === 1, 'reconciliation acceptance history missing');
  } else if (selected === 'reconciliation-proposal') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    assert(workspace.integrity === 'legacy-unverified', 'proposal-only flow changed workspace integrity');
    const proposals = workspace.serverState[RECONCILIATION_PROPOSALS_STATE_KEY] as unknown[] | undefined;
    assert(proposals?.length === 1, 'acknowledged reconciliation proposal missing');
    assert(workspace.serverState[RECONCILIATION_HISTORY_STATE_KEY] === undefined,
      'proposal-only flow unexpectedly wrote acceptance history');
  } else if (selected === 'validation-metadata') {
    const workspace = target.sessions.getWorkspace(first.id)!;
    const jobs = workspace.serverState[VALIDATION_JOBS_STATE_KEY] as ValidationJob[] | undefined;
    const job = jobs?.[0];
    assert(job, 'validation job metadata missing');
    assert(job.status === 'valid' && job.terminal, 'terminal valid validation state missing');
    assert(job.freshValidationRequired === false, 'completed validation incorrectly requires refresh');
    assert(job.descriptors[0] !== undefined, 'validation descriptor missing');
    assert(Array.isArray(job.resultRaw) && job.resultRaw[0] === 'finish', 'validation result payload missing');
  } else if (selected === 'concurrent-workspaces') {
    assert(first.raw.quantity === 8, `first concurrent quantity was ${String(first.raw.quantity)}`);
    assert(findConfiguration(target, 'US__concurrent_other').raw.quantity === 9, 'second concurrent quantity missing');
    assert(workspaces.length === 2, `expected two workspaces, found ${workspaces.length}`);
  }
}

function baseline(target: DcscService): {
  first: ConfigSession;
  second: ConfigSession;
  workspace: WorkspaceSession;
} {
  const first = target.sessions.create(input('US__durable_a'));
  const second = target.sessions.create(input('US__durable_b', first.workspaceId));
  const workspace = target.sessions.getWorkspace(first.id)!;
  workspace.rackArea = [
    {
      id: 'rack-physical',
      code: 'RACKCTO',
      description: '42U fixture rack',
      type: 'rack',
      size: 42,
      rackItems: [],
    },
  ];
  target.persist();
  return { first, second, workspace };
}

function input(configurationId: string, workspaceId?: string) {
  const raw: RawConfiguration = {
    id: configurationId,
    sliceCtoCode: '7D73CTO1WW',
    description: configurationId,
    type: 'SERVER',
    quantity: 1,
    totalPrice: 100,
    unitPrice: 100,
    totalPrices: [{ priceTypeId: 1, price: 100 }],
    hipoDerivedItems: [],
    hipoServiceCtoServices: [],
    connectors: [{
      port: 'RJ45', portNumber: '1', portDescription: 'Management 1',
      sourceFeature: 'BPC0', connectorFunction: 'Network',
      topologies: ['1GbE_Copper'], futureConnectorField: 'preserved',
    }],
    tabs: [{ title: 'Memory', type: 'hardware', subTabs: [{ title: 'Memory', sections: [{
      name: 'MEMORY', singleEntry: true,
      features: [{ code: 'DIMM', description: 'DIMM', max: 16 }],
      results: [{ code: 'DIMM', quantity: 1 }],
    }] }] }],
  };
  return {
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' } as const,
    solution: solution(),
    mode: 'cto' as const,
    raw,
    configurationId,
    reduced: reduceConfiguration(raw, configurationId),
    primed: true,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function physicalNode(id: string, position: number) {
  return {
    id, code: '7D73CTO1WW', type: 'server', size: 1,
    position, endPosition: position, description: 'Durable node',
  };
}

function activeConnection(sourceId: string, destinationId: string) {
  return {
    id: 'fixture-connection', sourceId, destinationId,
    sourcePortName: 'eth', sourcePortNumber: '0',
    destinationPortName: 'eth', destinationPortNumber: '1', cablePart: '3760',
  };
}

function rackInput(configurationId: string, workspaceId: string) {
  const raw: RawConfiguration = {
    id: configurationId, sliceCtoCode: 'RACKCTO', description: '42U rack', type: 'rack',
    quantity: 1, totalPrice: 500,
    tabs: [{ title: 'Power', type: 'hardware', subTabs: [{ title: 'Power', sections: [{
      name: 'PDU', singleEntry: true,
      features: [{ code: 'PDU1', description: 'Fixture PDU', max: 4 }], results: [],
    }] }] }],
  };
  return {
    locale: { country: 'US', geo: 'NA', language: 'en', currency: 'USD' } as const,
    solution: solution(), mode: 'cto' as const, raw, configurationId,
    reduced: reduceConfiguration(raw, configurationId), primed: true, workspaceId,
  };
}

function solution() {
  return { solutionMode: 'General Purpose', masterSlices: ['ISG'] };
}

function standaloneSoftwareState(): StandaloneSoftwareState {
  return {
    kind: 'standalone-software',
    launchRaw: { fixture: 'launch' },
    portalRaw: { fixture: 'portal' },
    features: [
      {
        code: 'SW-1',
        softwareCode: 'SW-1',
        description: 'Fixture software',
        unitPrice: 25,
        priceNotAvailable: false,
        showPrice: true,
        prices: [{ currency: 'USD', value: 25 }],
        attributes: { term: 'annual' },
        path: { tab: 'Software', subTab: 'Subscriptions', section: 'Fixture' },
        raw: { code: 'SW-1', futureMetadata: 'preserved' },
      },
    ],
    selections: [],
  };
}

function findConfiguration(target: DcscService, configurationId: string): ConfigSession {
  const match = target.sessions.list().find((session) => session.configurationId === configurationId);
  assert(match, `configuration ${configurationId} missing`);
  return match;
}

function installFixtureAdapter(target: DcscService): void {
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/parity/fabric-cabling.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const imported = JSON.parse(
    readFileSync(new URL('../fixtures/parity/import-layout.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  target.http.send = (async (request: {
    endpoint?: string;
    path: string;
    query?: Record<string, unknown>;
    body?: { kind: string; value?: unknown; fields?: Record<string, string> };
  }) => {
    if (request.path === '/getTopologies') return { raw: fixture.topology };
    if (request.path === '/node_roles') return { raw: fixture.roles };
    if (request.path === '/getStoragePreferences') return { raw: fixture.storage };
    if (request.path === '/solution_modes') {
      return { raw: [{
        mode: 'General Purpose', masterSlices: ['GP', 'HPCGPALL', 'HPCGPRYO'],
      }] };
    }
    if (request.path === '/multiple/cfxml_import') {
      if (scenario === 'import-standalone-software' || scenario === 'import-standalone-service') {
        const fixtureName = scenario === 'import-standalone-software'
          ? 'software-qty3-import-response.json' : 'service-qty-import-response.json';
        const standalone = JSON.parse(
          readFileSync(new URL(`../fixtures/${fixtureName}`, import.meta.url), 'utf8'),
        ) as Record<string, unknown>;
        return { raw: [standalone] };
      }
      return { raw: [structuredClone(imported)] };
    }
    if (request.path === '/ctos/7D73CTO1WW/launch') {
      return { raw: structuredClone(input('US__launch_fixture').raw) };
    }
    if (request.path === '/ctos/RACKCTO/launch') {
      return { raw: structuredClone(rackInput('US__fixture_rack', 'fixture').raw) };
    }
    if (request.path === '/ctos/racks/customize/non_rack') {
      const requested = request.body?.kind === 'json' && Array.isArray(request.body.value)
        ? request.body.value as Array<Record<string, unknown>> : [];
      return { raw: requested.map(item => ({
        code: item.code, type: item.type, size: item.type === 'rack' ? 42 : 1,
        weight: item.type === 'rack' ? 120 : 18, description: `Envelope ${String(item.code)}`,
      })) };
    }
    if (request.path === '/ctos/racks/customize') {
      const value = request.body?.kind === 'json'
        ? request.body.value as Record<string, unknown> : {};
      const rackArea = structuredClone((value.rackArea ?? []) as Array<Record<string, unknown>>);
      if (request.query?.autoArrange === true) {
        const firstItem = (rackArea[0]?.rackItems as Array<Record<string, unknown>> | undefined)?.[0];
        if (firstItem) {
          firstItem.position = 5;
          firstItem.endPosition = 5;
        }
      }
      return { raw: {
        rackArea, nonRackArea: value.nonRackArea ?? [],
        connections: value.connections ?? [], errors: [],
      } };
    }
    if (request.path === '/auto_connect') {
      const value = request.body?.kind === 'json'
        ? request.body.value as Record<string, unknown> : {};
      return { raw: {
        rackArea: value.rackArea ?? [], nonRackArea: value.nonRackArea ?? [], errors: [],
        connections: [{
          id: 'fixture-auto-connection', sourceId: 'US__durable_a', destinationId: 'US__durable_b',
          sourcePortName: 'eth', sourcePortNumber: '0', destinationPortName: 'eth',
          destinationPortNumber: '1', cablePart: '3760', cableType: 'Cat5e',
        }],
      } };
    }
    if (request.path === '/ctos/autoDerive') {
      const value = request.body?.kind === 'json'
        ? request.body.value as Record<string, unknown> : {};
      const requested = Array.isArray(value.configurations)
        ? value.configurations as RawConfiguration[] : [];
      if (request.query?.configurationId) {
        const id = String(request.query.configurationId);
        const current = target.sessions.list().find(item => item.configurationId === id)?.raw
          ?? requested.find(item => item.id === id)
          ?? requested[0];
        assert(current, `autoDerive fixture configuration ${id} missing`);
        const raw = structuredClone(current);
        const sections = raw.tabs?.flatMap(tab => tab.subTabs ?? [])
          .flatMap(subTab => subTab.sections ?? []) ?? [];
        const memory = sections.find(section => section.name === 'MEMORY');
        if (memory) memory.results = [{ code: 'DIMM', quantity: 8 }];
        const pdu = sections.find(section => section.name === 'PDU');
        if (pdu) pdu.results = [{ code: 'PDU1', quantity: 2 }];
        return { raw: { configurations: [raw] } };
      }
      const published = target.sessions.list().map(item => structuredClone(item.raw));
      const importedConfigurations = Array.isArray(imported.configuration)
        ? imported.configuration.map(item => ({
            ...(item as Record<string, unknown>), tabs: [],
          }))
        : [];
      return { raw: {
        configurations: scenario === 'copy-racked'
          ? requested
              .filter(item => String(item.sliceCtoCode ?? item.code) === 'RACKCTO')
              .map(item => {
                const id = String(item.id ?? '');
                const rack = target.sessions.list()
                  .find(candidate => candidate.configurationId === 'US__durable_rack')?.raw;
                assert(rack, `copy-racked derive fixture has no canonical rack for ${id}`);
                return { ...structuredClone(rack), id };
              })
          : scenario === 'clone-racked' && requested.length > 0
          ? requested.map(item => {
              const id = String(item.id ?? '');
              const source = target.sessions.list().find(candidate => candidate.configurationId === 'US__durable_a')?.raw;
              const rack = target.sessions.list().find(candidate => candidate.configurationId === 'US__durable_rack')?.raw;
              const base = String(item.sliceCtoCode ?? item.code) === 'RACKCTO' ? rack : source;
              assert(base, `clone-racked derive fixture has no canonical source for ${id}`);
              return { ...structuredClone(base), id };
            })
          : requested.length > 0
          ? requested.map(item => completeDerivedFixture(target, item))
          : published.length > 0
            ? published
          : importedConfigurations.length > 0
            ? importedConfigurations
            : value.configurations ?? [],
      } };
    }
    if (request.path === '/ctos/export_zip') {
      const data = JSON.parse(request.body?.fields?.data ?? '{}') as Record<string, unknown>;
      const workspace = data.workspaceInformation as Record<string, unknown> | undefined;
      const dependencies = workspace?.cloneDependency as Record<string, string[]> | undefined;
      if (scenario === 'clone-racked' || scenario === 'copy-racked') {
        const ids = ((data.configurations ?? []) as Array<Record<string, unknown>>)
          .map(configuration => String(configuration.id));
        assert(ids.length === 3, 'follow-up export payload omitted a cloned configuration');
        const sourceGroup = dependencies?.['US__durable_a'];
        if (scenario === 'clone-racked') {
          assert(sourceGroup?.[0] === 'US__durable_a' && sourceGroup.length === 2,
            'follow-up export payload omitted the racked clone dependency');
        } else {
          assert(sourceGroup?.length === 1 && sourceGroup[0] === 'US__durable_a',
            'follow-up export payload changed the source singleton dependency');
          const copyId = ids.find(id => id !== 'US__durable_a' && id !== 'US__durable_rack');
          assert(copyId && dependencies?.[copyId]?.length === 1 && dependencies[copyId]?.[0] === copyId,
            'follow-up export payload omitted the copied singleton dependency');
        }
        assert(dependencies?.['US__durable_rack']?.[0] === 'US__durable_rack',
          'follow-up export payload omitted the rack dependency');
      }
      return { stream: Readable.from(Buffer.from('fixture-clone-export')) };
    }
    if (request.path === '/lmc_validation') {
      return { raw: [{ uuid: 'durable-validation-job', buildEntityNumber: 'fixture-build' }] };
    }
    if (request.path === '/lmc_validation/result') return { raw: ['finish'] };
    if (request.path === '/ctos/standalone_software/launch') {
      return { raw: { capturedBase: true, workspace: { capturedWorkspaceField: 'preserved' } } };
    }
    if (request.path === '/software/portal/launch') return { raw: softwarePortal() };
    if (request.path === '/services/autoDerive') {
      const graph = serviceGraph();
      const value = request.body?.kind === 'json'
        ? request.body.value as { sections?: Array<{ name?: string; results?: unknown[] }> }
        : undefined;
      for (const requested of value?.sections ?? []) {
        const section = graph.tabs
          .flatMap(tab => tab.subTabs)
          .flatMap(subTab => subTab.sections)
          .find(candidate => candidate.name === requested.name);
        if (section) (section as { results: unknown[] }).results = requested.results ?? [];
      }
      return { raw: graph };
    }
    if (request.path === '/service_pacs/7D73CTO1WW') {
      return { raw: { services: [serviceFeature()] } };
    }
    if (request.path === '/services/summaries') {
      return { raw: { totalPrice: 3274, currency: 'USD', capturedSummary: true } };
    }
    throw new Error(`Unexpected network request in persistence fixture: ${request.path}`);
  }) as unknown as typeof target.http.send;
}

function completeDerivedFixture(target: DcscService, requested: RawConfiguration): RawConfiguration {
  const id = String(requested.id ?? '');
  const existing = target.sessions.list().find(item => item.configurationId === id)?.raw;
  const code = String(requested.code ?? requested.sliceCtoCode ?? 'FIXTURE');
  const base = existing
    ? structuredClone(existing)
    : code === 'RACKCTO'
      ? structuredClone(rackInput(id, 'fixture').raw)
      : { ...structuredClone(requested), tabs: [] };
  return {
    ...base,
    id,
    code: base.code ?? code,
    sliceCtoCode: base.sliceCtoCode ?? code,
    quantity: base.quantity ?? requested.quantity ?? 1,
    totalPrice: base.totalPrice ?? requested.totalPrice ?? 0,
    unitPrice: base.unitPrice ?? requested.unitPrice ?? requested.totalPrice ?? 0,
    totalPrices: base.totalPrices ?? [{ priceTypeId: 1, price: requested.totalPrice ?? 0 }],
    hipoDerivedItems: base.hipoDerivedItems ?? [],
    hipoServiceCtoServices: base.hipoServiceCtoServices ?? [],
    tabs: base.tabs ?? [],
  };
}

type ToolReply = { isError?: boolean; content: Array<{ text?: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolReply>;

function standaloneHandlers(target: DcscService): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerStandaloneTools({
    registerTool(name: string, _config: unknown, handler: ToolHandler) { handlers.set(name, handler); },
  } as unknown as McpServer, target);
  return handlers;
}

function serviceFeature() {
  return {
    code: '5WS7B99623', description: '3Yr Premier NBD', type: 'Warranty Service Upgrades',
    characterName: 'Warranty Service Upgrades', unitPrice: 1637,
    prices: [{ priceTypeId: 1, price: 1637 }], productNumber: '7D73CTO1WW',
    preSelectedQuantity: 1,
  };
}

function softwarePortal() {
  return { tabs: [{ title: 'OS & Software', subTabs: [{ title: 'Microsoft', sections: [{
    description: 'Licenses', features: [{
      softwareCode: '7S1SCTO8WW', code: '7S1S002WWW', description: 'Windows Server license',
      priceNotAvailable: false, unitPrice: 234.5,
      prices: [{ priceTypeId: 1, price: 234.5 }], showPrice: true,
      preSelectedQuantity: 0, inventory: null, capturedFeature: true,
    }],
  }] }] }] };
}

function serviceGraph() {
  return { tabs: [{ title: 'Services', subTabs: [{ title: 'A la Carte|Column2', sections: [{
    name: 'A la Carte|Column2|3 Year', description: '3 Year',
    features: [serviceFeature()], results: [],
  }] }] }] };
}

function assert<T>(value: T, message: string): asserts value is NonNullable<T> {
  if (!value) throw new Error(message);
}
