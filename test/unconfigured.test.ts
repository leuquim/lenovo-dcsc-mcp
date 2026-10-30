import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { DcscService } from '../src/mcp/service.js';
import { ConfigSchema } from '../src/config/schema.js';
import { hydrateUnconfiguredCatalog, preserveUnconfiguredSelections, stageUnconfiguredSelection, unconfiguredProducts } from '../src/domain/unconfigured.js';
import { buildExportGroups } from '../src/domain/exportGroups.js';
import { configurationListPrice } from '../src/domain/pricing.js';
import { reduceConfiguration, buildExportConfiguration } from '../src/domain/reduce.js';
import type { RawConfiguration } from '../src/model/types.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity/reference-unconfigured.json', import.meta.url), 'utf8')) as {
  before: RawConfiguration; derived: RawConfiguration; exportedSoftware: Record<string, unknown>;
  exportedProducts: Array<Record<string, unknown>>;
};
it('loads native choices without dropping imported selections or changing configuration identity', () => {
  const catalog = structuredClone(fixture.before);
  catalog.tabs![0]!.subTabs![0]!.sections![0]!.results = [];
  catalog.id = 'catalog-id';
  const hydrated = hydrateUnconfiguredCatalog(fixture.before, catalog);
  expect(hydrated.id).toBe(fixture.before.id);
  expect(unconfiguredProducts(hydrated)).toEqual(unconfiguredProducts(fixture.before));
  expect(hydrated.tabs![0]).toMatchObject({ mockTab: false });
  expect(catalog.tabs![0]!.subTabs![0]!.sections![0]!.results).toEqual([]);
  const repriced = structuredClone(catalog);
  const feature = repriced.tabs![0]!.subTabs![0]!.sections![0]!.features![0]!;
  feature.unitPrice = 6000;
  feature['prices'] = [{ price: 6000, priceTypeId: 1 }];
  const refreshed = hydrateUnconfiguredCatalog(fixture.before, repriced);
  expect(configurationListPrice(refreshed)).toBe(88621.54);
  expect(unconfiguredProducts(refreshed)[0]!.price).toBe(48000);
  expect(hydrateUnconfiguredCatalog(refreshed, repriced).totalPrice).toBe(refreshed.totalPrice);
  catalog.tabs![0]!.subTabs![0]!.sections![0]!.features = [];
  expect(() => hydrateUnconfiguredCatalog(fixture.before, catalog)).toThrow('cannot preserve selected feature');
  expect(() => hydrateUnconfiguredCatalog(fixture.before, { tabs: [] })).toThrow('no Unconfigured catalog');
});
it('stages local unconfigured quantity changes, removal and re-addition without touching the source', () => {
  const change = { sectionName: 'UNCONFIGURED_COMMVAULT_SOFTWARE', code: '7S1M004HWW', quantity: 4 };
  const next = stageUnconfiguredSelection(fixture.before, change);
  expect(configurationListPrice(next)).toBe(60759.54);
  expect(unconfiguredProducts(next)[0]!.quantity).toBe(4);
  const nativeEdited = JSON.parse(readFileSync(new URL('./fixtures/parity/reference-unconfigured-edited.json', import.meta.url), 'utf8')) as {
    totalPrice: number; products: Array<Record<string, unknown>>;
  };
  expect(configurationListPrice(next)).toBe(nativeEdited.totalPrice);
  expect(buildExportGroups(next, String(next.id))[0]!.products
    .map(({ code, type, quantity, price, unitPrice }) => ({ code, type, quantity, price, unitPrice })))
    .toEqual(nativeEdited.products);
  expect(unconfiguredProducts(fixture.before)[0]!.quantity).toBe(8);
  const removed = stageUnconfiguredSelection(next, { ...change, quantity: 0 });
  expect(unconfiguredProducts(removed)).toEqual([]);
  expect(configurationListPrice(removed)).toBe(40621.54);
  const restored = stageUnconfiguredSelection(removed, { ...change, quantity: 8 });
  expect(configurationListPrice(restored)).toBe(80897.54);
  expect(restored.totalPrices).toEqual(fixture.before.totalPrices);
  expect(unconfiguredProducts(restored)).toEqual(unconfiguredProducts(fixture.before));
  expect(() => stageUnconfiguredSelection(next, { ...change, quantity: -1 })).toThrow();
  expect(() => stageUnconfiguredSelection(next, { ...change, code: 'unknown' })).toThrow();
});
it('preserves native express audience through derive and export serialization', () => {
  const raw = { ...fixture.before, showExpressMode: true, showExpressT2Mode: true, selectedTceAudience: 1 };
  const reduced = reduceConfiguration(raw, 'reference', 'cto', 'GP');
  const expected = { showExpressMode: true, showExpressT2Mode: true, selectedTceAudience: 1 };
  expect(reduced).toMatchObject(expected);
  expect(buildExportConfiguration(reduced, raw)).toMatchObject(expected);
});
it('restores the native client-held software selection and totals after hardware derivation', () => {
  const next = preserveUnconfiguredSelections(fixture.before, fixture.derived);
  expect(next.tabs).toEqual(fixture.before.tabs);
  expect(configurationListPrice(next)).toBe(80897.54);
  expect(next.totalPrices).toEqual(fixture.before.totalPrices);
  expect(next['nonSoftwareTotalPrices']).toEqual(fixture.before['nonSoftwareTotalPrices']);
  expect(fixture.derived.tabs).toEqual([]);
  expect(preserveUnconfiguredSelections(next, fixture.derived)).toEqual(next);
  expect(preserveUnconfiguredSelections(next, next)).toBe(next);
});
it('emits native unconfigured commercial lines separately, preserving quantity and unit price', () => {
  const next = preserveUnconfiguredSelections(fixture.before, fixture.derived);
  const products = buildExportGroups(next, String(next.id))[0]!.products;
  const software = products.find(p => p.type === 'unconfigured');
  expect(software).toEqual(fixture.exportedSoftware);
  expect(products.map(({ code, type, quantity, price, unitPrice }) => ({ code, type, quantity, price, unitPrice })))
    .toEqual(fixture.exportedProducts);
  expect(products[0]!.prices).toEqual(fixture.derived.totalPrices);
  next.quantity = 3;
  const multiplied = buildExportGroups(next, String(next.id))[0]!.products.find(p => p.type === 'unconfigured')!;
  expect(multiplied.quantity).toBe(24);
  expect(multiplied.price).toBe(120828);
});
it('does not overwrite an authoritative returned tab or invent a missing catalog price', () => {
  const changed = structuredClone(fixture.before);
  changed.tabs![0]!.subTabs![0]!.sections![0]!.results = [];
  expect(preserveUnconfiguredSelections(fixture.before, changed)).toBe(changed);
  const missingPrice = structuredClone(fixture.before);
  delete missingPrice.tabs![0]!.subTabs![0]!.sections![0]!.features![0]!.unitPrice;
  const next = preserveUnconfiguredSelections(missingPrice, fixture.derived);
  expect(configurationListPrice(next)).toBeNull();
  expect(unconfiguredProducts(next)[0]!.price).toBeNull();
  expect(buildExportGroups(next, String(next.id))[0]!.products.filter(p => ['hardware', 'unconfigured'].includes(p.type))
    .every(p => p.price === null)).toBe(true);
});

