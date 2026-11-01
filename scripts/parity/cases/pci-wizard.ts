/** Native PCI wizard over stdio: slot selection, recovery, history, spare removal and the CFXML browser handoff. */
import assert from 'node:assert/strict';

import { pciWizardWireFields } from '../../../src/domain/pciWizard.js';
import type { RawConfiguration } from '../../../src/model/types.js';
import type { Harness, Json, ParityCase } from '../harness.js';

const SID = 'SID0000978';
const NODE_CODE = '7DGDCTO1WW';
const RACK_CODE = '7D6DCTO1WW';
const OPTION_ID = '1P Rear5-a';
const SPARE_SLOT = 'C62D';
const INITIAL_SLOTS = [{ code: 'C3R4', adapterCode: '' }, { code: 'C3R9', adapterCode: 'B8NY' },
  { code: 'C4U8', adapterCode: 'BK1H' }, { code: SPARE_SLOT, adapterCode: '' }];

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const values = (page: Json): Json => Object.fromEntries(rows(page['items']).map(item => [String(item['key']), item['value']]));
const slots = (raw: Json) => rows(object(pciWizardWireFields(raw as RawConfiguration)['pciWizardOption'])['results'])
  .map(result => ({ code: result['code'], adapterCode: result['adapterCode'] ?? '' }))
  .sort((left, right) => String(left.code).localeCompare(String(right.code)));

export async function runPciWizard(h: Harness, linked: boolean): Promise<void> {
  const { mcp, web, step, compare } = h;
  const memberCount = linked ? 2 : 1;
  let expected = INITIAL_SLOTS;

  const { workspace, session, initial, saved } = await step('launch', async () => {
    const launched = await mcp.call('dcsc_launch', { mode: 'reference-solution', sid: SID, solutionMode: 'General Purpose' });
    const workspace = String(launched['session']);
    const saved = () => mcp.persistedWorkspaces().find(entry => entry['id'] === workspace)!;
    const initial = saved();
    const configuration = rows(initial['configurations']).find(entry => object(entry['raw'])['code'] === NODE_CODE);
    assert(configuration, `The reference solution has no ${NODE_CODE}.`);
    let session = String(configuration['id']);
    if (linked) {
      await mcp.call('dcsc_rack_add', { session: workspace, rackCode: RACK_CODE });
      const rackId = String(rows(saved()['rackArea'])[0]!['id']);
      await mcp.call('dcsc_rack_edit', { action: 'place', session: workspace, rackId, configuration: session, uPosition: 1 });
      const cloned = await mcp.call('dcsc_rack_edit', { action: 'clone', session, count: 1, placement: 'same-rack' });
      session = String(rows(cloned['created'])[0]!['session']);
    }
    return { workspace, session, initial: configuration, saved };
  });
  const current = () => object(rows(saved()['configurations']).find(entry => entry['id'] === session)!['raw']);
  const members = () => rows(saved()['configurations']).map(entry => object(entry['raw'])).filter(raw => raw['code'] === NODE_CODE);
  const compareMembers = (name: string) => {
    compare(`${name}-multiplicity`, memberCount, members().length);
    members().forEach((raw, index) => compare(`${name}-slots-${index}`, expected, slots(raw)));
  };

  const before = await step('edit', async () => {
    const before = await mcp.call('dcsc_wizard_get', { wizard: 'pci', session });
    compare('wizard-available', true, values(before)['available']);
    await mcp.call('dcsc_wizard_get', { wizard: 'pci', session, expectedRevision: before['revision'], path: ['options', '0', 'adapterSlots'] });
    await mcp.call('dcsc_wizard_set', { wizard: 'pci', session, expectedRevision: before['revision'], optionId: OPTION_ID, rowId: '2', enabled: true });
    compare('slot-selected', expected, slots(current()));
    return before;
  });

  await step('crash-restart', async () => {
    const snapshot = mcp.persistedWorkspaces();
    await mcp.killAndRestart();
    const restarted = await mcp.call('dcsc_wizard_get', { wizard: 'pci', session });
    compare('restart-persisted-state-unchanged', snapshot, mcp.persistedWorkspaces());
    compare('restart-slots', expected, slots(current()));
    await mcp.call('dcsc_wizard_set', { wizard: 'pci', session, expectedRevision: before['revision'], optionId: OPTION_ID }, { expectError: true });
    await mcp.call('dcsc_undo', { session: workspace, action: 'undo', expectedRevision: restarted['revision'] });
    compare('undo-restores-slots', slots(object(initial['raw'])), slots(current()));
    await mcp.call('dcsc_undo', { session: workspace, action: 'redo' });
    compare('redo-restores-slots', expected, slots(current()));
  });

  await step('remove-spare', async () => {
    const removal = await mcp.call('dcsc_wizard_set', { wizard: 'pci', session, expectedRevision: saved()['revision'],
      optionId: OPTION_ID, rowId: '0', enabled: false });
    compare('removal-affects-members', memberCount, removal['affectedConfigurationCount']);
    expected = expected.filter(slot => slot.code !== SPARE_SLOT);
    compareMembers('removal');
    await mcp.killAndRestart();
    await mcp.call('dcsc_wizard_get', { wizard: 'pci', session });
    compareMembers('removal-after-restart');
  });

  await step('subsequent-derive', async () => {
    const uefi = rows(current()['tabs']).flatMap(tab => rows(tab['subTabs'])).flatMap(subTab => rows(subTab['sections']))
      .find(section => section['name'] === 'UEFI_OPERATING_MODES');
    const selected = rows(uefi?.['results'])[0];
    assert(selected, 'The reference has no UEFI selection to rederive.');
    await mcp.call('dcsc_configure', { session, changes: [{ section: 'UEFI_OPERATING_MODES', code: selected['code'], quantity: 1 }] });
    compare('derive-keeps-slots', expected, slots(current()));
    await mcp.call('dcsc_configure', { session, changes: [{ section: 'REAR_SLOT1', code: 'C3R9', quantity: 1 }] }, { expectError: true });
  });

  await step('export-import', async () => {
    const exported = await mcp.call('dcsc_export', { kind: 'reports', session: workspace, fileName: 'pci-wizard', fileTypes: ['XML'] });
    const xmlPath = String(exported['xml']);
    const imported = await mcp.call('dcsc_import', { filePath: xmlPath });
    const importedWorkspace = mcp.persistedWorkspaces().find(entry => entry['id'] === imported['session'])!;
    const importedMembers = rows(importedWorkspace['configurations']).map(entry => object(entry['raw'])).filter(raw => raw['code'] === NODE_CODE);
    compare('mcp-import-multiplicity', memberCount, importedMembers.length);
    importedMembers.forEach((raw, index) => compare(`mcp-import-slots-${index}`, expected, slots(raw)));

    const body = await web.importCfxml(xmlPath, 'mcp-export');
    const nodes = rows(body['configuration'] ?? body['configurations'])
      .filter(item => item['code'] === NODE_CODE || item['sliceCtoCode'] === NODE_CODE);
    compare('browser-import-multiplicity', memberCount, nodes.length);
    nodes.forEach((node, index) => compare(`browser-import-slots-${index}`, expected, slots(node)));
  });
}

export default {
  id: 'pci-wizard',
  tags: ['wizard', 'pci'],
  run: h => runPciWizard(h, false),
} satisfies ParityCase;
