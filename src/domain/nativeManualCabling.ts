import { countNativePhysicalCables } from './cableQuantity.js';
export { countNativePhysicalCables } from './cableQuantity.js';
import { discoverManualPorts, type ManualCablingInput, type ManualConnectionEndpointPatch } from './manualCabling.js';
import type { CableOption } from './fabric.js';
import { resolveLinkedCloneGroup } from './linkedCloneEdit.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

/** Distance results include other speeds and breakout cables; intersect with the fabric catalog. */
export function filterNativeManualCableChoices(distance: unknown, topology: string, catalog: readonly CableOption[], connectionType: 'point-to-point' | 'breakout-4' = 'point-to-point'): Obj {
  const result = structuredClone(object(distance));
  const pointToPointCategories = new Set(['ACC', 'AOC', 'CAT5E', 'CAT6', 'DAC']);
  result['compatibleCables'] = (Array.isArray(result['compatibleCables']) ? result['compatibleCables'] : []).filter(value => {
    const cable = object(value);
    const matches = catalog.filter(option => option.featureCode === cable['featureCode'] &&
      (!cable['optionCode'] || option['option'] === cable['optionCode']));
    return matches.length > 0 && matches.every(option => option.topologies.includes(topology) &&
      (connectionType === 'point-to-point' ? pointToPointCategories.has(String(option['category']).toUpperCase())
        : topology === '100GbE_Copper' && option['category'] === 'DAC - Break Out' &&
          /100G QSFP28 to 4x25G SFP28/i.test(String(option.description))));
  });
  return result;
}

/** The SPA preserves manual source ports in selectedTopologies before derivation. */
export function selectNativeManualSourcePort(configuration: Obj, row: Obj): Obj {
  const topologies = structuredClone(object(configuration['selectedTopologies']));
  const network = String(row['network']);
  const selected = object(topologies[network]);
  if (selected['networkTechnology'] !== row['topology']) throw new Error('Manual source network assignment is missing.');
  const matches = (Array.isArray(configuration['connectors']) ? configuration['connectors'] : []).map(object)
    .filter(connector => connector['port'] === row['sourcePortName'] && connector['portNumber'] === row['sourcePortNumber'] &&
      Array.isArray(connector['topologies']) && connector['topologies'].includes(row['topology']));
  if (matches.length !== 1) throw new Error('Manual source connector is missing or ambiguous.');
  const connectors = Array.isArray(selected['selectedConnectors']) ? selected['selectedConnectors'].map(object) : [];
  if (!connectors.some(connector => connector['port'] === row['sourcePortName'] && connector['portNumber'] === row['sourcePortNumber'])) {
    topologies[network] = { ...selected, selectedConnectors: [...connectors, structuredClone(matches[0]!)] };
  }
  return topologies;
}

/** Resolve shared topology ownership without replacing a physical graph endpoint. */
export function nativeManualSourceConfigurationId(physicalId: string,
  mapping?: ManualCablingInput['physicalTemplateIds']): string {
  return mapping instanceof Map ? mapping.get(physicalId) ?? physicalId
    : (mapping as Readonly<Record<string, string>> | undefined)?.[physicalId] ?? physicalId;
}

/** Native updateSelectedTopologiesById writes shared topology state for all bindings. */
export function selectNativeManualSourceGroup(configurations: readonly Obj[], dependency: unknown, row: Obj, mapping?: ManualCablingInput['physicalTemplateIds']): Map<string, Obj> {
  const sourceId = nativeManualSourceConfigurationId(String(row['sourceId']), mapping);
  const group = resolveLinkedCloneGroup(dependency, configurations.map(c => String(c['id'])), sourceId);
  const source = configurations.find(c => c['id'] === sourceId)!;
  const selected = selectNativeManualSourcePort(source, row);
  return new Map(group.memberIds.map(id => {
    const member = configurations.find(c => c['id'] === id)!;
    // A shared selection must name a real connector on every physical member.
    selectNativeManualSourcePort({ ...member, selectedTopologies: source['selectedTopologies'] }, row);
    return [id, structuredClone(selected)];
  }));
}

