/** Storage wizard over stdio: linked option and component edits, recovery, history and the native CFXML handoff. */
import assert from 'node:assert/strict';

import { storageWizardOption } from '../../../src/domain/storageWizard.js';
import type { RawConfiguration } from '../../../src/model/types.js';
import type { Harness, Json, ParityCase } from '../harness.js';

export type StorageWizardVariant = 'option' | 'clear' | 'raid' | 'raid-reverse' | 'sr850';

const LINKED_MEMBERS = 4;
const RAID_FORWARD_CODE = '5978';
const RAID_REVERSE_CODE = '5977';
const RAID_STORAGE_SUB_TABS = ['Controller and Backplane', 'Controllers', 'Internal Storage', 'RAID Configuration', 'Backplane'];

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const values = (page: Json): Json => Object.fromEntries(rows(page['items']).map(item => [String(item['key']), item['value']]));

const selection = (raw: Json) => {
  const option = object(storageWizardOption(raw as RawConfiguration));
  return { optionId: option['configId'], userSelected: option['userSelected'],
    features: rows(option['storageWizardTargetGroups']).flatMap(group => rows(group['features']))
      .filter(feature => Number(feature['defaultValue']) > 0)
      .map(feature => ({ code: String(feature['featureCode']), quantity: Number(feature['defaultValue']) }))
      .sort((left, right) => left.code.localeCompare(right.code)) };
};
type Selection = ReturnType<typeof selection>;

const raidState = (raw: Json, code: string) => {
  const subTabs = rows(raw['tabs']).flatMap(tab => rows(tab['subTabs']));
  const sections = subTabs.flatMap(subTab => rows(subTab['sections']));
  return {
    raid: rows(sections.find(section => section['name'] === 'RAID_CONFIG')?.['results']).map(result => ({ code: result['code'], quantity: result['quantity'] })),
    retainedStorageSelections: subTabs.filter(subTab => RAID_STORAGE_SUB_TABS.includes(String(subTab['title'])))
      .flatMap(subTab => rows(subTab['sections']).flatMap(section => rows(section['results'])).filter(result => Number(result['quantity']) > 0)).length,
    expected: [{ code, quantity: 1 }],
  };
};

