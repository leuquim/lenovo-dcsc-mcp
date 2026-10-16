import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildExportGroups } from '../src/domain/exportGroups.js';
import { refreshStoragePhysicalFeatures, splitStoragePhysicalDerive } from '../src/domain/storagePhysicalDerive.js';
import type { RawConfiguration } from '../src/model/types.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/storage-physical-derive.json', import.meta.url), 'utf8',
)) as {
  current: RawConfiguration[];
  aliases: Record<string, string>;
  response: { configurations: RawConfiguration[] };
  expected: {
    ordinaryConfigurationIds: string[];
    physicalConfigurationIds: string[];
    commercial: Array<{ templateId: string; code: string; derivedPrice: number }>;
    afterMoveCommercial: {
      controller: Array<{ code: string; type: string; quantity: number; price: number; unitPrice: number }>;
      mainSwitch: Array<{ code: string; type: string; quantity: number; price: number; unitPrice: number }>;
    };
  };
};

const commercialFixture = JSON.parse(readFileSync(
  new URL('./fixtures/parity/storage-placement-commercial.json', import.meta.url), 'utf8',
)) as {
  components: Array<{ role: 'controller' | 'mainSwitch'; raw: RawConfiguration }>;
};

function raw(id: string, code: string, updateConfigurationIds?: string[]): RawConfiguration {
  return {
    id,
    sliceCtoCode: code,
    description: `${code} configuration`,
    tabs: [],
    ...(updateConfigurationIds === undefined ? {} : { updateConfigurationIds }),
  };
}