export interface NativeManualConnectionRequest {
  network: string; topology: string;
  source: ManualConnectionEndpointPatch; destination: ManualConnectionEndpointPatch;
  cablePart: string;
  connectionType?: 'point-to-point' | 'breakout-4' | undefined;
  pinExistingRoutes?: boolean;
}

/** Opt-in native ownership change: AUTO rows otherwise get regenerated. */
export function seedNativeManualRoutes(connections: readonly unknown[], pin: boolean) {
  let pinnedConnectionCount = 0;
  const rows = connections.map(value => {
    const row = structuredClone(object(value));
    if (pin && row['type'] === 'AUTO' && row['subType'] === 'NETWORK') {
      row['type'] = 'MANUAL'; pinnedConnectionCount++;
    }
    return row;
  });
  return { rows, pinnedConnectionCount };
}

/** Lenovo silently regenerates rejected seeds; HTTP success is insufficient. */
export function assertNativeConnectionsRetained(requested: readonly unknown[], accepted: readonly unknown[]): void {
  const fields = ['network', 'topology', 'sourceId', 'sourcePortName', 'sourcePortNumber',
    'destinationId', 'destinationPortName', 'destinationPortNumber', 'cablePart', 'type',
    'subType', 'category', 'divider'];
  const key = (value: unknown) => JSON.stringify(fields.map(field => object(value)[field]));
  const remaining = accepted.map(object);
  for (const row of requested) {
    const index = remaining.findIndex(candidate => key(candidate) === key(row));
    if (index < 0) {
      const expected = object(row);
      const endpoints = ['sourceId', 'sourcePortName', 'sourcePortNumber',
        'destinationId', 'destinationPortName', 'destinationPortNumber'];
      const candidates = remaining.filter(candidate => endpoints.every(field => candidate[field] === expected[field]));
      const changed = candidates.length === 1
        ? fields.filter(field => candidates[0]![field] !== expected[field])
          .map(field => `${field}: requested ${JSON.stringify(expected[field])?.slice(0, 100)}, returned ${JSON.stringify(candidates[0]![field])?.slice(0, 100)}`)
        : [];
      const detail = changed.length ? ` Native response changed ${changed.join('; ')}.` : '';
      throw new Error(`DCSC did not retain the requested connection graph.${detail} Workspace was not committed.`);
    }
    remaining.splice(index, 1);
  }
}

