import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  addRackHardware,
  fetchRackCabinets,
  buildEnvelopeRequest,
  buildRackConfigurations,
  buildRackCustomizePayload,
  classifyRackHardware,
  customizeLayout,
  mergeDerivedConfigurations,
  withDerivedPlacements,
} from '../src/domain/rack.js';
import type { DcscHttpClient, RequestCtx, SendInput } from '../src/http/request.js';

it('serializes returned node size objects numerically for racked and loose chassis without changing state', () => {
  const node = { id: 'node', type: 'node', size: { value: 1, availableSpace: [1] }, occupiedBay: 1 };
  const state = { rackArea: [{ rackItems: [{ type: 'chassis', nodes: [node] }] }],
    nonRackArea: [{ type: 'chassis', nodes: [{ ...node, id: 'loose-node' }] }] };
  const before = structuredClone(state);
  const payload = buildRackCustomizePayload(state, []);
  expect(payload.rackArea).toMatchObject([{ rackItems: [{ nodes: [{ size: 1, occupiedBay: 1 }] }] }]);
  expect(payload.nonRackArea).toMatchObject([{ nodes: [{ size: 1, occupiedBay: 1 }] }]);
  expect(state).toEqual(before);
  expect(() => buildRackCustomizePayload({ rackArea: [], nonRackArea: [{ ...node, size: {} }] }, []))
    .toThrow('no usable numeric value');
});

it('matches the native post-edit physical feature request exactly', () => {
  const captured = JSON.parse(readFileSync('test/fixtures/parity/rack-feature-projection.json', 'utf8'));
  const payload = buildRackCustomizePayload({ rackArea: [{ id: 'rack', rackItems: [captured.physicalBefore] }],
    nonRackArea: [], cloneDependency: captured.cloneDependency },
  [withDerivedPlacements(captured.configuration, captured)]);
  const physical = (payload.rackArea[0]!.rackItems as Array<Record<string, unknown>>)[0]!;
  expect(JSON.parse(JSON.stringify(physical.features))).toEqual(captured.expectedFeatures);
});

it('rebuilds physical selections and installations while preserving racked auto-connect flags', () => {
  const raw = { id: 'template', code: 'SERVER', name: 'Configured server', tabs: [{ type: 'hardware', subTabs: [{ sections: [
    { name: 'FIBER_CHANNEL_ADAPTER', results: [{ code: 'ATZV', quantity: 1, description: 'FC adapter' }] },
    { name: 'ETHERNET_CABLE', results: [{ code: 'AVFU', quantity: 1 }] },
    { name: 'UNCONFIGURED_NETWORK', results: [{ code: 'OLD', quantity: 1 }] },
  ] }] }] };
  const installations = [{ targetFeatureCode: 'ATZV', installSequence: '0' }];
  const response = { placementResults: [{ workspaceId: 'template', sectionPlacement: [
    { sectionName: 'FIBER_CHANNEL_ADAPTER', featurePlacement: [{ featureCode: 'ATZV', installations }] },
  ] }] };
  const enriched = withDerivedPlacements(raw, response);
  const state = { cloneDependency: { template: ['template', 'alias'] }, rackArea: [{ id: 'rack', rackItems: [
    { id: 'alias', futureMetadata: 'kept', features: [{ name: 'ETHERNET_CABLE', results: [
      { code: 'AVFU', quantity: 9, forAutoConnect: true }, { code: 'OLD', quantity: 1 },
    ] }] },
  ] }], nonRackArea: [] };
  const payload = buildRackCustomizePayload(state, [enriched]);
  const physical = (payload.rackArea[0]!.rackItems as Array<Record<string, unknown>>)[0]!;
  expect(physical).toMatchObject({ id: 'alias', name: 'Configured server', futureMetadata: 'kept', features: [
    { name: 'FIBER_CHANNEL_ADAPTER', results: [{ code: 'ATZV', quantity: 1, installations, type: 'hardware' }] },
    { name: 'ETHERNET_CABLE', results: [{ code: 'AVFU', quantity: 1, forAutoConnect: true }] },
  ] });
  expect(JSON.stringify(physical)).not.toContain('OLD');
  expect(payload.configurations[0]!.sections.find(section => section.name === 'ETHERNET_CABLE')!.features[0])
    .toMatchObject({ code: 'AVFU', forAutoConnect: true });
  expect(state.rackArea[0]!.rackItems[0]!.features[0]!.results[0]!.quantity).toBe(9);
  expect(raw.tabs[0]!.subTabs[0]!.sections[0]!.results[0]).not.toHaveProperty('installations');
});

