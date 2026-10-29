import { createHash } from 'node:crypto';
import { reduceConfiguration } from './reduce.js';
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function string(value) {
    return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function strings(value) {
    return Array.isArray(value) ? value.map(string).filter(Boolean) : [];
}
export function manualConnectionId(value) {
    const row = object(value);
    const identity = [row['network'], row['topology'], row['sourceId'], row['sourcePortName'],
        row['sourcePortNumber'], row['destinationId'], row['destinationPortName'], row['destinationPortNumber']]
        .map(string);
    if (identity.every(part => part === ''))
        throw new Error('Cannot identify an empty cabling row.');
    return `connection_${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20)}`;
}
function cableChoices(row) {
    const distance = object(row['cableDistance']);
    const choices = Array.isArray(distance['compatibleCables']) ? distance['compatibleCables'] : [];
    const mapped = choices.map(value => {
        const raw = object(value);
        return {
            part: string(raw['featureCode'] ?? raw['code']),
            ...(string(raw['optionCode']) ? { option: string(raw['optionCode']) } : {}),
            ...(string(raw['description']) ? { description: string(raw['description']) } : {}),
            ...(number(raw['price']) !== undefined ? { price: number(raw['price']) } : {}),
            ...(number(raw['length']) !== undefined ? { length: number(raw['length']) } : {}),
            raw: structuredClone(raw),
        };
    }).filter(choice => choice.part !== '');
    const current = string(row['cablePart']);
    if (current && !mapped.some(choice => choice.part === current)) {
        mapped.push({ part: current,
            ...(string(row['cableOption']) ? { option: string(row['cableOption']) } : {}),
            ...(string(row['cableType']) ? { description: string(row['cableType']) } : {}),
            ...(number(row['cablePrice']) !== undefined ? { price: number(row['cablePrice']) } : {}),
            raw: object(row['cableFeature']),
        });
    }
    return mapped;
}
function physicalItems(input) {
    const coordinates = new Map();
    const floorPhysical = new Map();
    for (const value of input.floorItems ?? []) {
        const item = object(value);
        const rackItem = object(item['rackItem']);
        const rackId = string(rackItem['id'] ?? item['sourceId'] ?? item['id']);
        const row = number(item['row']);
        const col = number(item['col']);
        const coordinate = string(item['coordinate'] ?? item['rackPosition']) ||
            (row !== undefined && col !== undefined ? `${String.fromCharCode(65 + row)}${col + 1}` : '');
        if (rackId && coordinate)
            coordinates.set(rackId, coordinate);
        const items = Array.isArray(rackItem['items']) ? rackItem['items'] :
            Array.isArray(item['items']) ? item['items'] : [];
        for (const physicalValue of items) {
            const physical = object(physicalValue);
            const id = string(physical['id']);
            if (!id)
                continue;
            const position = number(physical['position']);
            const code = string(physical['code'] ?? physical['sliceCtoCode']);
            const description = string(physical['description']);
            floorPhysical.set(id, {
                ...(rackId ? { rackId } : {}), ...(position !== undefined ? { position } : {}),
                ...(code ? { code } : {}), ...(description ? { description } : {}),
                ...(coordinate ? { coordinate } : {}),
            });
        }
    }
    const result = new Map();
    for (const rack of input.rackArea) {
        const rackId = string(rack['id']);
        for (const value of Array.isArray(rack['rackItems']) ? rack['rackItems'] : []) {
            const item = object(value);
            const id = string(item['id']);
            if (!id)
                continue;
            const floor = floorPhysical.get(id);
            const position = number(item['position']) ?? floor?.position;
            const code = string(item['code'] ?? item['sliceCtoCode']) || floor?.code;
            const description = string(item['description']) || floor?.description;
            const coordinate = coordinates.get(rackId) ?? floor?.coordinate;
            result.set(id, {
                ...(rackId ? { rackId } : {}),
                ...(position !== undefined ? { position } : {}), ...(code ? { code } : {}),
                ...(description ? { description } : {}), ...(coordinate ? { coordinate } : {}),
            });
        }
    }
    for (const [id, placement] of floorPhysical)
        if (!result.has(id))
            result.set(id, placement);
    for (const value of input.nonRackArea ?? []) {
        const item = object(value);
        const id = string(item['id']);
        if (id && !result.has(id))
            result.set(id, {
                ...(string(item['code'] ?? item['sliceCtoCode']) ? { code: string(item['code'] ?? item['sliceCtoCode']) } : {}),
                ...(string(item['description']) ? { description: string(item['description']) } : {}),
            });
    }
    return result;
}
export function discoverManualPorts(input) {
    const physical = physicalItems(input);
    const templates = input.physicalTemplateIds instanceof Map
        ? input.physicalTemplateIds
        : new Map(Object.entries(input.physicalTemplateIds ?? {}));
    const configurations = new Map(input.configurations.map(configuration => [
        string(configuration['id'] ?? configuration['configurationId']), configuration,
    ]));
    const result = [];
    for (const [configurationId, placement] of physical) {
        const templateId = templates.get(configurationId) ?? configurationId;
        const configuration = configurations.get(templateId);
        if (!configuration)
            continue;
        const connectors = Array.isArray(configuration['connectors']) ? configuration['connectors'] : [];
        for (const value of connectors) {
            const connector = object(value);
            const name = string(connector['port'] ?? connector['portDescription'] ?? connector['name']);
            const portNumber = string(connector['portNumber'] ?? connector['number']);
            if (!name || !portNumber)
                continue;
            const coordinate = placement.coordinate;
            const location = coordinate && placement.position !== undefined
                ? `${coordinate}/U${placement.position}/${name}` : undefined;
            result.push({ configurationId,
                ...(placement.code ?? string(configuration['sliceCtoCode'] ?? configuration['code'])
                    ? { code: placement.code ?? string(configuration['sliceCtoCode'] ?? configuration['code']) } : {}),
                ...(placement.description ?? string(configuration['description'])
                    ? { description: placement.description ?? string(configuration['description']) } : {}),
                ...(placement.rackId ? { rackId: placement.rackId } : {}),
                ...(placement.position !== undefined ? { position: placement.position } : {}),
                ...(location ? { location } : {}),
                name, number: portNumber, topologies: strings(connector['topologies']),
            });
        }
    }
    return result.sort((left, right) => left.configurationId.localeCompare(right.configurationId) ||
        left.name.localeCompare(right.name) || left.number.localeCompare(right.number, undefined, { numeric: true }));
}
export function projectManualConnection(value) {
    const row = object(value);
    const choices = cableChoices(row);
    return {
        id: manualConnectionId(row),
        ...(string(row['network']) ? { network: string(row['network']) } : {}),
        ...(string(row['topology']) ? { topology: string(row['topology']) } : {}),
        ...(string(row['type']) ? { type: string(row['type']) } : {}),
        source: { configurationId: string(row['sourceId']), portName: string(row['sourcePortName']),
            portNumber: string(row['sourcePortNumber']),
            ...(string(row['sourceLocation']) ? { location: string(row['sourceLocation']) } : {}) },
        destination: { configurationId: string(row['destinationId']), portName: string(row['destinationPortName']),
            portNumber: string(row['destinationPortNumber']),
            ...(string(row['destinationLocation']) ? { location: string(row['destinationLocation']) } : {}) },
        cable: { ...(string(row['cablePart']) ? { part: string(row['cablePart']) } : {}),
            ...(string(row['cableOption']) ? { option: string(row['cableOption']) } : {}),
            ...(string(row['cableType']) ? { description: string(row['cableType']) } : {}) },
        ...(number(row['totalDistance'] ?? object(row['cableDistance'])['totalDistance']) !== undefined
            ? { totalDistance: number(row['totalDistance'] ?? object(row['cableDistance'])['totalDistance']) } : {}),
        compatibleCables: choices.map(({ raw: _raw, ...choice }) => choice),
    };
}
export function inspectManualCabling(input) {
    return { connections: input.connections.map(projectManualConnection), ports: discoverManualPorts(input) };
}
function findPort(ports, endpoint, topology) {
    const matches = ports.filter(choice => choice.configurationId === endpoint.configurationId &&
        choice.name === endpoint.portName && choice.number === endpoint.portNumber &&
        (!topology || choice.topologies.length === 0 || choice.topologies.includes(topology)));
    if (matches.length !== 1) {
        throw new Error(`Endpoint ${endpoint.configurationId} ${endpoint.portName} - ${endpoint.portNumber} is not one selectable ${topology || 'network'} port. Inspect dcsc_cabling_connections again.`);
    }
    return matches[0];
}
function endpointKey(configurationId, portName, portNumber) {
    return JSON.stringify([string(configurationId), string(portName), string(portNumber)]);
}
function physicalTemplateId(input, physicalId) {
    const mapping = input.physicalTemplateIds;
    if (mapping && typeof mapping.get === 'function') {
        return mapping.get(physicalId) ?? physicalId;
    }
    return mapping?.[physicalId] ?? physicalId;
}
function replaceRackCableFeature(input, physicalId, sectionName, oldCode, oldTargetQuantity) {
    const rackArea = structuredClone([...input.rackArea]);
    const nonRackArea = structuredClone([...(input.nonRackArea ?? [])]);
    const matches = [];
    const visit = (value) => {
        const item = object(value);
        if (string(item['id']) === physicalId)
            matches.push(item);
        for (const key of ['rackItems', 'servers', 'items', 'nodes', 'children']) {
            if (Array.isArray(item[key]))
                for (const child of item[key])
                    visit(child);
        }
    };
    for (const value of [...rackArea, ...nonRackArea])
        visit(value);
    if (matches.length !== 1) {
        throw new Error(`Physical cable destination ${physicalId} is missing or ambiguous in the current layout.`);
    }
    const features = Array.isArray(matches[0]['features']) ? matches[0]['features'] : [];
    const sections = features.map(object).filter(feature => string(feature['name']) === sectionName);
    // updateRackDataResults is a no-op when the physical item has no matching
    // section/result. The accepted targeted derive is applied separately after
    // the response arrives. Multiple matching sections are ambiguous and unsafe.
    if (sections.length === 0)
        return { rackArea, nonRackArea };
    if (sections.length > 1)
        throw new Error(`Cable section ${sectionName} is ambiguous on physical destination ${physicalId}.`);
    const results = Array.isArray(sections[0]['results']) ? sections[0]['results'] : [];
    const old = results.map(object).filter(result => string(result['code']) === oldCode);
    if (old.length === 0)
        return { rackArea, nonRackArea };
    if (old.length !== 1 || (number(old[0]['quantity']) ?? 0) <= 0) {
        throw new Error(`Cable ${oldCode} has an unsafe physical feature quantity for replacement.`);
    }
    // Native one-row behavior removes the old result. For a shared cable, keep
    // the residual graph-backed quantity so the derive sees a consistent rack.
    sections[0]['results'] = results.flatMap(result => {
        const value = object(result);
        if (string(value['code']) !== oldCode)
            return [result];
        return oldTargetQuantity > 0 ? [{ ...structuredClone(value), quantity: oldTargetQuantity }] : [];
    });
    return { rackArea, nonRackArea };
}
function stageManualCableReplacement(input, before, staged, cablePart) {
    const oldCode = string(before['cablePart']);
    const newCode = cablePart.trim();
    if (!oldCode)
        throw new Error('The current connection has no cable part to replace.');
    if (!newCode)
        throw new Error('cablePart must be a non-empty compatible part identifier.');
    if (newCode === oldCode)
        throw new Error('The requested cable part is already selected.');
    const choices = cableChoices(before).filter(choice => choice.part === newCode);
    if (choices.length !== 1) {
        throw new Error(`Cable part ${newCode} is not one compatible choice for this connection. Inspect it again.`);
    }
    const oldChoice = cableChoices(before).filter(choice => choice.part === oldCode);
    const oldFeature = object(before['cableFeature']);
    const selectionGroups = strings(oldFeature['selectionGroups']).length > 0
        ? strings(oldFeature['selectionGroups'])
        : oldChoice.length === 1 ? strings(oldChoice[0].raw['selectionGroups']) : [];
    if (selectionGroups.length !== 1) {
        throw new Error(`Cable ${oldCode} does not identify one configuration selection group.`);
    }
    const sectionName = selectionGroups[0];
    const physicalDestinationId = string(before['destinationId']);
    if (!physicalDestinationId)
        throw new Error('The current connection has no physical destination.');
    const configurationId = physicalTemplateId(input, physicalDestinationId);
    const configurations = input.configurations.filter(configuration => string(configuration['id'] ?? configuration['configurationId']) === configurationId);
    if (configurations.length !== 1) {
        throw new Error(`Destination configuration ${configurationId} is missing or ambiguous.`);
    }
    const oldUsage = input.connections.filter(value => {
        const row = object(value);
        return string(row['destinationId']) === physicalDestinationId && string(row['cablePart']) === oldCode;
    }).length;
    const newUsage = input.connections.filter(value => {
        const row = object(value);
        return string(row['destinationId']) === physicalDestinationId && string(row['cablePart']) === newCode;
    }).length;
    if (configurationId !== physicalDestinationId) {
        throw new Error(`Cable-part replacement for managed physical alias ${physicalDestinationId} is not supported until ` +
            'the website template/physical derive contract is captured. Endpoint edits remain available.');
    }
    const reducedConfiguration = reduceConfiguration(configurations[0], configurationId, input.mode ?? 'cto', input.solutionMode);
    const sections = reducedConfiguration.sections.filter(section => section.name === sectionName);
    if (sections.length !== 1) {
        throw new Error(`Cable section ${sectionName} is missing or ambiguous in configuration ${configurationId}.`);
    }
    const originalResults = sections[0].results;
    const oldResults = originalResults.filter(result => result.code === oldCode);
    const newResults = originalResults.filter(result => result.code === newCode);
    if (oldResults.length !== 1 || oldResults[0].quantity < 1 || newResults.length > 1) {
        throw new Error(`Cable selections ${oldCode}/${newCode} are ambiguous before replacement.`);
    }
    const beforeOldQuantity = oldResults[0].quantity;
    const beforeNewQuantity = newResults[0]?.quantity ?? 0;
    if (beforeNewQuantity < 0)
        throw new Error(`Cable ${newCode} has an invalid selected quantity.`);
    const oldTargetQuantity = Math.max(beforeOldQuantity - 1, oldUsage - 1);
    const newTargetQuantity = Math.max(beforeNewQuantity, newUsage + 1);
    const wireMode = oldUsage === 1 && beforeOldQuantity === 1 && newUsage === 0 && beforeNewQuantity <= 1
        ? 'native-single' : 'quantity-preserving';
    const appended = {
        code: newCode,
        quantity: newTargetQuantity,
        ...(typeof sections[0]['productNumber'] === 'string'
            ? { productNumber: sections[0]['productNumber'] } : {}),
        type: typeof sections[0].type === 'string' ? sections[0].type : 'hardware',
        autoCorrected: false,
    };
    if (wireMode === 'native-single') {
        // Captured replaceSectionState semantics deliberately retain an existing
        // new-code result and append another quantity-one result. DCSC collapses
        // that duplicate in its authoritative response.
        sections[0].results = originalResults.filter(result => result.code !== oldCode);
        sections[0].results.push(appended);
    }
    else {
        let emittedOld = false;
        let emittedNew = false;
        sections[0].results = originalResults.flatMap(result => {
            if (result.code === oldCode) {
                if (emittedOld || oldTargetQuantity === 0)
                    return [];
                emittedOld = true;
                return [{ ...result, quantity: oldTargetQuantity }];
            }
            if (result.code === newCode) {
                if (emittedNew)
                    return [];
                emittedNew = true;
                return [{ ...result, quantity: newTargetQuantity }];
            }
            return [result];
        });
        if (!emittedNew)
            sections[0].results.push(appended);
    }
    reducedConfiguration.delta = {
        section: sectionName, featureCode: newCode, quantity: newTargetQuantity, isClear: false,
        type: typeof sections[0].type === 'string' ? sections[0].type : 'hardware',
    };
    const physical = replaceRackCableFeature(input, physicalDestinationId, sectionName, oldCode, oldTargetQuantity);
    const choice = choices[0];
    staged['cablePart'] = choice.part;
    if (choice.option !== undefined)
        staged['cableOption'] = choice.option;
    if (choice.description !== undefined)
        staged['cableType'] = choice.description;
    if (choice.price !== undefined)
        staged['cablePrice'] = choice.price;
    staged['cableFeature'] = structuredClone(choice.raw);
    staged['type'] = 'MANUAL';
    return {
        physicalDestinationId, configurationId, sectionName, oldCode, newCode, quantity: newTargetQuantity,
        graphUsage: { oldCode: oldUsage, newCode: newUsage }, choice: structuredClone(choice),
        targetQuantities: { oldCode: oldTargetQuantity, newCode: newTargetQuantity }, wireMode,
        reducedConfiguration, ...physical,
        query: { configurationId }, customizingIds: [configurationId],
    };
}
/**
 * Applies the accepted targeted derive to the cable destination's physical
 * feature list. The browser first removes the old rack feature locally, then
 * rebuilds the selected feature from the accepted configuration and placement
 * result. This matters when the new part was not already present physically.
 */
export function applyAcceptedManualCablePhysicalState(replacement, acceptedConfiguration, response) {
    const acceptedId = string(acceptedConfiguration['id'] ?? acceptedConfiguration['configurationId']);
    if (acceptedId !== replacement.configurationId) {
        throw new Error(`Accepted cable configuration ${acceptedId || '(missing)'} does not match ${replacement.configurationId}.`);
    }
    const rawSections = [];
    for (const tabValue of acceptedConfiguration.tabs ?? []) {
        const tab = object(tabValue);
        for (const subTabValue of Array.isArray(tab['subTabs']) ? tab['subTabs'] : []) {
            const subTab = object(subTabValue);
            for (const sectionValue of Array.isArray(subTab['sections']) ? subTab['sections'] : []) {
                const section = object(sectionValue);
                if (string(section['name']) === replacement.sectionName)
                    rawSections.push(section);
            }
        }
    }
    for (const sectionValue of Array.isArray(acceptedConfiguration['unSelectableCharacters'])
        ? acceptedConfiguration['unSelectableCharacters'] : []) {
        const section = object(sectionValue);
        if (string(section['name']) === replacement.sectionName)
            rawSections.push(section);
    }
    if (rawSections.length !== 1) {
        throw new Error(`Accepted cable section ${replacement.sectionName} is missing or ambiguous.`);
    }
    const acceptedResults = Array.isArray(rawSections[0]['results'])
        ? rawSections[0]['results'].map(object) : [];
    const selected = acceptedResults.filter(result => string(result['code']) === replacement.newCode);
    const retainedOld = acceptedResults.filter(result => string(result['code']) === replacement.oldCode);
    const oldAccepted = replacement.targetQuantities.oldCode === 0
        ? retainedOld.length === 0
        : retainedOld.length === 1 && number(retainedOld[0]['quantity']) === replacement.targetQuantities.oldCode;
    if (selected.length !== 1 || number(selected[0]['quantity']) !== replacement.targetQuantities.newCode || !oldAccepted ||
        acceptedResults.some(result => !string(result['code']) || (number(result['quantity']) ?? 0) <= 0) ||
        new Set(acceptedResults.map(result => string(result['code']))).size !== acceptedResults.length) {
        throw new Error(`Accepted cable configuration does not contain target quantities ${replacement.oldCode}=` +
            `${replacement.targetQuantities.oldCode}, ${replacement.newCode}=${replacement.targetQuantities.newCode}.`);
    }
    const wrapper = object(response);
    const placements = Array.isArray(wrapper['placementResults']) ? wrapper['placementResults'].map(object) : [];
    const configurationPlacements = placements.filter(placement => string(placement['workspaceId'] ?? placement['configurationId'] ?? placement['id']) === replacement.configurationId);
    if (configurationPlacements.length !== 1) {
        throw new Error(`Accepted cable placement for ${replacement.configurationId} is missing or ambiguous.`);
    }
    const sectionPlacements = (Array.isArray(configurationPlacements[0]['sectionPlacement'])
        ? configurationPlacements[0]['sectionPlacement'].map(object) : [])
        .filter(section => string(section['sectionName']) === replacement.sectionName);
    if (sectionPlacements.length !== 1) {
        throw new Error(`Accepted cable placement section ${replacement.sectionName} is missing or ambiguous.`);
    }
    const featurePlacements = Array.isArray(sectionPlacements[0]['featurePlacement'])
        ? sectionPlacements[0]['featurePlacement'].map(object) : [];
    const placementsByCode = new Map();
    for (const result of acceptedResults) {
        const code = string(result['code']);
        const matches = featurePlacements.filter(feature => string(feature['featureCode']) === code);
        if (matches.length !== 1 ||
            (matches[0]['placementError'] !== undefined && matches[0]['placementError'] !== null)) {
            throw new Error(`Accepted cable placement for ${code} is missing, ambiguous or invalid.`);
        }
        placementsByCode.set(code, matches[0]);
    }
    const rackArea = structuredClone(replacement.rackArea);
    const nonRackArea = structuredClone(replacement.nonRackArea);
    const physicalMatches = [];
    const visit = (value) => {
        const item = object(value);
        if (string(item['id']) === replacement.physicalDestinationId)
            physicalMatches.push(item);
        for (const key of ['rackItems', 'servers', 'items', 'nodes', 'children']) {
            if (Array.isArray(item[key]))
                for (const child of item[key])
                    visit(child);
        }
    };
    for (const value of [...rackArea, ...nonRackArea])
        visit(value);
    if (physicalMatches.length !== 1) {
        throw new Error(`Physical cable destination ${replacement.physicalDestinationId} is missing or ambiguous after derive.`);
    }
    const features = Array.isArray(physicalMatches[0]['features'])
        ? physicalMatches[0]['features'].map(object) : [];
    let physicalSections = features.filter(section => string(section['name']) === replacement.sectionName);
    if (physicalSections.length > 1) {
        throw new Error(`Physical cable section ${replacement.sectionName} is ambiguous after derive.`);
    }
    if (physicalSections.length === 0) {
        const created = { name: replacement.sectionName, results: [] };
        features.push(created);
        physicalMatches[0]['features'] = features;
        physicalSections = [created];
    }
    const physicalResults = Array.isArray(physicalSections[0]['results'])
        ? physicalSections[0]['results'].map(object) : [];
    const physicalOld = physicalResults.filter(result => string(result['code']) === replacement.oldCode);
    if (replacement.targetQuantities.oldCode === 0 ? physicalOld.length > 0 :
        physicalOld.length !== 1 || number(physicalOld[0]['quantity']) !== replacement.targetQuantities.oldCode) {
        throw new Error(`Physical cable ${replacement.oldCode} does not match the target quantity after derive.`);
    }
    const existingByCode = new Map();
    for (const result of physicalResults) {
        const code = string(result['code']);
        if (!code)
            continue;
        if (existingByCode.has(code))
            throw new Error(`Physical cable ${code} is duplicated after derive.`);
        existingByCode.set(code, result);
    }
    // The accepted cable section is authoritative for the whole physical
    // section. This restores independent selected cable codes that a partial
    // rack metadata refresh may omit while removing the replaced old code.
    physicalSections[0]['results'] = acceptedResults.map(accepted => {
        const code = string(accepted['code']);
        const existing = existingByCode.get(code);
        const placement = placementsByCode.get(code);
        return {
            ...(existing ? structuredClone(existing) : {}),
            code,
            ...(string(accepted['description']) ? { description: string(accepted['description']) } : {}),
            quantity: number(accepted['quantity']),
            forAutoConnect: typeof existing?.['forAutoConnect'] === 'boolean'
                ? existing['forAutoConnect'] : code === replacement.newCode,
            installations: Array.isArray(placement['installations']) ? structuredClone(placement['installations']) : [],
            attributeMap: existing && Object.hasOwn(existing, 'attributeMap')
                ? structuredClone(existing['attributeMap']) : null,
        };
    });
    return { rackArea, nonRackArea };
}
export function stageManualConnectionEdit(input, edit) {
    if (!edit.source && !edit.destination && !edit.cablePart) {
        throw new Error('Supply a source, destination or cable-part change.');
    }
    if (edit.cablePart && (edit.source || edit.destination)) {
        throw new Error('Edit endpoints and cablePart in separate revision-bound calls so each uses current compatible choices.');
    }
    const matches = input.connections.map((value, index) => ({ value, index }))
        .filter(candidate => manualConnectionId(candidate.value) === edit.connectionId);
    if (matches.length !== 1)
        throw new Error(`Connection ${edit.connectionId} is missing or ambiguous. Inspect the current graph again.`);
    const before = structuredClone(object(matches[0].value));
    const staged = structuredClone(before);
    const collisionSwaps = [];
    const topology = string(before['topology']);
    if (!topology)
        throw new Error(`Connection ${edit.connectionId} has no network topology and cannot be edited safely.`);
    if (edit.cablePart) {
        const cableReplacement = stageManualCableReplacement(input, before, staged, edit.cablePart);
        return { connectionId: edit.connectionId, index: matches[0].index, before, staged, cableReplacement };
    }
    const ports = discoverManualPorts(input);
    const applyEndpoint = (side, patch) => {
        const choice = findPort(ports, patch, topology);
        if (side === 'source' && choice.configurationId !== string(before['sourceId'])) {
            throw new Error('The website only permits changing the port on the current source component.');
        }
        if (side === 'destination' && choice.code !== string(before['destinationPart'])) {
            throw new Error(`Destination ${choice.configurationId} is not the current ${string(before['destinationPart'])} component type.`);
        }
        const choiceKey = endpointKey(choice.configurationId, choice.name, choice.number);
        const occupiedBy = input.connections.map((value, index) => ({ row: object(value), index }))
            .filter(candidate => candidate.index !== matches[0].index)
            .flatMap(candidate => ['source', 'destination'].flatMap(occupiedSide => endpointKey(candidate.row[`${occupiedSide}Id`], candidate.row[`${occupiedSide}PortName`], candidate.row[`${occupiedSide}PortNumber`]) === choiceKey
            ? [{ ...candidate, occupiedSide }] : []));
        if (occupiedBy.length > 1) {
            throw new Error(`Endpoint ${choice.configurationId} ${choice.name} - ${choice.number} is occupied by multiple rows.`);
        }
        if (occupiedBy.length === 1) {
            const collision = occupiedBy[0];
            if (collisionSwaps.length > 0)
                throw new Error('Only one occupied-port swap can be performed per edit.');
            if (side !== 'destination') {
                throw new Error('Occupied-port swaps are verified only for destination ports.');
            }
            if (collision.occupiedSide !== side || choice.configurationId !== string(before[`${side}Id`])) {
                throw new Error('Only a captured same-side port swap on the current component is supported.');
            }
            const collisionTopology = string(collision.row['topology']);
            if (!collisionTopology)
                throw new Error('The conflicting connection has no network topology and cannot be swapped safely.');
            findPort(ports, {
                configurationId: string(before[`${side}Id`]),
                portName: string(before[`${side}PortName`]),
                portNumber: string(before[`${side}PortNumber`]),
            }, collisionTopology);
            const oldKey = endpointKey(before[`${side}Id`], before[`${side}PortName`], before[`${side}PortNumber`]);
            const oldOccupied = input.connections.map((value, index) => ({ row: object(value), index }))
                .filter(candidate => candidate.index !== matches[0].index && candidate.index !== collision.index)
                .some(candidate => [
                endpointKey(candidate.row['sourceId'], candidate.row['sourcePortName'], candidate.row['sourcePortNumber']),
                endpointKey(candidate.row['destinationId'], candidate.row['destinationPortName'], candidate.row['destinationPortNumber']),
            ].includes(oldKey));
            if (oldOccupied)
                throw new Error('The edited row\'s former endpoint is not free for the collision swap.');
            const swapped = structuredClone(collision.row);
            for (const suffix of ['Id', 'PortName', 'PortNumber', 'Location', 'Part']) {
                const key = `${side}${suffix}`;
                if (Object.hasOwn(before, key))
                    swapped[key] = structuredClone(before[key]);
                else
                    delete swapped[key];
            }
            swapped['type'] = 'MANUAL';
            collisionSwaps.push({ index: collision.index, connectionId: manualConnectionId(collision.row),
                before: structuredClone(collision.row), staged: swapped });
        }
        staged[`${side}Id`] = choice.configurationId;
        staged[`${side}PortName`] = choice.name;
        staged[`${side}PortNumber`] = choice.number;
        if (choice.location)
            staged[`${side}Location`] = choice.location;
        if (choice.code)
            staged[`${side}Part`] = choice.code;
    };
    if (edit.source)
        applyEndpoint('source', edit.source);
    if (edit.destination)
        applyEndpoint('destination', edit.destination);
    if (endpointKey(staged['sourceId'], staged['sourcePortName'], staged['sourcePortNumber']) ===
        endpointKey(staged['destinationId'], staged['destinationPortName'], staged['destinationPortNumber'])) {
        throw new Error('A connection cannot use the same physical port at both ends.');
    }
    const changed = ['sourceId', 'sourcePortName', 'sourcePortNumber', 'destinationId',
        'destinationPortName', 'destinationPortNumber'].some(key => string(staged[key]) !== string(before[key]));
    if (!changed)
        throw new Error('The requested endpoint edit does not change the connection.');
    staged['type'] = 'MANUAL';
    const endpointChanged = string(staged['sourceId']) !== string(before['sourceId']) ||
        string(staged['destinationId']) !== string(before['destinationId']);
    const distanceRequest = endpointChanged ? {
        floorPreference: structuredClone(input.floorPreference ?? {}),
        floorItems: structuredClone([...input.floorItems ?? []]),
        from: string(staged['sourceId']), to: string(staged['destinationId']), network: topology,
    } : undefined;
    return { connectionId: edit.connectionId, index: matches[0].index, before, staged,
        ...(distanceRequest ? { distanceRequest } : {}),
        ...(collisionSwaps.length > 0 ? { collisionSwaps } : {}) };
}
export function applyManualConnectionDistance(plan, value) {
    const distance = structuredClone(object(value));
    const totalDistance = number(distance['totalDistance']);
    if (Object.keys(distance).length === 0 || totalDistance === undefined || totalDistance < 0) {
        throw new Error('DCSC returned no non-negative numeric cable distance for the edited endpoints.');
    }
    const requested = plan.distanceRequest;
    if (requested) {
        const responseEndpoint = (side) => {
            const endpoint = distance[side];
            return typeof endpoint === 'string' ? endpoint : string(object(endpoint)['itemId'] ?? object(endpoint)['id']);
        };
        const from = responseEndpoint('from');
        const to = responseEndpoint('to');
        if (from && from !== requested.from)
            throw new Error(`DCSC calculated distance from unexpected endpoint ${from}.`);
        if (to && to !== requested.to)
            throw new Error(`DCSC calculated distance to unexpected endpoint ${to}.`);
        const network = string(distance['network'] ?? distance['topology']);
        if (network && network !== requested.network)
            throw new Error(`DCSC calculated distance for unexpected network ${network}.`);
    }
    return { ...plan, staged: { ...plan.staged, cableDistance: distance, totalDistance } };
}
export function commitManualConnectionEdit(connections, plan) {
    if (plan.index < 0 || plan.index >= connections.length || manualConnectionId(connections[plan.index]) !== plan.connectionId) {
        throw new Error('The connection graph changed before the edit could be committed. Inspect it again.');
    }
    const swaps = new Map();
    for (const collision of plan.collisionSwaps ?? []) {
        if (collision.index < 0 || collision.index >= connections.length || collision.index === plan.index ||
            manualConnectionId(connections[collision.index]) !== collision.connectionId || swaps.has(collision.index)) {
            throw new Error('The collision row changed before the edit could be committed. Inspect the graph again.');
        }
        swaps.set(collision.index, collision.staged);
    }
    return connections.map((value, index) => index === plan.index ? structuredClone(plan.staged)
        : swaps.has(index) ? structuredClone(swaps.get(index)) : structuredClone(value));
}
//# sourceMappingURL=manualCabling.js.map