export async function runStorageWizard(h: Harness, variant: StorageWizardVariant): Promise<void> {
  const { mcp, web, step, compare } = h;
  const sr850 = variant === 'sr850';
  const clear = variant === 'clear';
  const raidReverse = variant === 'raid-reverse';
  const raid = variant === 'raid' || raidReverse;
  const productCode = sr850 ? '7DJUCTO1WW' : '7DJRCTO1WW';
  const referenceId = sr850 ? 'SID0001066' : 'SID0001064';
  const targetOption = sr850 ? '13-4' : '4-2';
  const sr850Extra = sr850 ? [{ code: 'C3RU', quantity: 1 }] : [];
  const configured: Selection = { optionId: targetOption, userSelected: true,
    features: [{ code: 'B8NZ', quantity: 1 }, { code: 'C3RT', quantity: 2 }, ...sr850Extra] };
  const optionSelection: Selection = { optionId: targetOption, userSelected: true,
    features: [{ code: 'BM50', quantity: 1 }, { code: 'C3RT', quantity: 2 }, ...sr850Extra] };
  const final: Selection = raid ? { optionId: undefined, userSelected: raidReverse ? false : undefined, features: [] }
    : clear ? { optionId: undefined, userSelected: false, features: [] } : configured;
  const raidCode = raidReverse ? RAID_REVERSE_CODE : RAID_FORWARD_CODE;

  const { workspace, session, initialSelection, saved } = await step('launch', async () => {
    const launched = await mcp.call('dcsc_launch', { mode: 'reference-solution', sid: referenceId, solutionMode: 'General Purpose' });
    const workspace = String(launched['session']);
    const saved = () => mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
    const initial = saved();
    const members = rows(initial['configurations']).filter(entry => object(entry['raw'])['code'] === productCode);
    compare('reference-member-count', LINKED_MEMBERS, members.length);
    const roots = Object.keys(object(object(initial['serverState'])['cloneDependency']));
    const nonRoot = members.find(entry => !roots.includes(String(entry['configurationId'])));
    assert(nonRoot, 'The reference must expose a non-root member to edit.');
    return { workspace, session: String(nonRoot['id']), initialSelection: selection(object(nonRoot['raw'])), saved };
  });
  const current = () => object(rows(saved()['configurations']).find(entry => entry['id'] === session)!['raw']);
  const memberRaws = () => rows(saved()['configurations']).map(entry => object(entry['raw'])).filter(raw => raw['code'] === productCode);
  const compareMembers = (name: string, expectedSelection: Selection, checkRaid = false) => {
    const members = memberRaws();
    compare(`${name}-member-count`, LINKED_MEMBERS, members.length);
    members.forEach((raw, index) => {
      compare(`${name}-selection-${index}`, expectedSelection, selection(raw));
      if (checkRaid) {
        const { raid, retainedStorageSelections } = raidState(raw, raidCode);
        compare(`${name}-raid-${index}`, { raid: raidState(raw, raidCode).expected, retainedStorageSelections: 0 }, { raid, retainedStorageSelections });
      }
    });
  };
  const restart = async () => { await mcp.killAndRestart(); await mcp.call('dcsc_wizard_get', { wizard: 'storage', session }); };
  const derive = async () => {
    const uefi = rows(current()['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(subTab => rows(subTab['sections']))
      .find(section => section['name'] === 'UEFI_OPERATING_MODES');
    const selected = rows(uefi?.['results'])[0];
    assert(selected, 'The reference has no UEFI selection to rederive.');
    await mcp.call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: selected['code'], quantity: 1 }] });
  };

  const before = await step('select-option', async () => {
    const before = await mcp.call('dcsc_wizard_get', { wizard: 'storage', session });
    compare('wizard-available', true, values(before)['available']);
    await mcp.call('dcsc_wizard_get', { wizard: 'storage', session, expectedRevision: before['revision'], path: ['options'] });
    const option = await mcp.call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: before['revision'], optionId: targetOption });
    compare('option-affects-linked-members', LINKED_MEMBERS, option['affectedConfigurationCount']);
    compareMembers('option', optionSelection);
    return before;
  });

  await step('crash-restart', async () => {
    const snapshot = mcp.persistedWorkspaces();
    await mcp.killAndRestart();
    const restarted = await mcp.call('dcsc_wizard_get', { wizard: 'storage', session });
    compare('restart-persisted-state-unchanged', snapshot, mcp.persistedWorkspaces());
    compareMembers('restart', optionSelection);
    await mcp.call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: before['revision'], optionId: targetOption }, { expectError: true });
    await mcp.call('dcsc_undo', { session: workspace, action: 'undo', expectedRevision: restarted['revision'] });
    compare('undo-restores-selection', initialSelection, selection(current()));
    await mcp.call('dcsc_undo', { session: workspace, action: 'redo' });
    compareMembers('redo', optionSelection);
  });

  await step('controller-edit', async () => {
    const added = await mcp.call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: saved()['revision'],
      optionId: targetOption, feature: { groupIndex: 1, code: 'B8NZ', quantity: 1 } });
    compare('second-controller-keeps-native-diagnostics', true, Number(added['storageWizardErrorCount']) > 0);
    const removed = await mcp.call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: added['revision'],
      optionId: targetOption, feature: { groupIndex: 1, code: 'BM50', quantity: 0 } });
    compare('controller-replacement-clears-diagnostics', 0, removed['storageWizardErrorCount']);
    compareMembers('controller', configured);
    await restart();
    compareMembers('controller-after-restart', configured);
    await derive();
    compareMembers('controller-after-derive', configured);
  });

  if (clear) {
    await step('clear-option', async () => {
      const beforeRejected = mcp.persistedWorkspaces();
      await mcp.call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: saved()['revision'], optionId: null }, { expectError: true });
      compare('rejected-clear-leaves-state', beforeRejected, mcp.persistedWorkspaces());
      await mcp.call('dcsc_configure', { session, changes: [{ section: 'NONRAID_HDD', code: 'BYLR', quantity: 0 }] });
      await mcp.call('dcsc_wizard_set', { wizard: 'storage', session, expectedRevision: saved()['revision'], optionId: null });
      compareMembers('clear', final);
      await mcp.call('dcsc_undo', { session: workspace, action: 'undo' });
      compareMembers('clear-undo', configured);
      await mcp.call('dcsc_undo', { session: workspace, action: 'redo' });
      compareMembers('clear-redo', final);
      await restart();
      compareMembers('clear-after-restart', final);
      await derive();
      compareMembers('clear-after-derive', final);
    });
  }

  if (raid) {
    await step('raid-mode-switch', async () => {
      await mcp.call('dcsc_configure', { session, changes: [{ section: 'RAID_CONFIG', code: RAID_FORWARD_CODE, quantity: 1 }] });
      let undoSelection = configured;
      if (raidReverse) {
        undoSelection = selection(current());
        compare('forward-raid-clears-option', undefined, undoSelection.optionId);
        await mcp.call('dcsc_configure', { session, changes: [{ section: 'RAID_CONFIG', code: RAID_REVERSE_CODE, quantity: 1 }] });
      }
      compareMembers('raid', final, true);
      await mcp.call('dcsc_undo', { session: workspace, action: 'undo' });
      compareMembers('raid-undo', undoSelection);
      await mcp.call('dcsc_undo', { session: workspace, action: 'redo' });
      compareMembers('raid-redo', final, true);
      await restart();
      compareMembers('raid-after-restart', final, true);
      await derive();
      compareMembers('raid-after-derive', final, true);
    });
  }

  await step('export-import', async () => {
    const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'storage-wizard', fileTypes: ['XML'] });
    const xmlPath = String(exported['xml']);
    const imported = await mcp.call('dcsc_import', { filePath: xmlPath });
    const importedWorkspace = mcp.persistedWorkspaces().find(entry => entry['id'] === imported['session'])!;
    const importedMembers = rows(importedWorkspace['configurations']).map(entry => object(entry['raw'])).filter(raw => raw['code'] === productCode);
    compare('mcp-import-member-count', LINKED_MEMBERS, importedMembers.length);
    importedMembers.forEach((raw, index) => compare(`mcp-import-selection-${index}`, final, selection(raw)));

    const body = await web.importCfxml(xmlPath, 'mcp-export');
    const nodes = rows(body['configuration'] ?? body['configurations'])
      .filter(item => item['code'] === productCode || item['sliceCtoCode'] === productCode);
    assert(nodes.length > 0, 'The native import omitted the storage-wizard server.');
    nodes.forEach((node, index) => {
      compare(`browser-import-selection-${index}`, final, selection(node));
      if (raid) compare(`browser-import-raid-${index}`, raidState(node, raidCode).expected, raidState(node, raidCode).raid);
    });
    const products = rows(body['groups']).flatMap(group => rows(group['products']))
      .filter(product => product['code'] === productCode && product['type'] === 'hardware');
    compare('browser-import-commercial-quantity', LINKED_MEMBERS, products.reduce((sum, product) => sum + Number(product['quantity']), 0));
  });
}

export default {
  id: 'storage-wizard',
  tags: ['wizard', 'storage'],
  run: h => runStorageWizard(h, 'option'),
} satisfies ParityCase;
