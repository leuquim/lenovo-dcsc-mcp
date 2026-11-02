import { objectOrEmpty } from '../util/coerce.js';
/** A breakout's branch rows share one physical destination port and one cable. */
export function countNativePhysicalCables(connections) {
    const groups = new Map();
    const sources = new Set();
    for (const value of connections) {
        const row = objectOrEmpty(value);
        const source = JSON.stringify([row['sourceId'], row['sourcePortName'], row['sourcePortNumber']]);
        if (sources.has(source))
            throw new Error('Cable graph repeats a source port.');
        sources.add(source);
        const key = JSON.stringify([row['destinationId'], row['destinationPortName'], row['destinationPortNumber']]);
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
        const first = rows[0];
        const divider = first['divider'];
        if (!((first['category'] === 'P2P' && divider === 1) ||
            (first['category'] === 'BREAKOUT' && divider === 4)) || rows.length > Number(divider) ||
            rows.some(row => ['category', 'divider', 'network', 'topology', 'cablePart'].some(field => row[field] !== first[field]))) {
            throw new Error('Cable graph has an unsupported or inconsistent shared destination.');
        }
    }
    return groups.size;
}
//# sourceMappingURL=cableQuantity.js.map