it('uses enclosing tab types and refreshes non-rack features without retaining rack-only flags', () => {
  const raw = { id: 'server', code: 'SERVER', tabs: [{ type: 'servicesAndor', subTabs: [{ sections: [
    { name: 'SERVICE', results: [{ code: 'SUPPORT', quantity: 1, type: 'service' }] },
  ] }] }] };
  const payload = buildRackCustomizePayload({ rackArea: [], nonRackArea: [{ id: 'server',
    features: [{ name: 'SERVICE', results: [{ code: 'SUPPORT', quantity: 2, forAutoConnect: true }] }] }] }, [raw]);
  expect(payload.nonRackArea[0]!.features).toEqual([{ name: 'SERVICE', results: [
    { code: 'SUPPORT', quantity: 1, installations: [], description: undefined, type: 'servicesAndor' },
  ] }]);
  expect(() => withDerivedPlacements(raw, { placementResults: [
    { workspaceId: 'server' }, { workspaceId: 'server' },
  ] })).toThrow('ambiguous placement');
});

const fixture = JSON.parse(readFileSync('test/fixtures/parity/rack-domain.json', 'utf8')) as {
  server: Record<string, unknown>;
  switch: Record<string, unknown>;
  rack: Record<string, unknown>;
  customizeResponse: Record<string, unknown>;
};
const ctx = { corrId: 'rack-test', locale: {
  country: 'US', geo: 'NA', language: 'en', currency: 'USD',
} } as RequestCtx;

function fakeHttp(raw: unknown, calls: SendInput[]): DcscHttpClient {
  return { send: async (input: SendInput) => {
    calls.push(input);
    return { status: 200, headers: {}, requestId: undefined, traceId: undefined,
      durationMs: 1, raw };
  } } as unknown as DcscHttpClient;
}

describe('rack hardware classification', () => {
  it('uses the live launch type for servers, switches, and racks', () => {
    expect(classifyRackHardware(fixture.server)).toBe('server');
    expect(classifyRackHardware(fixture.switch)).toBe('switch');
    expect(classifyRackHardware(fixture.rack)).toBe('rack');
    expect(buildEnvelopeRequest(fixture.switch)).toEqual({
      code: '7D5FCTOFWW', type: 'switch', asVLH: false,
    });
  });

  it('prefers a rack-service hardwareType over a generic type', () => {
    expect(classifyRackHardware({ type: 'server', hardwareType: 'switch' })).toBe('switch');
    expect(() => classifyRackHardware({ description: 'unknown' })).toThrow(/hardware type/);
  });
});

