import type { RawConfiguration } from '../model/types.js';
import { serializeSections, type WireSection } from './dcscWire.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];

export interface StorageWizardChange {
  optionId: string | null;
  feature?: { groupIndex: number; code: string; quantity: number };
}

export function storageWizardOptions(raw: RawConfiguration): Obj[] {
  const wizard = object(raw['storageWizard']);
  if (wizard['storageWizardUI'] !== true) return [];
  return structuredClone(rows(wizard['storageWizardOptions'])).map(option => {
    if (option['solutionPrice'] === undefined) {
      const selected = rows(option['storageWizardTargetGroups']).flatMap(g => rows(g['features']))
        .filter(f => Number(f['defaultValue']) > 0);
      const unavailable = option['priceNotAvailable'] === true || selected.some(f => f['priceNotAvailable'] === true ||
        (f['noCharge'] !== true && typeof f['unitPrice'] !== 'number'));
      const price = unavailable ? 'priceNotAvailable' : Math.round(selected.reduce((sum, f) => sum +
        (f['noCharge'] === true ? 0 : Number(f['unitPrice']) * Number(f['defaultValue'])), 0) * 100) / 100;
      option['solutionPrice'] = price;
      option['solutionPriceNum'] = typeof price === 'number' ? price : null;
    }
    return option;
  });
}

export function storageWizardOption(raw: RawConfiguration): Obj | null {
  const options = storageWizardOptions(raw);
  if (options.length === 0) return null;
  const active = options.filter(o => o['activate'] === true);
  if (active.length > 1) throw new Error('Configuration has ambiguous active storage wizard options.');
  return active[0] ?? { activate: false, userSelected: false };
}

export function stageStorageWizardChange(raw: RawConfiguration, change: StorageWizardChange): RawConfiguration {
  const options = storageWizardOptions(raw);
  if (change.optionId === null) {
    if (change.feature) throw new Error('Clear the storage option separately from component edits.');
    if (options.length === 0) throw new Error('This configuration has no available storage wizard.');
    if (storageWizardDriveSelections(serializeSections(raw)).some(d => d.quantity > 0)) {
      throw new Error('Remove configured storage drives before clearing the controller/backplane option.');
    }
    for (const option of options) { option['activate'] = false; option['userSelected'] = false; delete option['delta']; }
    return { ...structuredClone(raw), storageWizard: { ...structuredClone(object(raw['storageWizard'])), storageWizardOptions: options } };
  }
  const matching = options.filter(o => o['configId'] === change.optionId);
  if (matching.length !== 1) throw new Error('Choose an exact storage wizard option from the current configuration.');
  const selected = matching[0]!;
  if (change.feature) {
    if (selected['activate'] !== true) throw new Error('Select this storage option before editing its components.');
    const { groupIndex, code, quantity } = change.feature;
    const group = rows(selected['storageWizardTargetGroups'])[groupIndex];
    const matches = rows(group?.['features']).filter(f => f['featureCode'] === code);
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || matches.length !== 1) throw new Error('Choose an exact feature and group from the storage wizard.');
    const feature = matches[0]!;
    if (!Number.isInteger(quantity) || quantity < 0 || !Array.isArray(feature['quantityOptions']) || !feature['quantityOptions'].includes(quantity)) {
      throw new Error('Choose an offered storage wizard quantity for this feature.');
    }
    feature['defaultValue'] = quantity;
    selected['delta'] = { section: feature['characterName'], productNumber: raw.sliceCtoCode ?? raw.ctoCode ?? raw.code,
      featureCode: code, quantity, isClear: quantity === 0, mergeCtoCode: '', type: 'hardware' };
  } else selected['delta'] = null;
  for (const option of options) option['activate'] = option === selected;
  selected['userSelected'] = true;
  return { ...structuredClone(raw), storageWizard: { ...structuredClone(object(raw['storageWizard'])), storageWizardOptions: options } };
}