/** Cover graph usage without consuming cables the user selected as spares. */
export function planNativeManualCableSelection(input: ManualCablingInput, row: Obj) {
  const physicalDestinationId = row['destinationId']; const code = row['cablePart'];
  const configurationId = typeof physicalDestinationId === 'string'
    ? nativeManualSourceConfigurationId(physicalDestinationId, input.physicalTemplateIds) : physicalDestinationId;
  const feature = object(row['cableFeature']);
  const groups = feature['selectionGroups'];
  if (typeof configurationId !== 'string' || typeof code !== 'string' || !code ||
      feature['featureCode'] !== code || !Array.isArray(groups) || groups.length > 1 || (groups.length === 1 && typeof groups[0] !== 'string')) {
    throw new Error('Manual cable does not identify one native part and selection group.');
  }
  const configurations = input.configurations.filter(c => (c.id ?? c.configurationId) === configurationId);
  if (configurations.length !== 1) throw new Error('Manual cable destination must resolve to one direct configuration.');
  const configuration = configurations[0]!;
  if (groups.length && feature['ctoCode'] !== (configuration.ctoCode ?? configuration.code)) {
    throw new Error('Manual cable does not belong to the destination product.');
  }
  const sections = (configuration.tabs ?? []).flatMap(tab => tab.subTabs ?? [])
    .flatMap(tab => tab.sections ?? []).filter(section => groups.length ? section.name === groups[0]
      : section.features?.some(candidate => candidate.code === code));
  if (sections.length !== 1) throw new Error('Manual cable selection group is missing or ambiguous.');
  const group = resolveLinkedCloneGroup(input.cloneDependency, input.configurations.map(c => String(c.id)), configurationId);
  const aliases = input.physicalTemplateIds instanceof Map ? [...input.physicalTemplateIds]
    : Object.entries(input.physicalTemplateIds ?? {});
  const physicalDestinationIds = group.memberIds.flatMap(id => {
    const physical = aliases.filter(([, template]) => template === id).map(([alias]) => alias);
    return physical.length ? physical : [id];
  });
  const previousQuantities = group.memberIds.map(id => {
    const member = input.configurations.find(c => c.id === id)!;
    if (member.code !== configuration.code) throw new Error('Linked cable destinations disagree on product identity.');
    const matches = (member.tabs ?? []).flatMap(t => t.subTabs ?? []).flatMap(t => t.sections ?? [])
      .filter(s => s.name === sections[0]!.name);
    if (matches.length !== 1) throw new Error('Linked cable selection group is missing or ambiguous.');
    const selected = (matches[0]!.results ?? []).filter(result => result.code === code);
    const quantity = selected[0]?.quantity ?? 0;
    if (selected.length > 1 || !Number.isInteger(quantity) || quantity < 0) {
      throw new Error('Manual cable selected quantity is invalid or ambiguous.');
    }
    return quantity;
  });
  if (new Set(previousQuantities).size !== 1) throw new Error('Linked destinations have divergent cable quantities.');
  const previousQuantity = previousQuantities[0]!;
  const usage = input.connections.map(object).filter(connection =>
    physicalDestinationIds.includes(String(connection['destinationId'])) && connection['cablePart'] === code);
  if (!usage.length) throw new Error('Manual cable quantity requires an accepted graph.');
  if (!sections[0]!.name) throw new Error('Manual cable selection group has no native name.');
  // Native linked editing selects the same per-product quantity for every member.
  const requiredQuantity = Math.max(...physicalDestinationIds.map(id => countNativePhysicalCables(usage.filter(c => c['destinationId'] === id))));
  return { configurationId, physicalDestinationIds, section: sections[0]!.name, code, previousQuantity, requiredQuantity,
    quantity: Math.max(previousQuantity, requiredQuantity), ...(group.linked ? { configurationIds: group.memberIds } : {}) };

}

/** Preserve explicit quantities for imported manual routes across layout recalculation. */
export function importedManualCableSelections(input: ManualCablingInput) {
  // Native CFXML omits category on point-to-point rows but retains divider=1.
  // Normalize only the planning copy; the accepted native graph stays untouched.
  const imported = { ...input, connections: input.connections.map(value => {
    const row = object(value);
    return row['category'] == null && row['divider'] === 1 ? { ...row, category: 'P2P' } : row;
  }) };
  const plans = new Map<string, ReturnType<typeof planNativeManualCableSelection>>();
  for (const value of imported.connections) {
    const row = object(value);
    if (row['type'] !== 'MANUAL' || row['subType'] !== 'NETWORK' || row['category'] !== 'P2P') continue;
    if (typeof row['destinationId'] !== 'string') continue;
    const id = nativeManualSourceConfigurationId(row['destinationId'], input.physicalTemplateIds);
    const configurations = input.configurations.filter(configuration => configuration.id === id);
    if (configurations.length !== 1) continue;
    const configuration = configurations[0]!;
    const selectedSections = (configuration.tabs ?? []).flatMap(tab => tab.subTabs ?? [])
      .flatMap(tab => tab.sections ?? []).filter(section =>
        section.results?.some(result => result.code === row['cablePart'] && (result.quantity ?? 0) > 0));
    // Only an explicit, unambiguous imported selection proves spare ownership.
    if (selectedSections.length !== 1 || !selectedSections[0]!.name) continue;
    const plan = planNativeManualCableSelection(imported, { ...row,
      cableFeature: { featureCode: row['cablePart'], selectionGroups: [selectedSections[0]!.name],
        ctoCode: configuration.ctoCode ?? configuration.code } });
    // Preserve selected spares; do not manufacture quantities absent from import.
    if (plan.previousQuantity < plan.requiredQuantity) continue;
    plans.set(JSON.stringify([plan.configurationIds ?? [plan.configurationId], plan.code]), plan);
  }
  return [...plans.values()];
}