describe('storage physical auto-derive response splitting', () => {
  it('preserves the captured physical variants without replacing editable templates', () => {
    const result = splitStoragePhysicalDerive(
      fixture.current,
      fixture.response,
      new Map(Object.entries(fixture.aliases)),
    );

    expect(result.configurations.map(configuration => configuration.id))
      .toEqual(fixture.expected.ordinaryConfigurationIds);
    expect(Object.keys(result.physicalConfigurations).sort())
      .toEqual([...fixture.expected.physicalConfigurationIds].sort());

    for (const expected of fixture.expected.commercial) {
      const physicalIds = Object.entries(fixture.aliases)
        .filter(([, templateId]) => templateId === expected.templateId)
        .map(([physicalId]) => physicalId);
      for (const physicalId of physicalIds) {
        const stored = result.physicalConfigurations[physicalId]!;
        expect(stored.id).toBe(expected.templateId);
        expect(stored.sliceCtoCode).toBe(expected.code);
        expect(stored.totalPrices?.[0]?.price).toBe(expected.derivedPrice);
        expect(stored['capturedFutureField']).toEqual({ kept: true, version: 3 });
      }
    }

    result.physicalConfigurations['controller-physical-1']!['capturedFutureField'] = { kept: false };
    expect(result.physicalConfigurations['controller-physical-2']!['capturedFutureField'])
      .toEqual({ kept: true, version: 3 });
    expect(fixture.response.configurations[0]!['capturedFutureField'])
      .toEqual({ kept: true, version: 3 });
  });

  it('allows ordinary/template patches alongside disjoint variants for one template', () => {
    const current = [raw('server', '7D73CTO1WW'), raw('template', '7DP4CTO1WW')];
    const response = { configurations: [
      { ...raw('server', '7D73CTO1WW'), totalPrice: 10 },
      { ...raw('template', '7DP4CTO1WW', ['physical-1']), totalPrice: 20 },
      { ...raw('template', '7DP4CTO1WW', ['physical-2']), totalPrice: 30 },
      { ...raw('template', '7DP4CTO1WW', ['template']), totalPrice: 40 },
    ] };

    const result = splitStoragePhysicalDerive(current, response, new Map([
      ['physical-1', 'template'],
      ['physical-2', 'template'],
    ]));

    expect(result.configurations.map(value => [value.id, value.totalPrice])).toEqual([
      ['server', 10], ['template', 40],
    ]);
    expect(Object.fromEntries(Object.entries(result.physicalConfigurations)
      .map(([id, value]) => [id, { rawId: value.id, totalPrice: value.totalPrice }]))).toEqual({
      'physical-1': { rawId: 'template', totalPrice: 20 },
      'physical-2': { rawId: 'template', totalPrice: 30 },
    });
  });

  it('projects exact native after-move commercial rows from physical variants', () => {
    const controller = commercialFixture.components.find(component => component.role === 'controller')!;
    const mainSwitch = commercialFixture.components.find(component => component.role === 'mainSwitch')!;
    const ids = {
      controller: String(controller.raw.id),
      mainSwitch: String(mainSwitch.raw.id),
      controllerAliases: ['controller-physical-1', 'controller-physical-2'],
      mainSwitchAliases: ['main-switch-physical-1', 'main-switch-physical-2'],
    };
    const capturedSwitch = fixture.response.configurations.find(configuration =>
      configuration.sliceCtoCode === '7DHNCTO1WW')!;
    const split = splitStoragePhysicalDerive([controller.raw, mainSwitch.raw], { configurations: [
      { ...controller.raw, updateConfigurationIds: ids.controllerAliases },
      {
        ...mainSwitch.raw,
        totalPrice: capturedSwitch.totalPrice,
        totalPrices: capturedSwitch.totalPrices,
        tabs: [...(mainSwitch.raw.tabs ?? []), ...(capturedSwitch.tabs ?? [])],
        updateConfigurationIds: ids.mainSwitchAliases,
      },
    ] }, new Map([
      ...ids.controllerAliases.map(alias => [alias, ids.controller] as const),
      ...ids.mainSwitchAliases.map(alias => [alias, ids.mainSwitch] as const),
    ]));
    const rackItems = [
      ...ids.controllerAliases.map(id => ({ id, code: '7DP4CTO1WW', type: 'storage' })),
      ...ids.mainSwitchAliases.map(id => ({ id, code: '7DHNCTO1WW', type: 'switch' })),
    ];
    const workspace = {
      configurations: new Map([controller, mainSwitch].map(component => [String(component.raw.id), {
        configurationId: String(component.raw.id), raw: component.raw,
        product: { code: String(component.raw.sliceCtoCode) },
      }])),
      rackArea: [{ id: 'rack', rackItems }],
      nonRackArea: [],
      serverState: {
        storageConnectionNetworks: [{ name: 'Captured SAN',
          controller: { id: ids.controller, option: '7DP4CTO1WW', hardwareType: 'storage' },
          mainSwitch: { id: ids.mainSwitch, option: '7DHNCTO1WW', hardwareType: 'switch' },
        }],
        cloneDependency: {
          [ids.controller]: [ids.controller, ...ids.controllerAliases],
          [ids.mainSwitch]: [ids.mainSwitch, ...ids.mainSwitchAliases],
        },
        storagePhysicalConfigurations: split.physicalConfigurations,
      },
    };
    const products = buildExportGroups(workspace)[0]!.products;
    const commercial = (templateId: string) => products.filter(product => product.id === templateId).map(product => ({
      code: product.code, type: product.type, quantity: product.quantity,
      price: product.price, unitPrice: product.unitPrice,
    }));

    expect(commercial(ids.controller)).toEqual(fixture.expected.afterMoveCommercial.controller);
    expect(commercial(ids.mainSwitch)).toEqual(fixture.expected.afterMoveCommercial.mainSwitch);
    expect(commercial(ids.mainSwitch)[0]).toMatchObject({ price: 22_576.02, unitPrice: 11_288.01 });
    expect(JSON.stringify(mainSwitch.raw)).not.toContain('2305');
    expect(JSON.stringify(split.physicalConfigurations[ids.mainSwitchAliases[0]!])).toContain('2305');
  });

  it('refreshes captured physical selections and placements while preserving envelope metadata', () => {
    const physical = {
      id: 'controller-physical-1', code: '7DP4CTO1WW', type: 'storage', position: 7,
      size: 2, futureEnvelopeField: { keep: true },
      features: [
        { name: 'NETWORK_ADAPTER', futureSectionField: 'keep', results: [
          { code: 'C4AC', quantity: 2, installations: [{ installSequence: 'old' }],
            description: 'Ethernet adapter', type: 'hardware', forAutoConnect: false, futureResultField: 'keep' },
        ] },
        { name: 'RAIL_KIT', results: [
          { code: 'B6Y6', quantity: 1, installations: [], description: 'Rack rail', forAutoConnect: false },
        ] },
        { name: 'OTHER_MI', results: [
          { code: 'BWUE', quantity: 2, installations: [], description: 'Encryption license', forAutoConnect: false },
        ] },
      ],
    };
    const derived: RawConfiguration = {
      id: 'controller-template', workspaceId: 'controller-template', sliceCtoCode: '7DP4CTO1WW', tabs: [{
        type: 'hardware', subTabs: [{ sections: [
          { name: 'NETWORK_ADAPTER', results: [
            { code: 'C4AC', quantity: 2, installations: [], description: 'Ethernet adapter', type: 'hardware' },
            { code: 'C4A8', quantity: 2, installations: [], description: 'FC adapter', type: 'hardware' },
          ] },
          { name: 'RAIL_KIT', results: [
            { code: 'B6Y6', quantity: 1, installations: [], description: 'Rack rail' },
          ] },
          { name: 'OTHER_MI', results: [
            { code: 'BWUE', quantity: 2, installations: [], description: 'Encryption license' },
          ] },
        ] }],
      }, {
        type: 'servicesAndor', subTabs: [{ sections: [
          { name: 'Warranty Service Upgrades', results: [
            { code: 'SERVICE', quantity: 1, installations: [], description: 'Warranty', type: 'service' },
          ] },
        ] }],
      }],
    };
    const response = { placementResults: [{ workspaceId: 'controller-template', sectionPlacement: [
      { sectionName: 'NETWORK_ADAPTER', featurePlacement: [{ featureCode: 'C4A8', installations: [
        { targetFeatureCode: 'C4A8', targetSpaceConnector: 'PCI_S', installSequence: '0' },
        { targetFeatureCode: 'C4A8', targetSpaceConnector: 'PCI_S', installSequence: '1' },
      ] }] },
      { sectionName: 'RAIL_KIT', featurePlacement: [{ featureCode: 'B6Y7', installations: [] }] },
    ] }] };

    const refreshed = refreshStoragePhysicalFeatures(physical, derived, response);
    expect(refreshed).toMatchObject({
      id: 'controller-physical-1', position: 7, size: 2, futureEnvelopeField: { keep: true },
      features: [
        { name: 'NETWORK_ADAPTER', results: [
          { code: 'C4AC', quantity: 2, forAutoConnect: false },
          { code: 'C4A8', quantity: 2, installations: [
            { targetFeatureCode: 'C4A8', targetSpaceConnector: 'PCI_S', installSequence: '0' },
            { targetFeatureCode: 'C4A8', targetSpaceConnector: 'PCI_S', installSequence: '1' },
          ] },
        ] },
        { name: 'RAIL_KIT', results: [{ code: 'B6Y6', quantity: 1, forAutoConnect: false }] },
        { name: 'OTHER_MI', results: [{ code: 'BWUE', quantity: 2, forAutoConnect: false }] },
        { name: 'Warranty Service Upgrades', results: [
          { code: 'SERVICE', quantity: 1, type: 'servicesAndor' },
        ] },
      ],
    });
    expect(JSON.stringify(refreshed)).not.toContain('B6Y7');
    expect(JSON.stringify(refreshed)).not.toContain('2305');
    expect(physical.features[0]!.results).toHaveLength(1);
  });

  it('rejects malformed physical refresh identities and placement ambiguity', () => {
    const physical = { id: 'physical', code: 'CODE', features: [] };
    const derived = raw('template', 'CODE');
    expect(() => refreshStoragePhysicalFeatures({ code: 'CODE' }, derived, {})).toThrow(/no identity/i);
    expect(() => refreshStoragePhysicalFeatures(physical, raw('template', 'OTHER'), {})).toThrow(/changed product code/i);
    expect(() => refreshStoragePhysicalFeatures(
      physical,
      raw('template', 'CODE', ['physical']),
      {},
    )).toThrow(/physical-price variant/i);
    expect(() => refreshStoragePhysicalFeatures(physical, derived, { placementResults: [
      { workspaceId: 'template' }, { workspaceId: 'template' },
    ] })).toThrow(/multiple placement results/i);
  });

  it.each([
    ['missing configurations', {}, /missing its configurations array/i],
    ['non-object configuration', { configurations: [null] }, /index 0 is not an object/i],
    ['unknown response id', { configurations: [raw('missing', 'CODE')] }, /unknown id: missing/i],
    ['changed code', { configurations: [raw('template', 'OTHER')] }, /changed product code/i],
    ['empty update list', { configurations: [raw('template', '7DP4CTO1WW', [])] }, /invalid updateConfigurationIds/i],
    ['duplicate update id', { configurations: [raw('template', '7DP4CTO1WW', ['physical-1', 'physical-1'])] }, /repeats an update/i],
    ['mixed template and alias targets', { configurations: [raw('template', '7DP4CTO1WW', ['template', 'physical-1'])] }, /ambiguously targets/i],
    ['unknown physical target', { configurations: [raw('template', '7DP4CTO1WW', ['missing'])] }, /unknown physical identity missing/i],
    ['incomplete physical raw', { configurations: [{ id: 'template', sliceCtoCode: '7DP4CTO1WW',
      updateConfigurationIds: ['physical-1'] }] }, /missing its tabs array/i],
  ])('rejects %s', (_label, response, error) => {
    expect(() => splitStoragePhysicalDerive(
      [raw('template', '7DP4CTO1WW')],
      response,
      new Map([['physical-1', 'template']]),
    )).toThrow(error);
  });

  it('rejects invalid alias ownership and ambiguous response coverage', () => {
    const current = [raw('template-1', 'CODE-1'), raw('template-2', 'CODE-2')];

    expect(() => splitStoragePhysicalDerive(current, { configurations: [] }, new Map([
      ['physical-1', 'missing-template'],
    ]))).toThrow(/references unknown template missing-template/i);

    expect(() => splitStoragePhysicalDerive(current, {
      configurations: [raw('template-1', 'CODE-1', ['physical-2'])],
    }, new Map([
      ['physical-1', 'template-1'],
      ['physical-2', 'template-2'],
    ]))).toThrow(/owned by template template-2/i);

    expect(() => splitStoragePhysicalDerive(current, {
      configurations: [
        raw('template-1', 'CODE-1', ['physical-1']),
        raw('template-1', 'CODE-1', ['physical-1']),
      ],
    }, new Map([['physical-1', 'template-1']]))).toThrow(/received multiple derived configurations/i);

    expect(() => splitStoragePhysicalDerive(current, {
      configurations: [raw('template-1', 'CODE-1'), raw('template-1', 'CODE-1')],
    }, new Map())).toThrow(/duplicate ordinary auto-derive/i);
  });

  it('rejects duplicate current identities and malformed alias identities', () => {
    expect(() => splitStoragePhysicalDerive(
      [raw('duplicate', 'CODE'), raw('duplicate', 'CODE')],
      { configurations: [] },
      new Map(),
    )).toThrow(/duplicate current configuration identity/i);

    expect(() => splitStoragePhysicalDerive(
      [raw('template', 'CODE')],
      { configurations: [] },
      new Map([['', 'template']]),
    )).toThrow(/identities must be nonempty/i);

    expect(() => splitStoragePhysicalDerive(
      [raw('template', 'CODE')],
      { configurations: [] },
      new Map([['template', 'template']]),
    )).toThrow(/cannot equal its template/i);
  });
});
