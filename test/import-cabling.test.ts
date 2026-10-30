import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readSavedBreakoutConnections, restoreSavedBreakoutConnections } from '../src/domain/importCabling.js';
const native = JSON.parse(readFileSync(new URL('./fixtures/parity/breakout-import-native.json', import.meta.url), 'utf8'));
const xml = `<CFXML><SectionData><NetworkingInformation>${native.networkingInformation}</NetworkingInformation></SectionData></CFXML>`;
it('restores saved branch shapes only after exact matching of imported identities', () => {
  const saved = readSavedBreakoutConnections(xml);
  expect(saved).toHaveLength(3);
  const payload = { networkingInformation: { autoConnectResults: structuredClone(native.importedRows) } };
  expect(payload.networkingInformation.autoConnectResults.filter((r: Record<string, unknown>) => r['cablePart'] === 'AV22').every((r: Record<string, unknown>) => r['divider'] === 1)).toBe(true);
  expect(restoreSavedBreakoutConnections(payload, saved)).toBe(3);
  expect(payload.networkingInformation.autoConnectResults.filter((r: Record<string, unknown>) => r['cablePart'] === 'AV22').every((r: Record<string, unknown>) => r['divider'] === 4 && r['category'] === 'BREAKOUT')).toBe(true);
  expect(payload.networkingInformation.autoConnectResults.slice(0, 2)).toEqual(native.importedRows.slice(0, 2));
});
it('rejects missing, changed or duplicate identities without partial recovery', () => {
  const saved = readSavedBreakoutConnections(xml);
  for (const rows of [native.importedRows.slice(0, -1), [...native.importedRows, native.importedRows[2]], native.importedRows.map((r: Record<string, unknown>, i: number) => i === 4 ? { ...r, cablePart: 'different' } : r)]) {
    const payload = { networkingInformation: { autoConnectResults: structuredClone(rows) } };
    const before = structuredClone(payload);
    expect(() => restoreSavedBreakoutConnections(payload, saved)).toThrow(/missing or ambiguous/);
    expect(payload).toEqual(before);
  }
});
it('leaves designs without saved networking unchanged', () => {
  expect(readSavedBreakoutConnections('<CFXML/>')).toEqual([]);
  expect(restoreSavedBreakoutConnections({}, [])).toBe(0);
});
