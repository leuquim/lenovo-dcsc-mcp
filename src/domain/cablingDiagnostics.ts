import type { RawConfiguration } from '../model/types.js';
import { readAutoConnectSettings, readConnectionGraph } from './cabling.js';
import { type Obj, objectOrEmpty } from '../util/coerce.js';


/** Observations, not a completeness verdict: one row cannot prove all ports are connected. */
export function cablingDiagnostics(configurations: readonly RawConfiguration[], state: Obj) {
  const requested = new Set<string>();
  const storage = new Set<string>();
  for (const configuration of configurations) {
    for (const [name, value] of Object.entries(objectOrEmpty(configuration.selectedTopologies))) {
      const connectors = objectOrEmpty(value)['selectedConnectors'];
      // Explicit deselection is not a request for missing routes. Older records
      // without connector detail remain conservatively classified as requested.
      if (!Array.isArray(connectors) || connectors.length > 0) requested.add(name);
    }
    const name = configuration.selectedStorageNetwork;
    if (typeof name === 'string' && name !== '') {
      requested.add(name);
      storage.add(name);
    }
  }
  const counts = new Map<string, number>();
  let unclassifiedConnections = 0;
  const graph = readConnectionGraph(state);
  for (const row of graph) {
    const name = objectOrEmpty(row)['network'];
    if (typeof name !== 'string' || name === '') unclassifiedConnections++;
    else counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const stale = state['connectionGraphInvalidation'] !== undefined;
  const p2pDisabled = readAutoConnectSettings(state).p2pCabling === false;
  const networks = [...new Set([...requested, ...counts.keys()])].sort().map(name => ({
    name,
    requested: requested.has(name),
    storage: storage.has(name),
    connectionCount: counts.get(name) ?? 0,
    status: stale ? 'stale' : counts.has(name) ? 'connections_present'
      : p2pDisabled ? 'p2p_disabled' : 'no_connections',
  }));
  return {
    connectionCount: graph.length,
    requestedNetworkCount: requested.size,
    requestedNetworksWithoutConnections: networks.filter(network => network.requested && network.connectionCount === 0).length,
    unclassifiedConnections,
    connectionGraphStale: stale,
    p2pDisabled,
    completeness: 'unverified',
    guidance: 'Connection counts do not establish complete cabling. Inspect each requested network, endpoint and Lenovo message. ' +
      'For missing rows, check P2P settings, network assignments, compatible ports and physical placement. ' +
      'Zero rows can also reflect an upstream limitation; adding a switch is not always the remedy. ' +
      'Local planning links are excluded from these counts and Lenovo exports.',
    networks,
  };
}
