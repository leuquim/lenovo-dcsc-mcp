import { describe, expect, it } from 'vitest';

import {
  buildSelectedTopologies,
  buildWorkspaceNetworkPreferences,
  listNetworkLeafCablingChoices,
  listTopologyConnectors,
} from '../src/domain/networkPreferences.js';
import type { FabricOptions } from '../src/domain/fabric.js';

const baseFabric: FabricOptions = {
  topologies: [{ id: 'topology:1GbE_Copper', shortName: '1GbE_Copper', description: '1 Gb Ethernet' }],
  networkDevices: [{
    id: 'network-device:7D5FCTOFWW:BPC7:NVIDIA SN2201', option: '7D5FCTOFWW', feature: 'BPC7',
    description: 'NVIDIA SN2201', topologies: ['1GbE_Copper'], topologyConnectors: { '1GbE_Copper': 48 },
  }],
  networkTypes: [{
    id: 'network-type:Management', name: 'Management', defaultNetworkTechnology: '1GbE_Copper',
    defaultLayout: 'Centralized', defaultMainSwitch: 'BPC7', defaultMainSwitchOption: '7D5FCTOFWW',
    defaultCableType: 'Cat5E', defaultCableColor: 'Green', mainSwitchTrunks: 1,
  }],
  cables: [{
    id: 'cable:3760:fixture', featureCode: '3760', description: '1.8m Black Cat5e Cable',
    category: 'Cat5E', topologies: ['1GbE_Copper'], compatibility: ['7D5FCTOFWW'],
  }],
  selectedServices: [], nodeRoles: [], storageSwitches: [], storageControllers: [],
};

const rawConfiguration = {
  connectors: [{
    portNumber: '1', portDescription: 'RJ45 management', port: 'RJ45', topologies: ['1GbE_Copper'],
    connectorFunction: 'Network', cableCompatible: 'Group:1,27,90', sourceFeature: '', quantity: 1,
    futureConnectorField: { kept: true },
  }, {
    portNumber: '2', portDescription: 'RJ45 management', port: 'RJ45', topologies: ['1GbE_Copper'],
    connectorFunction: 'Network', cableCompatible: 'Group:1,27,90', sourceFeature: '', quantity: 1,
  }, {
    portNumber: '1', portDescription: 'InfiniBand', port: 'QSFP', topologies: ['IB_NDR'],
    connectorFunction: 'Network', sourceFeature: 'A1', quantity: 1,
  }],
  selectedTopologies: { Storage: { futureSelection: 'preserved' } },
};

describe('configuration topology preferences', () => {
  it('retains other networks and complete raw connector DTOs', () => {
    const choices = listTopologyConnectors(rawConfiguration, baseFabric, 'topology:1GbE_Copper');
    expect(choices).toHaveLength(2);
    const selected = buildSelectedTopologies(rawConfiguration, baseFabric, {
      topology: '1GbE_Copper', networkName: 'network-type:Management', connectorIds: [choices[1]!.id],
    });
    expect(selected.Storage).toEqual({ futureSelection: 'preserved' });
    expect(selected.Management).toEqual({
      color: 'Green', maxConnectors: 1, connectors: 1, networkTechnology: '1GbE_Copper',
      selectedConnectors: [rawConfiguration.connectors[1]],
    });
    const connector = (selected.Management as { selectedConnectors: Array<Record<string, unknown>> })
      .selectedConnectors[0];
    expect(connector).not.toBe(rawConfiguration.connectors[1]);
  });

  it('requires explicit choices for ambiguous networks and ports', () => {
    const fabric = { ...baseFabric, networkTypes: [...baseFabric.networkTypes, {
      ...baseFabric.networkTypes[0]!, id: 'network-type:Provisioning', name: 'Provisioning',
    }] };
    expect(() => buildSelectedTopologies(rawConfiguration, fabric, { topology: '1GbE_Copper' }))
      .toThrow(/multiple networks.*Specify networkName.*network-type:Management.*network-type:Provisioning/i);
    expect(() => buildSelectedTopologies(rawConfiguration, baseFabric, {
      topology: '1GbE_Copper', networkName: 'Management', ports: ['RJ45'],
    })).toThrow(/port "RJ45" is ambiguous.*stable connector ID/i);
  });

  it('does not silently select among multiple compatible connectors', () => {
    expect(() => buildSelectedTopologies(rawConfiguration, baseFabric, {
      topology: '1GbE_Copper', networkName: 'Management',
    })).toThrow(/multiple compatible connectors.*connectorIds or ports/i);
    const selected = buildSelectedTopologies(rawConfiguration, baseFabric, {
      topology: '1GbE_Copper', networkName: 'Management', ports: ['RJ45:1'],
    });
    expect((selected.Management as { selectedConnectors: unknown[] }).selectedConnectors).toEqual([
      rawConfiguration.connectors[0],
    ]);
  });
});