describe('rack customize wire projection', () => {
  it('projects selected tab and unselectable results into SPA sections', () => {
    expect(buildRackConfigurations([fixture.server])).toEqual([{
      id: 'server-1', code: '7D73CTO1WW', name: 'Server', description: 'SR630 V3',
      connectors: [{ port: 'RJ45' }],
      selectedTopologies: { Management: { selectedConnectors: [] } },
      selectedStorageNetwork: null, sliceCtoCode: '7D73CTO1WW', slice: 'GP',
      asVLH: false, vlhId: undefined,
      sections: [
        { name: 'NETWORK', features: [{ code: 'BPC0', quantity: 2,
          installations: [{ targetSpaceConnector: 'PCIe' }], description: 'Ethernet adapter',
          type: 'hardware', forAutoConnect: true }] },
        { name: 'OTHER_MI', features: [{ code: '2304', quantity: 1, installations: [],
          description: 'Integration Prep', type: undefined }] },
      ],
    }]);
  });

  it('merges the partial autoDerive response by id without dropping omitted configurations', () => {
    const current = [fixture.server, fixture.switch, fixture.rack];
    const derivedSwitch = { ...fixture.switch, description: 'Derived switch', derived: true };
    const merged = mergeDerivedConfigurations(current, { configurations: [derivedSwitch] });

    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(fixture.server);
    expect(merged[1]).toBe(derivedSwitch);
    expect(merged[2]).toBe(fixture.rack);
  });

  it('rejects ambiguous or foreign autoDerive configuration identities', () => {
    expect(() => mergeDerivedConfigurations([fixture.server], {}))
      .toThrow(/missing its configurations array/);
    expect(() => mergeDerivedConfigurations([fixture.server], {
      configurations: [{ ...fixture.server }, { ...fixture.server }],
    })).toThrow(/Duplicate derived rack configuration id/);
    expect(() => mergeDerivedConfigurations([fixture.server], {
      configurations: [{ ...fixture.switch, id: 'foreign-switch' }],
    })).toThrow(/unknown id: foreign-switch/);
    expect(() => mergeDerivedConfigurations([fixture.server], {
      configurations: [{ ...fixture.server, code: 'DIFFERENT' }],
    })).toThrow(/changed product code/);
  });

  it('posts the full workspace payload and preserves authoritative rack/non-rack state', async () => {
    const calls: SendInput[] = [];
    const payload = buildRackCustomizePayload({
      rackArea: [{ id: 'rack-1' }], nonRackArea: [{ id: 'switch-1' }],
      floorItems: [{ id: 'cell-1', rackId: 'rack-1' }],
      clusterPreference: [{ name: 'Management' }],
      switchMap: [{ id: 'switch-1', network: 'Management', usage: 'main' }],
      futureWorkspaceField: { kept: true },
    }, [fixture.server, fixture.switch, fixture.rack]);
    const result = await customizeLayout(fakeHttp(fixture.customizeResponse, calls), ctx, payload, {
      autoArrange: true, autoConnect: true,
    });
    const sent = calls[0]?.body?.kind === 'json'
      ? calls[0].body.value as Record<string, unknown>
      : {};
    expect(sent['floorItems']).toEqual([{ id: 'cell-1', rackId: 'rack-1' }]);
    expect(sent['futureWorkspaceField']).toEqual({ kept: true });
    expect((sent['configurations'] as unknown[])).toHaveLength(3);
    expect(calls[0]?.query).toMatchObject({ autoArrange: true, autoConnect: true });
    expect(result.racks[0]?.items[0]).toMatchObject({ id: 'server-1', position: 3 });
    expect(result.unplaced).toEqual([{ id: 'switch-1', code: '7D5FCTOFWW', description: undefined }]);
    expect(result.rawNonRackArea[0]?.['type']).toBe('switch');
    expect(result.rawState['futureLayoutField']).toEqual({ kept: true });
  });
});


it('queries product-compatible rack cabinets while preserving generic discovery', async () => {
  const calls: SendInput[] = [];
  const http = fakeHttp([{ products: [{ code: 'RACK', hardwareType: 'rack', description: 'Cabinet' }, { code: 'UPS', hardwareType: 'ups' }] }], calls);
  expect(await fetchRackCabinets(http, ctx, '7D73CTO1WW')).toEqual([{ code: 'RACK', description: 'Cabinet' }]);
  expect(calls[0]).toMatchObject({ path: '/ctos/racks/compatible_categories', query: { masterCode: '7D73CTO1WW' } });
  await fetchRackCabinets(http, ctx);
  expect(calls[1]?.path).toBe('/ctos/racks/categories');
  expect(calls[1]?.query).toBeUndefined();
});

it('posts the captured Add Hardware request and returns the id-less new rack item', async () => {
  const capture = JSON.parse(readFileSync('test/fixtures/parity/rack-add-hardware-capture.json', 'utf8'));
  const calls: SendInput[] = [];
  const http = fakeHttp([capture.response], calls);
  const rack = { id: capture.request.rackId, rackItems: capture.request.rackItems };
  const added = await addRackHardware(http, ctx, { rack, product: capture.request.newHardware[0],
    workspace: { rackArea: [rack], nonRackArea: [], configurations: [], cloneDependency: {} } });
  expect(calls[0]).toMatchObject({ method: 'POST', path: '/ctos/racks/hardware' });
  expect(Object.fromEntries(Object.entries(calls[0]!.query as Record<string, unknown>).map(([key, value]) => [key, String(value)])))
    .toEqual(capture.query);
  expect(Object.keys((calls[0]!.body as { value: object }).value).sort()).toEqual(['newHardware', 'rack', 'workspace']);
  expect((calls[0]!.body as { value: { newHardware: unknown[] } }).value.newHardware).toEqual(capture.request.newHardware);
  expect(added.item).toMatchObject({ id: null, code: '7D73CTO1WW', position: 2 });
});