/** Rack feature rows override configuration quantities during native workspace derive. */
export function stageNativeManualCableQuantity(input: ManualCablingInput,
  plan: Omit<ReturnType<typeof planNativeManualCableSelection>, 'physicalDestinationIds'> & { physicalDestinationIds?: string[]; retainAsSpare?: boolean },
  fallback?: Pick<ManualCablingInput, 'rackArea' | 'nonRackArea'>) {
  const layout = structuredClone({ rackArea: [...input.rackArea], nonRackArea: [...input.nonRackArea ?? []] });
  for (const id of plan.physicalDestinationIds ?? plan.configurationIds ?? [plan.configurationId]) {
    const matches: Obj[] = [];
    const visit = (value: unknown): void => {
      const item = object(value);
      if (item['id'] === id) matches.push(item);
      for (const field of ['rackItems', 'nodes']) if (Array.isArray(item[field])) item[field].forEach(visit);
    };
    [...layout.rackArea, ...layout.nonRackArea].forEach(visit);
    if (matches.length !== 1) throw new Error('Manual cable destination placement is missing or ambiguous; linked members must be placed.');
    const sections = (Array.isArray(matches[0]!['features']) ? matches[0]!['features'] : []).map(object)
      .filter(section => section['name'] === plan.section);
    if (sections.length > 1) throw new Error('Manual cable physical section is ambiguous.');
    const results = (Array.isArray(sections[0]?.['results']) ? sections[0]!['results'] : []).map(object)
      .filter(result => result['code'] === plan.code);
    if (results.length > 1) throw new Error('Manual cable physical quantity is ambiguous.');
    if (results[0]) {
      results[0]['quantity'] = plan.quantity;
      if (plan.retainAsSpare) results[0]['forAutoConnect'] = false;
    } else if (fallback && plan.quantity > 0) {
      // Auto-connect removes a previously routed part when it becomes a spare.
      // Restore only the exact pre-call physical record of an explicit selection.
      const originals: Obj[] = [];
      const collect = (value: unknown): void => {
        const item = object(value);
        if (item['id'] === id) originals.push(item);
        for (const key of ['rackItems', 'nodes']) if (Array.isArray(item[key])) item[key].forEach(collect);
      };
      [...fallback.rackArea, ...fallback.nonRackArea ?? []].forEach(collect);
      const originalSections = originals.flatMap(item => Array.isArray(item['features']) ? item['features'].map(object) : [])
        .filter(section => section['name'] === plan.section);
      const originalResults = originalSections.flatMap(section => Array.isArray(section['results']) ? section['results'].map(object) : [])
        .filter(result => result['code'] === plan.code);
      if (originals.length !== 1 || originalSections.length !== 1 || originalResults.length !== 1) {
        throw new Error('Explicit spare cable has no unambiguous pre-connect physical record.');
      }
      const restored = { ...structuredClone(originalResults[0]!), quantity: plan.quantity,
        forAutoConnect: input.connections.some(value => {
          const row = object(value); return row['destinationId'] === id && row['cablePart'] === plan.code;
        }) };
      if (!sections[0]) {
        const features = Array.isArray(matches[0]!['features']) ? matches[0]!['features'] : [];
        matches[0]!['features'] = [...features, { ...structuredClone(originalSections[0]!), results: [restored] }];
      } else sections[0]['results'] = [...(Array.isArray(sections[0]['results']) ? sections[0]['results'] : []), restored];
    }
  }
  return layout;
}