/** Native query builder emits selected wizard features outside Controller and Backplane. */
export function storageWizardSections(raw: RawConfiguration, sections: WireSection[], detectDriveChanges = false): WireSection[] {
  const option = storageWizardOption(raw);
  if (!option) return sections;
  const names = new Set(rows(option['storageWizardTargetGroups']).flatMap(g => rows(g['features'])).map(f => f['characterName']));
  const result = structuredClone(sections.filter(s => s.subTabTitle !== 'Controller and Backplane' && !names.has(s.name)));
  const changed = detectDriveChanges && JSON.stringify(storageWizardDriveSelections(sections)) !==
    JSON.stringify(storageWizardDriveSelections(serializeSections(raw)));
  if (option['activate'] !== true || (changed && option['userSelected'] !== true)) return result;
  for (const group of rows(option['storageWizardTargetGroups'])) {
    for (const feature of rows(group['features'])) {
      const quantity = feature['defaultValue'];
      if (quantity === 0 || quantity === undefined) continue;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0 ||
          typeof feature['characterName'] !== 'string' || typeof feature['featureCode'] !== 'string') {
        throw new Error('Selected storage wizard component has no valid native identity or quantity.');
      }
      let section = result.find(s => s.name === feature['characterName']);
      if (!section) {
        section = { name: feature['characterName'], multipleSelectable: false, type: 'hardware', results: [] };
        result.push(section);
      }
      section.results.push({ code: feature['featureCode'], quantity, ctoCode: String(raw.sliceCtoCode ?? raw.ctoCode ?? raw.code),
        ...(typeof feature['description'] === 'string' ? { description: feature['description'] } : {}),
        ...(typeof feature['displayCode'] === 'string' ? { optionCode: feature['displayCode'] } : {}),
        ...(feature['shippingstatus'] !== undefined ? { shippingstatus: feature['shippingstatus'] } : {}),
        type: 'hardware', storageWizardDerived: true, storageWizardDerivedQuantity: quantity });
    }
  }
  return result;
}


/** SPA SECTIONS_FOR_HDD_FEATURES, also used by the no-HDD deselection guard. */
export function storageWizardDriveSelections(sections: WireSection[]): Array<{ code: string; quantity: number }> {
  return sections.filter(s => s.subTabTitle === 'Internal Storage' && ['NONRAID_HDD', 'CXL_MEMORY'].includes(s.name))
    .flatMap(s => s.results.map(r => ({ code: r.code, quantity: r.quantity })))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Native RAID Type radio groups: 2212 and 5977 have the same clearing behavior. */
export function isStorageRaidModeChange(raw: RawConfiguration, code: string): boolean {
  if (object(raw['storageWizard'])['storageWizardUI'] !== true) return false;
  const section = raw.tabs?.find(t => t.title === 'Storage')?.subTabs
    ?.find(t => t.title === 'RAID Type')?.sections?.find(s => s.name === 'RAID_CONFIG');
  if (!section) return false;
  const modes: Record<string, string> = { '5978': '5978', '5977': '5977', '2212': '5977' };
  const previous = section.results?.[0]?.code ?? '';
  return modes[code] !== undefined && modes[previous] !== modes[code];
}

/** CTO buildQueryStorageWizard clearing; LFO requires fixed/preselected restoration. */
export function clearStorageRaidSections(raw: RawConfiguration, sections: WireSection[]): WireSection[] {
  const tabs = new Set(['Controller and Backplane', 'Controllers', 'RAID Configuration', 'Internal Storage', 'Backplane']);
  const names = new Set((raw.tabs ?? []).flatMap(t => t.subTabs ?? [])
    .filter(t => tabs.has(t.title ?? '')).flatMap(t => t.sections ?? []).map(s => s.name));
  // Reduced wizard components have no subTabTitle, unlike the catalog sections.
  for (const option of storageWizardOptions(raw)) {
    for (const group of rows(option['storageWizardTargetGroups'])) {
      for (const feature of rows(group['features'])) {
        if (typeof feature['characterName'] === 'string') names.add(feature['characterName']);
      }
    }
  }
  return sections.filter(s => !tabs.has(s.subTabTitle ?? '') && !names.has(s.name) && s.name !== 'DERIVE_CABLE');
}