describe('workspace network preferences', () => {
  it('exposes the SPA leaf-cabling fallback only when the API omits the field', () => {
    expect(listNetworkLeafCablingChoices(baseFabric).map(choice => choice.description)).toEqual([
      'Minimal distance cabling (lower cost)',
      'Balance Connections across leaf switches (best performance)',
    ]);
    expect(listNetworkLeafCablingChoices({ ...baseFabric, leafNodeCabling: [] })).toEqual([]);
  });

  it('resolves stable IDs and emits cluster preferences through the existing adapter', () => {
    const result = buildWorkspaceNetworkPreferences(baseFabric, [{
      networkTypeId: 'network-type:Management',
      mainDeviceId: 'network-device:7D5FCTOFWW:BPC7:NVIDIA SN2201',
      cableId: 'cable:3760:fixture',
    }]);
    expect(result.selections).toEqual([{
      networkTypeId: 'network-type:Management', topologyId: 'topology:1GbE_Copper',
      mainDeviceId: 'network-device:7D5FCTOFWW:BPC7:NVIDIA SN2201', cableId: 'cable:3760:fixture',
      layout: 'Centralized', mainTrunks: 1, leafTrunks: 0, vlanNetworkTypeIds: [],
    }]);
    expect(result.clusterPreference).toEqual([{
      cableColor: 'Green', cableType: 'Cat5E',
      mainSwitch: { feature: 'BPC7', option: '7D5FCTOFWW', topologyConnectors: { '1GbE_Copper': 48 } },
      maximumPorts: 48, name: 'Management', networkLayout: 'Centralized',
      networkType: '1GbE_Copper', trunks: 1, vlan: [], customCable: undefined,
      leafCableColor: undefined, leafCableType: '', leafSwitch: {}, leafMaximumPorts: 0,
      leafTrunks: 0, leafCabling: '',
    }]);
  });

  it('rejects stale defaults on an active network and gives valid stable-ID choices', () => {
    const stale: FabricOptions = { ...baseFabric, networkTypes: [{
      ...baseFabric.networkTypes[0]!, defaultMainSwitch: 'AT09', defaultMainSwitchOption: '7159HCP',
    }] };
    expect(() => buildWorkspaceNetworkPreferences(stale, [{ networkTypeId: 'network-type:Management' }]))
      .toThrow(/default main device \(AT09\/7159HCP\) is unavailable.*network-device:7D5FCTOFWW/i);
  });

  it('requires a stable device ID when a legacy feature/option default is ambiguous', () => {
    const ambiguous: FabricOptions = { ...baseFabric, networkDevices: [
      ...baseFabric.networkDevices,
      { ...baseFabric.networkDevices[0]!, id: 'network-device:7D5FCTOFWW:BPC7:alternate-description' },
    ] };
    expect(() => buildWorkspaceNetworkPreferences(ambiguous, [{ networkTypeId: 'network-type:Management' }]))
      .toThrow(/default main device.*is ambiguous.*Choose mainDeviceId/i);
  });

  it('validates distributed leaf device/cable selections and preserves their stable IDs', () => {
    const fabric: FabricOptions = {
      ...baseFabric,
      networkDevices: [...baseFabric.networkDevices, {
        id: 'network-device:leaf:LF01:Leaf', option: 'leaf', feature: 'LF01', description: 'Leaf',
        topologies: ['1GbE_Copper'], topologyConnectors: { '1GbE_Copper': 24 },
      }],
      cables: [...baseFabric.cables, {
        id: 'cable:leaf', featureCode: 'L001', description: 'Leaf Cat6', category: 'Cat6',
        topologies: ['1GbE_Copper'], compatibility: ['leaf'],
      }],
      networkTypes: [{
        ...baseFabric.networkTypes[0]!, defaultLayout: 'Distributed',
        defaultLeafSwitch: 'missing', defaultLeafSwitchOption: 'missing', defaultLeafCableType: 'missing',
        leafSwitchTrunks: 2,
      }],
      leafNodeCabling: [
        { id: 'leaf-cabling:min', description: 'Minimal distance cabling (lower cost)' },
        { id: 'leaf-cabling:balance', description: 'Balance Connections across leaf switches (best performance)' },
      ],
    };
    const result = buildWorkspaceNetworkPreferences(fabric, [{
      networkTypeId: 'network-type:Management', mainDeviceId: baseFabric.networkDevices[0]!.id,
      cableId: baseFabric.cables[0]!.id, leafDeviceId: 'network-device:leaf:LF01:Leaf',
      leafCableId: 'cable:leaf', mainTrunks: 2, leafTrunks: 3,
      leafCabling: 'Balance Connections across leaf switches (best performance)',
    }]);
    expect(result.selections[0]).toMatchObject({
      leafDeviceId: 'network-device:leaf:LF01:Leaf', leafCableId: 'cable:leaf',
      layout: 'Distributed', mainTrunks: 2, leafTrunks: 3,
      leafCabling: 'Balance Connections across leaf switches (best performance)',
    });
    expect(result.clusterPreference[0]).toMatchObject({
      leafCableType: 'Cat6', leafSwitch: { feature: 'LF01', option: 'leaf' }, leafMaximumPorts: 24,
      trunks: 2, leafTrunks: 3,
      leafCabling: 'Balance Connections across leaf switches (best performance)',
    });
  });

  it('applies layout, trunk, leaf policy and VLAN controls with website clearing semantics', () => {
    const peer = { ...baseFabric.networkTypes[0]!, id: 'network-type:Provisioning', name: 'Provisioning' };
    const vlanFabric: FabricOptions = { ...baseFabric, networkTypes: [
      { ...baseFabric.networkTypes[0]!, defaultVlan: [{ name: 'Provisioning', networkType: '1GbE_Copper' }] },
      peer,
    ] };
    const joined = buildWorkspaceNetworkPreferences(vlanFabric, [{
      networkTypeId: 'network-type:Management', vlanNetworkTypeIds: [peer.id], mainTrunks: 2,
    }]);
    expect(joined.networkTypes[0]).toMatchObject({
      defaultLayout: 'Centralized', mainSwitchTrunks: 2,
      defaultVlan: [{ name: 'Provisioning', networkType: '1GbE_Copper' }],
    });
    expect(joined.selections[0]).toMatchObject({
      vlanNetworkTypeIds: [peer.id], layout: 'Centralized', mainTrunks: 2,
    });
    const changed = buildWorkspaceNetworkPreferences(vlanFabric, [{
      networkTypeId: 'network-type:Management', layout: 'Distributed',
      leafDeviceId: 'existing-customer-switch', mainTrunks: 1,
    }]);
    expect(changed.networkTypes[0]).toMatchObject({ defaultLayout: 'Distributed', defaultVlan: [] });
    expect(changed.selections[0]?.vlanNetworkTypeIds).toEqual([]);
    expect(() => buildWorkspaceNetworkPreferences(baseFabric, [{
      networkTypeId: 'network-type:Management', mainTrunks: 48,
    }])).toThrow(/exceeds.*maximum 47/i);
    const hiddenLeaf = buildWorkspaceNetworkPreferences({ ...baseFabric, networkTypes: [{
      ...baseFabric.networkTypes[0]!, leafSwitchTrunks: 7,
    }] }, [{ networkTypeId: 'network-type:Management' }]);
    expect(hiddenLeaf.networkTypes[0]?.['leafSwitchTrunks']).toBe(7);
    expect(hiddenLeaf.selections[0]?.leafTrunks).toBe(7);
  });

  it('validates VLAN peers against their effective same-batch switch and topology edits', () => {
    const alternate = { ...baseFabric.networkDevices[0]!, id: 'network-device:alternate',
      feature: 'ALT1', option: 'ALT-CTO' };
    const peer = { ...baseFabric.networkTypes[0]!, id: 'network-type:Provisioning', name: 'Provisioning' };
    const fabric: FabricOptions = { ...baseFabric, networkDevices: [...baseFabric.networkDevices, alternate],
      cables: [{ ...baseFabric.cables[0]!, compatibility: ['7D5FCTOFWW', 'ALT-CTO'] }],
      networkTypes: [baseFabric.networkTypes[0]!, peer] };
    const result = buildWorkspaceNetworkPreferences(fabric, [{
      networkTypeId: 'network-type:Management', mainDeviceId: alternate.id,
      vlanNetworkTypeIds: [peer.id],
    }, {
      networkTypeId: peer.id, mainDeviceId: alternate.id,
    }]);
    expect(result.networkTypes[0]?.['defaultVlan']).toEqual([
      { name: 'Provisioning', networkType: '1GbE_Copper' },
    ]);
    expect(() => buildWorkspaceNetworkPreferences(fabric, [{
      networkTypeId: 'network-type:Management', vlanNetworkTypeIds: [peer.id],
    }, {
      networkTypeId: peer.id, mainDeviceId: alternate.id,
    }])).toThrow(/does not use the selected main switch/i);
  });

  it('supports website existing-switch and manual/custom-cable sentinels', () => {
    const fabric: FabricOptions = { ...baseFabric,
      networkTypes: [{ ...baseFabric.networkTypes[0]!, defaultMainSwitch: '',
        defaultMainSwitchOption: '', mainSwitchTrunks: 0, customCable: '' }],
      cables: [{ ...baseFabric.cables[0]!, customCable: true }],
    };
    const custom = buildWorkspaceNetworkPreferences(fabric, [{
      networkTypeId: 'network-type:Management', customCableId: baseFabric.cables[0]!.id,
    }]);
    expect(custom.networkTypes[0]).toMatchObject({ customCable: '3760' });
    expect(custom.selections[0]?.customCableId).toBe(baseFabric.cables[0]!.id);
    const manual = buildWorkspaceNetworkPreferences(baseFabric, [{
      networkTypeId: 'network-type:Management', mainDeviceId: 'existing-customer-switch',
      customCableId: 'manual-cable', vlanNetworkTypeIds: [],
    }]);
    expect(manual.networkTypes[0]).toMatchObject({
      defaultMainSwitch: '', defaultMainSwitchOption: '', mainSwitchTrunks: 0,
      defaultVlan: [], customCable: '',
    });
    expect(manual.selections[0]).toMatchObject({
      mainDeviceId: 'existing-customer-switch', customCableId: 'manual-cable',
    });
  });

  it('rejects a cable/device pair that DCSC marks incompatible', () => {
    expect(() => buildWorkspaceNetworkPreferences(baseFabric, [{
      networkTypeId: 'network-type:Management', mainDeviceId: baseFabric.networkDevices[0]!.id,
      cableId: 'cable:bad',
    }])).toThrow(/Unknown cableId "cable:bad".*cable:3760:fixture/i);
    const incompatible: FabricOptions = { ...baseFabric, cables: [{
      ...baseFabric.cables[0]!, id: 'cable:3760:fixture', compatibility: ['different-device'],
    }] };
    expect(() => buildWorkspaceNetworkPreferences(incompatible, [{
      networkTypeId: 'network-type:Management', mainDeviceId: baseFabric.networkDevices[0]!.id,
      cableId: 'cable:3760:fixture',
    }])).toThrow(/main device.*incompatible.*cable/i);
  });
});

