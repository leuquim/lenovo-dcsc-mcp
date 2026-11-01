/** Nested chassis lifecycle over real stdio: nested copy, edit, unplace, detach, parent removal, Message History, SIGKILL durability, undo/redo and CFXML round trips. */
import assert from 'node:assert/strict';
import path from 'node:path';

import { inspectExportWorkbook } from '../../lib/xlsx-inspection.js';
import { readJsonProjection } from '../../lib/read-json-projection.js';
import type { Harness, Json, ParityCase } from '../harness.js';
import { rows } from '../rackUi.js';
import { object } from '../softwareSummaryUi.js';

const MODE = 'HPC and AI - Systems';
const CHASSIS_CODE = '7DD0CTOLWW';
const NODE_CODE = '7DD1CTOLWW';
const RACK_CODE = '7D6DCTO1WW';
const FIXTURES = path.resolve('test/fixtures/parity/xml');
const RACKED_XML = path.join(FIXTURES, 'nested-racked-browser.xml');
const LOOSE_XML = path.join(FIXTURES, 'nested-loose-browser.xml');
const DETACHED_XML = path.join(FIXTURES, 'nested-detached-browser.xml');
const NATIVE_DETACHED_NODE = 'US__-b01d-4208-99bc-55c8cc5464cf1000';
const REPORT_TYPES = ['XML', 'QUOTE', 'MESSAGE_HISTORY'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;

type Placement = 'nested' | 'loose' | 'detached';
interface ExpectedHistory { command: string; code?: string; type?: string; location?: string; quantity?: number; descriptionIncludes?: string }

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const historyValues = (saved: Json): unknown[] => {
  const state = object(saved['serverState']);
  return Array.isArray(state['historyInformation']) ? state['historyInformation']
    : (Array.isArray(object(state['messageHistory'])['history']) ? object(state['messageHistory'])['history'] as unknown[] : []);
};
const historyRows = (saved: Json) => historyValues(saved).map(object).filter(row => Object.keys(row).length > 0);
const stableRow = (row: Json) => ({ timestamp: row['timestamp'], key: row['key'], command: row['command'], description: row['description'], sessionTimestamp: row['sessionTimestamp'] });
const semanticState = (saved: Json) => ({
  configurations: rows(saved['configurations']).map(entry => ({ id: entry['id'], configurationId: entry['configurationId'], raw: entry['raw'] })),
  rackArea: saved['rackArea'], nonRackArea: saved['nonRackArea'], floorItems: saved['floorItems'], cables: saved['cables'],
  powerSelections: saved['powerSelections'], cloneDependency: object(saved['serverState'])['cloneDependency'],
  cloneDependencyColor: object(saved['serverState'])['cloneDependencyColor'],
});
const physicalIds = (value: unknown): string[] => rows(value).flatMap(item =>
  [String(item['id']), ...physicalIds([...rows(item['rackItems']), ...rows(item['items']), ...rows(item['nodes'])])]);
const placementOf = (saved: Json, nodeId: string): Placement =>
  physicalIds(saved['rackArea']).includes(nodeId) ? 'nested' : physicalIds(saved['nonRackArea']).includes(nodeId) ? 'loose' : 'detached';
const projectionOf = (saved: Json) => ({
  configurations: rows(saved['configurations']).map(item => ({ id: item['id'], productCode: object(item['product'])['code'], quantity: object(item['raw'])['quantity'] })),
  rackArea: saved['rackArea'], nonRackArea: saved['nonRackArea'],
  cloneDependency: object(saved['serverState'])['cloneDependency'] ?? {}, cloneDependencyColor: object(saved['serverState'])['cloneDependencyColor'] ?? {},
});

/** What a freshly appended native-shaped Message History row must look like, as booleans. */
function appendedFacts(before: Json | undefined, after: Json, expected: ExpectedHistory) {
  const prior = before ? historyValues(before) : [];
  const current = historyValues(after);
  const row = object(current.at(-1));
  const description = String(row['description'] ?? '');
  const title = `${expected.command.charAt(0)}${expected.command.slice(1).toLowerCase()}`;
  const prefix = expected.quantity === undefined ? `${title} :` : `${title} x${expected.quantity}:`;
  return {
    appended: current.length - prior.length,
    priorRowsKept: JSON.stringify(current.slice(0, prior.length)) === JSON.stringify(prior),
    command: row['command'],
    keyIsUuid: UUID_V4.test(String(row['key'] ?? '')),
    timestampsNative: NATIVE_TIMESTAMP.test(String(row['timestamp'] ?? '')) && NATIVE_TIMESTAMP.test(String(row['sessionTimestamp'] ?? '')),
    tooltipEmpty: row['tooltip'] === '',
    description: description.startsWith(prefix)
      && (!expected.code || description.includes(expected.code.toUpperCase()))
      && (!expected.type || description.includes(` ${expected.type} `))
      && (!expected.descriptionIncludes || description.includes(expected.descriptionIncludes))
      && (!expected.location || description.endsWith(` at ${expected.location}`)),
  };
}
const expectedFacts = (expected: ExpectedHistory) =>
  ({ appended: 1, priorRowsKept: true, command: expected.command, keyIsUuid: true, timestampsNative: true, tooltipEmpty: true, description: true });

/** Rows of `expected` that `actual` lost or changed. */
function missingHistory(expected: Json, actual: Json): string[] {
  const counts = new Map<string, number>();
  for (const row of historyRows(actual)) counts.set(JSON.stringify(stableRow(row)), (counts.get(JSON.stringify(stableRow(row))) ?? 0) + 1);
  const missing: string[] = [];
  const wanted = new Map<string, number>();
  for (const row of historyRows(expected)) if (String(row['key'] ?? '')) wanted.set(JSON.stringify(stableRow(row)), (wanted.get(JSON.stringify(stableRow(row))) ?? 0) + 1);
  for (const [signature, count] of wanted) if ((counts.get(signature) ?? 0) < count) missing.push(signature);
  return missing;
}

async function historyMissingFromWorkbook(zipPath: string, expected: Json[]): Promise<string[]> {
  const sheet = (await inspectExportWorkbook(zipPath)).sheets['Message History'];
  assert(sheet, 'Export has no Message History sheet.');
  const values = sheet.rows.flatMap(row => row.values);
  const wanted = new Map<string, number>();
  for (const row of expected) wanted.set(String(row['description']), (wanted.get(String(row['description'])) ?? 0) + 1);
  return [...wanted].filter(([description, count]) => values.filter(value => value === description).length < count).map(([description]) => description);
}

export default {
  id: 'nested-lifecycle',
  tags: ['rack', 'nested', 'recovery'],
  async run(h: Harness) {
    const { mcp, step, compare } = h;
    const saved = (id: string) => mcp.persistedWorkspaces().find(entry => entry['id'] === id)!;
    const configBySession = (state: Json, session: string) => rows(state['configurations']).find(entry => entry['id'] === session)!;
    const edit = (session: string, args: Json) => mcp.call('dcsc_rack_edit', { session, ...args });
    const undo = (session: string, action: 'undo' | 'redo') => mcp.call('dcsc_undo', { session, action });
    const exportReports = (session: string, fileName: string) => mcp.call('dcsc_export', { kind: 'reports', session, fileName, fileTypes: REPORT_TYPES });
    const projectionOnWire = async (workspace: string): Promise<unknown> => {
      const info = await mcp.call('dcsc_workspace_get', { session: workspace });
      const detail = (detailPath: string[], type: 'object' | 'array') => readJsonProjection(
        (tool, args) => mcp.call(tool, args), { tool: 'dcsc_workspace_get',
          arguments: { session: workspace, view: 'layout', expectedRevision: Number(info['revision']), path: detailPath, offset: 0, limit: 50 } }, type);
      return {
        configurations: rows(info['configurations']).map(item => ({ id: item['id'], productCode: item['productCode'], quantity: item['quantity'] })),
        rackArea: await detail(['rawRackArea'], 'array'), nonRackArea: await detail(['rawNonRackArea'], 'array'),
        cloneDependency: await detail(['cloneDependency'], 'object'), cloneDependencyColor: await detail(['cloneDependencyColor'], 'object'),
      };
    };
    const appended = (label: string, before: Json | undefined, after: Json, expected: ExpectedHistory) =>
      compare(`${label}-history`, expectedFacts(expected), appendedFacts(before, after, expected));
    /** The accepted state must survive SIGKILL: persisted state, history and the public projection are unchanged. */
    const survivesCrash = async (label: string, workspace: string, accepted: Json) => {
      await mcp.killAndRestart();
      const restored = saved(workspace);
      compare(`${label}-survives-sigkill`, { state: semanticState(accepted), history: historyValues(accepted), projection: projectionOf(accepted) },
        { state: semanticState(restored), history: historyValues(restored), projection: await projectionOnWire(workspace) });
    };
    const importHistory = (state: Json) => {
      const row = object(historyValues(state).at(-1));
      return { command: row['command'], description: row['description'], sessionStartsAtImport: object(state['serverState'])['actionHistorySessionTimestamp'] === row['timestamp'] };
    };
    const expectedImportHistory = (filePath: string) => ({ command: 'IMPORT', description: `Import : ${path.basename(filePath)}`, sessionStartsAtImport: true });

    const ids = await step('build-nested-workspace', async () => {
      const chassis = await mcp.call('dcsc_launch', { productCode: CHASSIS_CODE, mode: 'cto', solutionMode: MODE });
      const workspace = String(chassis['workspace']);
      const chassisSession = String(chassis['session']);
      const afterChassis = saved(workspace);
      const chassisId = String(configBySession(afterChassis, chassisSession)['configurationId']);
      appended('launch-chassis', undefined, afterChassis, { command: 'ADD', type: 'Chassis', code: CHASSIS_CODE, location: 'Non Rack Area' });
      const node = await mcp.call('dcsc_launch', { productCode: NODE_CODE, mode: 'cto', solutionMode: MODE, session: workspace });
      const nodeSession = String(node['session']);
      const afterNode = saved(workspace);
      appended('launch-node', afterChassis, afterNode, { command: 'ADD', type: 'Node', code: NODE_CODE, location: 'Non Rack Area' });
      const added = await mcp.call('dcsc_rack_add', { session: workspace, rackCode: RACK_CODE });
      const rackId = String(rows(added['racks'])[0]?.['rackId']);
      const beforePlacement = saved(workspace);
      appended('add-rack', afterNode, beforePlacement, { command: 'ADD', type: 'Rack', code: RACK_CODE, location: 'Rack Area' });
      await edit(workspace, { action: 'place', rackId, configuration: chassisSession });
      const afterChassisPlacement = saved(workspace);
      appended('place-chassis', beforePlacement, afterChassisPlacement, { command: 'MOVE', type: 'Chassis', code: CHASSIS_CODE });
      const placed = await edit(workspace, { action: 'place', rackId, chassisId, configuration: nodeSession });
      const nested = object(placed['nestedPlacement']);
      const copySession = String(nested['session']);
      const copyId = String(nested['nodeId']);
      const accepted = saved(workspace);
      compare('copy-node-placement', { chassisId, copyConfigurationId: copyId, copyDependency: [copyId] },
        { chassisId: nested['chassisId'], copyConfigurationId: configBySession(accepted, copySession)['configurationId'],
          copyDependency: object(object(accepted['serverState'])['cloneDependency'])[copyId] });
      appended('copy-node', afterChassisPlacement, accepted, { command: 'COPY', quantity: 1, type: 'Node', code: NODE_CODE, descriptionIncludes: 'ThinkSystem SD535 V3', location: 'Chassis' });
      await survivesCrash('copy-node', workspace, accepted);
      return { workspace, rackId, chassisId, nodeSession, copySession, copyId };
    });
    const { workspace, rackId, chassisId, nodeSession, copySession, copyId } = ids;

    await step('independent-copy-edit', async () => {
      const options = await mcp.call('dcsc_configuration_get', { session: copySession, view: 'options', query: 'processor', limit: 100 });
      const choice = rows(options['options']).find(option => option['selected'] !== true && option['sectionId'] && option['code']);
      assert(choice, 'No alternate processor option was available for the copied node.');
      const before = saved(workspace);
      await mcp.call('dcsc_configure', { session: copySession, changes: [{ section: choice['sectionId'], code: choice['code'], quantity: 1 }] });
      const after = saved(workspace);
      compare('copy-edit-isolated', { sourceUnchanged: true, copyChanged: true },
        { sourceUnchanged: JSON.stringify(configBySession(after, nodeSession)['raw']) === JSON.stringify(configBySession(before, nodeSession)['raw']),
          copyChanged: JSON.stringify(configBySession(after, copySession)['raw']) !== JSON.stringify(configBySession(before, copySession)['raw']) });
      appended('independent-copy-edit', before, after, { command: 'UPDATE', type: 'Node', code: NODE_CODE });
    });

    const unplacedExport = await step('unplace-chassis', async () => {
      const before = saved(workspace);
      await edit(workspace, { action: 'unplace', configuration: chassisId });
      const unplaced = saved(workspace);
      const looseChassis = rows(unplaced['nonRackArea']).find(item => item['id'] === chassisId);
      compare('unplace-chassis-keeps-nested-node', true, rows(looseChassis?.['nodes']).some(item => item['id'] === copyId));
      appended('unplace-chassis', before, unplaced, { command: 'MOVE', type: 'Chassis', code: CHASSIS_CODE, location: 'Non Rack Area' });
      await undo(workspace, 'undo');
      const undone = saved(workspace);
      compare('unplace-chassis-undo', { nestedRestored: true, history: historyValues(before) }, { nestedRestored: JSON.stringify(undone['rackArea']).includes(copyId), history: historyValues(undone) });
      await undo(workspace, 'redo');
      const redone = saved(workspace);
      compare('unplace-chassis-redo', { state: semanticState(unplaced), history: historyValues(unplaced) }, { state: semanticState(redone), history: historyValues(redone) });
      const exported = await exportReports(workspace, 'nested-unplaced');
      compare('unplaced-export-history-sheet', [], await historyMissingFromWorkbook(String(exported['zipPath']), historyRows(unplaced)));
      await edit(workspace, { action: 'move', configuration: chassisId, rackId });
      const replaced = saved(workspace);
      compare('replace-chassis-keeps-nested-node', true, JSON.stringify(replaced['rackArea']).includes(copyId));
      appended('replace-chassis', unplaced, replaced, { command: 'MOVE', type: 'Chassis', code: CHASSIS_CODE });
      return { exported, unplaced };
    });

    const replaced = saved(workspace);
    const nodeEditImport = async (label: string, filePath: string, nodeConfigurationId: string, expected: Placement, expectedConfigurations: number) => {
      const imported = await mcp.call('dcsc_import', { filePath, solutionMode: MODE });
      const importedWorkspace = String(imported['session']);
      const accepted = saved(importedWorkspace);
      const dependencies = object(object(accepted['serverState'])['cloneDependency']);
      const colors = object(object(accepted['serverState'])['cloneDependencyColor']);
      compare(`${label}-import`, { history: expectedImportHistory(filePath), configurations: expectedConfigurations,
        nodeConfigured: expected === 'loose', placement: expected, colorPresent: expected === 'loose',
        dependencyWellFormed: true },
      { history: importHistory(accepted), configurations: rows(accepted['configurations']).length,
        nodeConfigured: rows(accepted['configurations']).some(entry => entry['configurationId'] === nodeConfigurationId),
        placement: placementOf(accepted, nodeConfigurationId), colorPresent: Object.hasOwn(colors, nodeConfigurationId),
        dependencyWellFormed: !Object.hasOwn(dependencies, nodeConfigurationId) || strings(dependencies[nodeConfigurationId]).includes(nodeConfigurationId) });
      await survivesCrash(`${label}-import`, importedWorkspace, accepted);
      const exported = await exportReports(importedWorkspace, `nested-${label}-imported`);
      compare(`${label}-import-exports`, true, typeof exported['xml'] === 'string' && exported['xml'].length > 0);
      return importedWorkspace;
    };

    await step('detach-node', async () => {
      await edit(workspace, { action: 'detach', configuration: copyId });
      await mcp.killAndRestart();
      const detached = saved(workspace);
      const dependencies = object(object(detached['serverState'])['cloneDependency']);
      compare('detach-node-state', { configurations: rows(replaced['configurations']).length, placement: 'detached', dependencyKept: false, colorKept: false },
        { configurations: rows(detached['configurations']).length, placement: placementOf(detached, copyId), dependencyKept: Object.hasOwn(dependencies, copyId),
          colorKept: Object.hasOwn(object(object(detached['serverState'])['cloneDependencyColor']), copyId) });
      appended('detach-node', replaced, detached, { command: 'REMOVE', type: 'Node', code: NODE_CODE, location: 'Chassis' });
      compare('detach-node-projection', projectionOf(detached), await projectionOnWire(workspace));
      await undo(workspace, 'undo');
      const undone = saved(workspace);
      compare('detach-node-undo', { placement: 'nested', history: historyValues(replaced) }, { placement: placementOf(undone, copyId), history: historyValues(undone) });
      await undo(workspace, 'redo');
      const redone = saved(workspace);
      compare('detach-node-redo', { state: semanticState(detached), history: historyValues(detached) }, { state: semanticState(redone), history: historyValues(redone) });
      const exported = await exportReports(workspace, 'nested-detached-node');
      compare('detached-export', { historySheetMissing: [], droppedOnReimport: 1, warning: true },
        { historySheetMissing: await historyMissingFromWorkbook(String(exported['zipPath']), historyRows(detached)),
          droppedOnReimport: exported['detachedNodesDroppedOnReimport'], warning: /Lenovo reimport drops physically detached nodes/.test(String(exported['reimportWarning'] ?? '')) });
      const reimported = await nodeEditImport('detached-node', String(exported['xml']), copyId, 'detached', 3);
      compare('detached-cfxml-history', [], missingHistory(detached, saved(reimported)));
      await nodeEditImport('native-detached-node', DETACHED_XML, NATIVE_DETACHED_NODE, 'detached', 3);
    });

    await step('unplace-node', async () => {
      await undo(workspace, 'undo');
      compare('restore-before-unplace-node', { placement: 'nested', history: historyValues(replaced) }, { placement: placementOf(saved(workspace), copyId), history: historyValues(saved(workspace)) });
      await edit(workspace, { action: 'unplace', configuration: copyId });
      await mcp.killAndRestart();
      const loose = saved(workspace);
      const dependencies = object(object(loose['serverState'])['cloneDependency']);
      compare('unplace-node-state', { configurations: rows(replaced['configurations']).length, placement: 'loose', dependencyKept: true, colorKept: true },
        { configurations: rows(loose['configurations']).length, placement: placementOf(loose, copyId), dependencyKept: Object.hasOwn(dependencies, copyId),
          colorKept: Object.hasOwn(object(object(loose['serverState'])['cloneDependencyColor']), copyId) });
      appended('unplace-node', replaced, loose, { command: 'MOVE', type: 'Node', code: NODE_CODE, location: 'Non Rack Area' });
      compare('unplace-node-projection', projectionOf(loose), await projectionOnWire(workspace));
      await undo(workspace, 'undo');
      compare('unplace-node-undo', { placement: 'nested', history: historyValues(replaced) }, { placement: placementOf(saved(workspace), copyId), history: historyValues(saved(workspace)) });
      await undo(workspace, 'redo');
      const redone = saved(workspace);
      compare('unplace-node-redo', { state: semanticState(loose), history: historyValues(loose) }, { state: semanticState(redone), history: historyValues(redone) });
      const exported = await exportReports(workspace, 'nested-unplaced-node');
      compare('unplaced-node-export-history-sheet', [], await historyMissingFromWorkbook(String(exported['zipPath']), historyRows(loose)));
      const reimported = await nodeEditImport('loose-node', String(exported['xml']), copyId, 'loose', 4);
      compare('loose-node-cfxml-history', [], missingHistory(loose, saved(reimported)));
    });

    await step('final-state-and-imports', async () => {
      await undo(workspace, 'undo');
      const restored = saved(workspace);
      compare('restore-final-nested-state', { placement: 'nested', history: historyValues(replaced) }, { placement: placementOf(restored, copyId), history: historyValues(restored) });
      const exported = await exportReports(workspace, 'nested-final');
      compare('final-export-history-sheet', [], await historyMissingFromWorkbook(String(exported['zipPath']), historyRows(restored)));
      await survivesCrash('final', workspace, restored);

      const looseImport = async (label: string, filePath: string) => {
        const imported = await mcp.call('dcsc_import', { filePath, solutionMode: MODE });
        const id = String(imported['session']);
        const accepted = saved(id);
        const chassis = rows(accepted['nonRackArea']).find(item => item['type'] === 'chassis');
        const childId = String(rows(chassis?.['nodes'])[0]?.['id']);
        compare(`${label}-import`, { history: expectedImportHistory(filePath), hydratedNodes: 1, childConfigured: true },
          { history: importHistory(accepted), hydratedNodes: rows(chassis?.['nodes']).length,
            childConfigured: rows(accepted['configurations']).some(entry => entry['configurationId'] === childId) });
        await survivesCrash(`${label}-import`, id, accepted);
        return id;
      };
      await looseImport('native-loose', LOOSE_XML);
      const unplacedWorkspace = await looseImport('mcp-loose', String(unplacedExport.exported['xml']));
      compare('unplaced-chassis-cfxml-history', [], missingHistory(unplacedExport.unplaced, saved(unplacedWorkspace)));
    });

    for (const contents of ['delete', 'unplace'] as const) {
      await step(`parent-remove-${contents}`, async () => {
        const label = `parent-remove-${contents}`;
        const imported = await mcp.call('dcsc_import', { filePath: RACKED_XML, solutionMode: MODE });
        const id = String(imported['session']);
        const before = saved(id);
        const chassis = rows(rows(before['rackArea'])[0]?.['rackItems']).find(item => item['type'] === 'chassis');
        assert(chassis, `${label} fixture has no racked chassis.`);
        const parentId = String(chassis['id']);
        const childId = String(rows(chassis['nodes'])[0]?.['id']);
        const beforeDependencies = object(object(before['serverState'])['cloneDependency']);
        const beforeColors = object(object(before['serverState'])['cloneDependencyColor']);
        await edit(id, { action: 'remove', configuration: parentId, contents });
        await mcp.killAndRestart();
        const accepted = saved(id);
        const configurationIds = rows(accepted['configurations']).map(entry => String(entry['configurationId']));
        const removedIds = new Set(contents === 'delete' ? [parentId, childId] : [parentId]);
        const retained = (value: Json) => Object.keys(value).filter(key => !removedIds.has(key)).sort();
        compare(`${label}-state`, { chassisConfigured: false, childConfigured: contents === 'unplace', chassisRacked: false, childPlacement: contents === 'unplace' ? 'loose' : 'detached',
          dependencies: retained(beforeDependencies), colors: retained(beforeColors) },
        { chassisConfigured: configurationIds.includes(parentId), childConfigured: configurationIds.includes(childId), chassisRacked: physicalIds(accepted['rackArea']).includes(parentId),
          childPlacement: placementOf(accepted, childId), dependencies: Object.keys(object(object(accepted['serverState'])['cloneDependency'])).sort(),
          colors: Object.keys(object(object(accepted['serverState'])['cloneDependencyColor'])).sort() });
        appended(label, before, accepted, { command: 'REMOVE', type: 'Chassis', code: CHASSIS_CODE });
        compare(`${label}-projection`, projectionOf(accepted), await projectionOnWire(id));
        await undo(id, 'undo');
        const undone = saved(id);
        compare(`${label}-undo`, { nestedRestored: true, history: historyValues(before) },
          { nestedRestored: physicalIds(undone['rackArea']).includes(parentId) && physicalIds(undone['rackArea']).includes(childId), history: historyValues(undone) });
        await undo(id, 'redo');
        const redone = saved(id);
        compare(`${label}-redo`, { state: semanticState(accepted), history: historyValues(accepted) }, { state: semanticState(redone), history: historyValues(redone) });
        const exported = await exportReports(id, `nested-${label}`);
        compare(`${label}-history-sheet`, [], await historyMissingFromWorkbook(String(exported['zipPath']), historyRows(accepted)));
        const reimported = await mcp.call('dcsc_import', { filePath: String(exported['xml']), solutionMode: MODE });
        const roundTrip = saved(String(reimported['session']));
        const roundTripIds = rows(roundTrip['configurations']).map(entry => String(entry['configurationId']));
        compare(`${label}-roundtrip`, { configurations: contents === 'unplace' ? 3 : 2, chassisConfigured: false, childConfigured: contents === 'unplace', chassisRacked: false,
          childPlacement: contents === 'unplace' ? 'loose' : 'detached', historyMissing: [] },
        { configurations: roundTripIds.length, chassisConfigured: roundTripIds.includes(parentId), childConfigured: roundTripIds.includes(childId),
          chassisRacked: physicalIds(roundTrip['rackArea']).includes(parentId), childPlacement: placementOf(roundTrip, childId), historyMissing: missingHistory(accepted, roundTrip) });
      });
    }
  },
} satisfies ParityCase;