it('loads and edits within durable revision-bound workspace transactions without hardware derive', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  try {
    const raw = structuredClone(fixture.before);
    const session = service.sessions.create({ raw, configurationId: String(raw.id), locale: service.locale,
      solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
      reduced: reduceConfiguration(raw, String(raw.id)),
    });
    const catalog = structuredClone(raw);
    catalog.tabs![0]!.subTabs![0]!.sections![0]!.results = [];
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: catalog } as never);
    const revision = () => service.sessions.getWorkspace(session.id)!.revision;
    await service.loadUnconfigured(session.id, revision(), service.newCtx());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ endpoint: 'unconfigured_catalog', method: 'POST' });
    const change = { section: 'UNCONFIGURED_COMMVAULT_SOFTWARE', code: '7S1M004HWW', quantity: 4 };
    const beforeRevision = revision();
    await service.setUnconfigured(session.id, [change], beforeRevision);
    expect(configurationListPrice(service.sessions.get(session.id)!.raw)).toBe(60759.54);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(service.setUnconfigured(session.id, [{ ...change, quantity: 0 }], beforeRevision)).rejects.toThrow();
    const before = structuredClone(service.sessions.get(session.id)!.raw);
    await expect(service.setUnconfigured(session.id, [change, { ...change, code: 'unknown' }], revision())).rejects.toThrow();
    expect(service.sessions.get(session.id)!.raw).toEqual(before);
    await service.sessions.undoWorkspace(service.sessions.getWorkspace(session.id)!.id, revision());
    expect(configurationListPrice(service.sessions.get(session.id)!.raw)).toBe(80897.54);
    service.sessions.setPersistenceWriter(async () => { throw new Error('disk full'); });
    await expect(service.setUnconfigured(session.id, [change], revision())).rejects.toMatchObject({ localNotCommitted: true, remoteApplied: false });
    expect(configurationListPrice(service.sessions.get(session.id)!.raw)).toBe(80897.54);
    service.sessions.setPersistenceWriter(async () => undefined);
  } finally { await service.close(); }
});

