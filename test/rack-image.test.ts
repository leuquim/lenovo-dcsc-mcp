import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { renderRackImage } from '../src/domain/rackImage.js';

function png(url: string): Buffer {
  expect(url.startsWith('data:image/png;base64,')).toBe(true);
  return Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
}

function chunks(image: Buffer): Map<string, Buffer[]> {
  const result = new Map<string, Buffer[]>();
  let offset = 8;
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.toString('ascii', offset + 4, offset + 8);
    const values = result.get(type) ?? [];
    values.push(image.subarray(offset + 8, offset + 8 + length));
    result.set(type, values);
    offset += length + 12;
  }
  return result;
}

const workspace = {
  configurations: new Map([['server-handle', {
    configurationId: 'server-1', product: { description: 'ThinkSystem SR630 V3' },
  }]]),
  rackArea: [{
    id: 'rack-1', code: '7D6DCTO1WW', description: '42U Onyx Rack', size: 42,
    rackItems: [
      { id: 'server-1', code: '7D73CTO1WW', description: null, position: 1, size: 1 },
      { id: 'switch-1', code: '7D5FCTOFWW', description: 'SN2201', position: 40, size: 1 },
    ],
  }],
};

describe('rack report image', () => {
  it('encodes a deterministic valid RGBA PNG with physical labels and positions', () => {
    const first = png(renderRackImage(workspace));
    const second = png(renderRackImage(workspace));
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const parts = chunks(first);
    const header = parts.get('IHDR')![0]!;
    expect(header.readUInt32BE(0)).toBe(282);
    expect(header.readUInt32BE(4)).toBe(478);
    expect([...header.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    const description = parts.get('tEXt')![0]!.toString('latin1');
    expect(description).toContain('7D6DCTO1WW');
    expect(description).toContain('7D73CTO1WW');
    expect(description).toContain('ThinkSystem SR630 V3');
    expect(description).toContain('"position":1');
    expect(description).toContain('7D5FCTOFWW');
    expect(description).toContain('"position":40');

    const scanlines = inflateSync(Buffer.concat(parts.get('IDAT')!));
    expect(scanlines.length).toBe((282 * 4 + 1) * 478);
  });

  it('changes when a visible item label or U location changes', () => {
    const moved = structuredClone(workspace);
    moved.rackArea[0]!.rackItems[0]!.position = 2;
    expect(renderRackImage(moved)).not.toBe(renderRackImage(workspace));
    moved.rackArea[0]!.rackItems[0]!.position = 1;
    moved.rackArea[0]!.rackItems[0]!.description = 'Different server';
    expect(renderRackImage(moved)).not.toBe(renderRackImage(workspace));
  });

  it('lays out multiple racks without unbounded dimensions', () => {
    const url = renderRackImage({ rackArea: Array.from({ length: 16 }, (_, index) => ({
      id: `rack-${index}`, code: `R${index}`, size: 60, rackItems: [],
    })) });
    const header = chunks(png(url)).get('IHDR')![0]!;
    expect(header.readUInt32BE(0)).toBeLessThanOrEqual(4_096);
    expect(header.readUInt32BE(4)).toBeLessThanOrEqual(4_096);
    expect(() => renderRackImage({ rackArea: Array.from({ length: 17 }, () => ({ size: 42 })) }))
      .toThrow(/at most 16 racks/);
  });

  it('rejects invalid physical layouts instead of silently omitting them', () => {
    expect(() => renderRackImage({ rackArea: [] })).toThrow(/at least one rack/);
    expect(() => renderRackImage({ rackArea: [{ code: 'BAD', size: 42,
      rackItems: [{ code: 'TOO-HIGH', position: 42, size: 2 }] }] }))
      .toThrow(/invalid U position/);
  });
});
