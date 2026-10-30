import { expect, it } from 'vitest';
import { cablingDiagnostics } from '../src/domain/cablingDiagnostics.js';

it('does not let working Management rows conceal an empty assigned storage network', () => {
  const report = cablingDiagnostics([
    { selectedTopologies: { Management: {} }, selectedStorageNetwork: 'SAN' },
    { selectedTopologies: { Management: {} }, selectedStorageNetwork: 'SAN' },
  ], { connections: [{ network: 'Management' }] });
  expect(report).toMatchObject({ requestedNetworkCount: 2, requestedNetworksWithoutConnections: 1,
    completeness: 'unverified', networks: [
      { name: 'Management', connectionCount: 1, status: 'connections_present' },
      { name: 'SAN', storage: true, connectionCount: 0, status: 'no_connections' },
    ] });
});

it('distinguishes disabled P2P and stale retained graphs without claiming completeness', () => {
  const configurations = [{ selectedStorageNetwork: 'SAN' }];
  expect(cablingDiagnostics(configurations, { autoConnectSettings: { p2pCabling: false } }).networks)
    .toMatchObject([{ status: 'p2p_disabled' }]);
  expect(cablingDiagnostics(configurations, { connections: [{ network: 'SAN' }],
    connectionGraphInvalidation: { reason: 'Moved' } })).toMatchObject({
    connectionGraphStale: true, completeness: 'unverified', networks: [{ status: 'stale' }],
  });
});

it('preserves unusual network names and unclassified rows without inventing requested networks', () => {
  const report = cablingDiagnostics([{ selectedTopologies: JSON.parse('{"__proto__":{}}') }], {
    connections: [{ network: '__proto__' }, {}, { network: 'Power' }],
    storageConnectionNetworks: [{ name: 'Unassigned SAN' }],
  });
  expect(report).toMatchObject({ requestedNetworkCount: 1, unclassifiedConnections: 1,
    requestedNetworksWithoutConnections: 0 });
  expect(report.networks.map(network => network.name)).toEqual(['Power', '__proto__']);
});

it('does not report intentionally cleared ports as missing cabling', () => {
  const cleared = { selectedTopologies: { Management: { selectedConnectors: [] } } };
  expect(cablingDiagnostics([cleared], {})).toMatchObject({ requestedNetworkCount: 0,
    requestedNetworksWithoutConnections: 0, networks: [] });
  expect(cablingDiagnostics([cleared], { connections: [{ network: 'Management' }] }).networks)
    .toMatchObject([{ name: 'Management', requested: false, connectionCount: 1 }]);
  expect(cablingDiagnostics([cleared, { selectedTopologies: {
    Management: { selectedConnectors: [{ port: 'RJ45', portNumber: '1' }] },
  } }], {}).requestedNetworksWithoutConnections).toBe(1);
});