/** Build the complete native row from physical ports and an authoritative distance response. */
export function stageNativeManualConnection(input: ManualCablingInput, request: NativeManualConnectionRequest & { distance: unknown }): Obj {
  if (!request.network.trim() || !request.topology.trim()) throw new Error('Native manual cabling requires a network and topology.');
  const ports = discoverManualPorts(input);
  const resolve = (endpoint: ManualConnectionEndpointPatch) => {
    const choices = ports.filter(port => port.configurationId === endpoint.configurationId &&
      port.name === endpoint.portName && port.number === endpoint.portNumber && port.topologies.includes(request.topology));
    if (choices.length !== 1 || !choices[0]!.location || !choices[0]!.code) throw new Error('Endpoint is not one placed, compatible native port.');
    return choices[0]!;
  };
  const source = resolve(request.source); const destination = resolve(request.destination);
  if (source.configurationId === destination.configurationId && source.name === destination.name && source.number === destination.number) {
    throw new Error('A connection cannot connect a port to itself.');
  }
  const breakout = request.connectionType === 'breakout-4';
  if (breakout && (request.topology !== '100GbE_Copper' || source.name !== 'SFP28' || destination.name !== 'QSFP28')) {
    throw new Error('Four-way breakout requires SFP28 source and QSFP28 destination on 100GbE_Copper.');
  }
  const shared: Obj[] = [];
  for (const raw of input.connections) {
    const row = object(raw);
    for (const port of [source, destination]) for (const side of ['source', 'destination']) {
      if (row[`${side}Id`] === port.configurationId && row[`${side}PortName`] === port.name && row[`${side}PortNumber`] === port.number) {
        if (breakout && port === destination && side === 'destination' && row['category'] === 'BREAKOUT' &&
            row['divider'] === 4 && row['cablePart'] === request.cablePart && row['network'] === request.network && row['topology'] === request.topology) {
          shared.push(row);
        } else throw new Error('Native port is already connected. Edit its existing connection instead.');
      }
    }
  }
  if (shared.length >= 4) throw new Error('Breakout destination has no free branches.');
  const distance = object(request.distance);
  if (object(distance['from'])['itemId'] !== source.configurationId || object(distance['to'])['itemId'] !== destination.configurationId ||
      typeof distance['totalDistance'] !== 'number' || !Number.isFinite(distance['totalDistance']) || distance['totalDistance'] < 0) {
    throw new Error('Native distance response does not match the requested endpoints.');
  }
  const choices = (Array.isArray(distance['compatibleCables']) ? distance['compatibleCables'] : []).map(object)
    .filter(cable => cable['featureCode'] === request.cablePart);
  if (choices.length !== 1) throw new Error('Cable part is not one compatible choice for this topology and point-to-point connection.');
  const cable = choices[0]!;
  return {
    network: request.network, topology: request.topology,
    cablePart: request.cablePart, cableOption: cable['optionCode'] ?? null,
    cablePrice: cable['price'] ?? null, cableType: cable['description'] ?? null,
    totalDistance: distance['totalDistance'],
    sourceId: source.configurationId, sourcePart: source.code, sourceItem: source.description ?? null,
    sourceLocation: source.location, sourcePortNumber: source.number, sourcePortName: source.name,
    destinationId: destination.configurationId, destinationPart: destination.code, destinationItem: destination.description ?? null,
    destinationLocation: destination.location, destinationPortNumber: destination.number, destinationPortName: destination.name,
    cableDistance: structuredClone(distance), cableFeature: structuredClone(cable), preferredCable: null,
    type: 'MANUAL', subType: 'NETWORK', divider: breakout ? 4 : 1, category: breakout ? 'BREAKOUT' : 'P2P',
  };
}