it('supports the captured category-only cable selection by explicitly clearing the catalog color', () => {
  const selection = { networkTypeId: baseFabric.networkTypes[0]!.id,
    mainDeviceId: baseFabric.networkDevices[0]!.id, cableId: baseFabric.cables[0]!.id };
  expect(buildWorkspaceNetworkPreferences(baseFabric, [{ ...selection, cableColor: '' }]).clusterPreference[0])
    .toMatchObject({ cableColor: '', cableType: 'Cat5E' });
  expect(buildWorkspaceNetworkPreferences(baseFabric, [selection]).clusterPreference[0]).toMatchObject({ cableColor: 'Green' });
  const fabric = { ...baseFabric, cables: [{ ...baseFabric.cables[0]!, color: 'Blue' }] };
  expect(buildWorkspaceNetworkPreferences(fabric, [{ ...selection, cableColor: 'blue' }]).selections[0])
    .toMatchObject({ cableColor: 'Blue' });
  expect(() => buildWorkspaceNetworkPreferences(fabric, [{ ...selection, cableColor: 'Orange' }])).toThrow('Unknown cableColor');
  expect(() => buildWorkspaceNetworkPreferences(fabric, [{ ...selection, leafCableColor: '' }])).toThrow('Centralized');
});

it.each([{ ports: [] }, { connectorIds: [] }])('clears a network only when an empty selection is explicit: %j', selectors => {
  const selected = buildSelectedTopologies(rawConfiguration, baseFabric, {
    topology: '1GbE_Copper', networkName: 'Management', ...selectors,
  });
  expect(selected.Storage).toEqual(rawConfiguration.selectedTopologies.Storage);
  expect(selected.Management).toMatchObject({ selectedConnectors: [], connectors: 0, maxConnectors: 0 });
  const single = { ...rawConfiguration, connectors: [rawConfiguration.connectors[0]!] };
  expect(buildSelectedTopologies(single, baseFabric, { topology: '1GbE_Copper', networkName: 'Management' }).Management)
    .toMatchObject({ selectedConnectors: single.connectors });
});

it('selects compatible ports for an explicitly assigned storage definition without inventing a fabric network', () => {
  const raw = { ...rawConfiguration, selectedStorageNetwork: 'Direct Storage' };
  const request = { topology: '1GbE_Copper', networkName: 'Direct Storage', ports: ['RJ45:1'] };
  expect(buildSelectedTopologies(raw, baseFabric, request, ['Direct Storage'])['Direct Storage'])
    .toMatchObject({ networkTechnology: '1GbE_Copper', selectedConnectors: [raw.connectors[0]] });
  expect(() => buildSelectedTopologies(rawConfiguration, baseFabric, request, ['Direct Storage'])).toThrow(/assigned/);
  expect(() => buildSelectedTopologies(raw, baseFabric, request, ['Direct Storage', 'Direct Storage'])).toThrow(/uniquely/);
  expect(() => buildSelectedTopologies(raw, baseFabric, request, [])).toThrow(/network/i);
  expect(() => buildSelectedTopologies(raw, baseFabric, { ...request, ports: ['QSFP:1'] }, ['Direct Storage'])).toThrow(/Unknown connector/);
});