it('refreshes and edits linked members atomically, including catalog price changes', async () => {
  const service = new DcscService(ConfigSchema.parse({ files: { persistSessions: false }, logLevel: 'silent' }));
  try {
    const create = (id: string, workspaceId?: string) => {
      const raw = { ...structuredClone(fixture.before), id };
      return service.sessions.create({ raw, configurationId: id, locale: service.locale,
        solution: { solutionMode: 'General Purpose', masterSlices: ['GP'] }, mode: 'cto', primed: true,
        reduced: reduceConfiguration(raw, id), ...(workspaceId ? { workspaceId } : {}),
      });
    };
    const first = create('linked-root');
    const workspace = service.sessions.getWorkspace(first.id)!;
    const second = create('linked-copy', workspace.id);
    workspace.serverState.cloneDependency = { 'linked-root': ['linked-root', 'linked-copy'] };
    const catalog = structuredClone(fixture.before);
    const section = catalog.tabs![0]!.subTabs![0]!.sections![0]!;
    section.results = [];
    section.features![0]!.unitPrice = 6000;
    section.features![0]!['prices'] = [{ price: 6000, priceTypeId: 1 }];
    const send = vi.spyOn(service.http, 'send').mockResolvedValue({ raw: catalog } as never);
    await service.loadUnconfigured(second.id, workspace.revision, service.newCtx());
    expect(configurationListPrice(first.raw)).toBe(88621.54);
    expect(configurationListPrice(second.raw)).toBe(88621.54);
    expect(send).toHaveBeenCalledTimes(1);
    const change = { section: 'UNCONFIGURED_COMMVAULT_SOFTWARE', code: '7S1M004HWW', quantity: 4 };
    await service.setUnconfigured(second.id, [change], workspace.revision);
    expect(configurationListPrice(first.raw)).toBe(64621.54);
    expect(configurationListPrice(second.raw)).toBe(64621.54);
    await service.sessions.undoWorkspace(workspace.id, workspace.revision);
    expect(configurationListPrice(first.raw)).toBe(88621.54);
    expect(configurationListPrice(second.raw)).toBe(88621.54);
    catalog.tabs![0]!.subTabs![0]!.sections![0]!.features = [];
    const revision = workspace.revision;
    await expect(service.loadUnconfigured(first.id, revision, service.newCtx())).rejects.toThrow('cannot preserve');
    expect(workspace.revision).toBe(revision);
    expect(configurationListPrice(first.raw)).toBe(88621.54);
    expect(configurationListPrice(second.raw)).toBe(88621.54);
  } finally { await service.close(); }
});
