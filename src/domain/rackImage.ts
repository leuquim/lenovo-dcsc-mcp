import { deflateSync } from 'node:zlib';

type Obj = Record<string, unknown>;

export interface RackImageWorkspace {
  rackArea: Obj[];
  configurations?: ReadonlyMap<string, {
    configurationId?: string | undefined;
    product?: { description?: string | undefined } | undefined;
    raw?: Obj | undefined;
  }> | undefined;
}

const MAX_RACKS = 16;
const MAX_RACK_UNITS = 60;
const MAX_DIMENSION = 4_096;
const COLUMNS = 4;
const MARGIN = 12;
const PANEL_WIDTH = 258;
const PANEL_GAP = 12;
const HEADER_HEIGHT = 24;
const UNIT_HEIGHT = 10;
const FOOTER_HEIGHT = 10;
const RACK_GUTTER = 27;
const RACK_WIDTH = 219;

const WHITE = [255, 255, 255, 255] as const;
const INK = [32, 38, 46, 255] as const;
const GRID = [170, 177, 186, 255] as const;
const RACK_FILL = [246, 248, 250, 255] as const;
const ITEM_FILL = [78, 128, 190, 255] as const;

/**
 * Renders the current physical rackArea as a deterministic PNG data URL.
 * DCSC requires this image form field before it emits the Rack Report sheet.
 */
export function renderRackImage(workspace: RackImageWorkspace): string {
  const racks = workspace.rackArea;
  if (!Array.isArray(racks) || racks.length === 0) {
    throw new Error('Rack Report image requires at least one rack.');
  }
  if (racks.length > MAX_RACKS) {
    throw new Error(`Rack Report image supports at most ${MAX_RACKS} racks; received ${racks.length}.`);
  }

  const configurationLabels = new Map<string, string>();
  for (const configuration of workspace.configurations?.values() ?? []) {
    const id = text(configuration.configurationId) || text(configuration.raw?.['id']);
    const label = text(configuration.product?.description) || text(configuration.raw?.['description']);
    if (id && label) configurationLabels.set(id, label);
  }
  const models = racks.map((rack, index) => rackModel(rack, index, configurationLabels));
  const rowUnits: number[] = [];
  for (let row = 0; row < Math.ceil(models.length / COLUMNS); row += 1) {
    rowUnits.push(Math.max(...models.slice(row * COLUMNS, (row + 1) * COLUMNS).map((rack) => rack.units)));
  }
  const columns = Math.min(COLUMNS, models.length);
  const width = MARGIN * 2 + columns * PANEL_WIDTH + (columns - 1) * PANEL_GAP;
  const rowHeights = rowUnits.map((units) => HEADER_HEIGHT + units * UNIT_HEIGHT + FOOTER_HEIGHT);
  const height = MARGIN * 2 + rowHeights.reduce((sum, value) => sum + value, 0)
    + (rowHeights.length - 1) * PANEL_GAP;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Rack Report image would be ${width}x${height}; maximum dimension is ${MAX_DIMENSION}.`);
  }

  const image = new Raster(width, height, WHITE);
  let y = MARGIN;
  for (let row = 0; row < rowHeights.length; row += 1) {
    const rowRackHeight = rowUnits[row]! * UNIT_HEIGHT;
    for (let column = 0; column < COLUMNS; column += 1) {
      const model = models[row * COLUMNS + column];
      if (!model) break;
      const x = MARGIN + column * (PANEL_WIDTH + PANEL_GAP);
      drawRack(image, model, x, y, rowRackHeight);
    }
    y += rowHeights[row]! + PANEL_GAP;
  }

  const description = ascii(JSON.stringify(models.map((rack) => ({
    id: rack.id, code: rack.code, label: rack.label, units: rack.units,
    items: rack.items.map((item) => ({ code: item.code, label: item.label,
      position: item.position, size: item.size })),
  }))));
  return `data:image/png;base64,${encodePng(image, description).toString('base64')}`;
}

interface ItemModel {
  code: string;
  label: string;
  position: number;
  size: number;
}

interface RackModel {
  id: string;
  code: string;
  label: string;
  units: number;
  items: ItemModel[];
}

function rackModel(rack: Obj, index: number, configurationLabels: ReadonlyMap<string, string>): RackModel {
  const units = integer(rack['size']);
  if (units === undefined || units < 1 || units > MAX_RACK_UNITS) {
    throw new Error(`Rack ${index + 1} has invalid size ${String(rack['size'])}; expected 1-${MAX_RACK_UNITS} U.`);
  }
  const id = text(rack['id']) || `rack-${index + 1}`;
  const code = text(rack['code']) || text(rack['sliceCtoCode']) || 'RACK';
  const label = text(rack['description']) || text(rack['name']) || code;
  const rawItems = rack['rackItems'];
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new Error(`Rack ${code} has an invalid rackItems value.`);
  }
  const items = (rawItems ?? []).map((value, itemIndex) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Rack ${code} item ${itemIndex + 1} is not an object.`);
    }
    const item = value as Obj;
    const position = integer(item['position']);
    const size = integer(item['size']) ?? 1;
    const itemCode = text(item['code']) || text(item['sliceCtoCode']) || `ITEM-${itemIndex + 1}`;
    if (position === undefined || position < 1 || size < 1 || position + size - 1 > units) {
      throw new Error(`Rack ${code} item ${itemCode} has invalid U position ${String(item['position'])} and size ${size}.`);
    }
    const itemId = text(item['id']);
    return {
      code: itemCode,
      label: text(item['description']) || text(item['name']) || configurationLabels.get(itemId) || itemCode,
      position,
      size,
    };
  });
  return { id, code, label, units, items };
}

function drawRack(image: Raster, rack: RackModel, x: number, y: number, rowRackHeight: number): void {
  drawText(image, x + RACK_GUTTER, y + 2, `${rack.code} ${rack.label}`, INK, RACK_WIDTH);
  const rackTop = y + HEADER_HEIGHT + rowRackHeight - rack.units * UNIT_HEIGHT;
  const rackLeft = x + RACK_GUTTER;
  image.fill(rackLeft, rackTop, RACK_WIDTH, rack.units * UNIT_HEIGHT, RACK_FILL);
  image.stroke(rackLeft, rackTop, RACK_WIDTH, rack.units * UNIT_HEIGHT, INK);
  for (let unit = 1; unit <= rack.units; unit += 1) {
    const unitY = rackTop + (rack.units - unit) * UNIT_HEIGHT;
    image.line(rackLeft, unitY, rackLeft + RACK_WIDTH - 1, unitY, GRID);
    if (unit === 1 || unit === rack.units || unit % 2 === 0) {
      drawText(image, x, unitY + 2, String(unit), INK, RACK_GUTTER - 3);
    }
  }
  for (const item of rack.items) {
    const itemY = rackTop + (rack.units - (item.position + item.size - 1)) * UNIT_HEIGHT;
    const itemHeight = item.size * UNIT_HEIGHT;
    image.fill(rackLeft + 1, itemY + 1, RACK_WIDTH - 2, Math.max(1, itemHeight - 1), ITEM_FILL);
    image.stroke(rackLeft, itemY, RACK_WIDTH, itemHeight, INK);
    drawText(image, rackLeft + 4, itemY + Math.max(1, Math.floor((itemHeight - 7) / 2)),
      `${item.code} ${item.label}`, WHITE, RACK_WIDTH - 8);
  }
}

class Raster {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number, background: readonly number[]) {
    this.pixels = new Uint8Array(width * height * 4);
    this.fill(0, 0, width, height, background);
  }
  set(x: number, y: number, color: readonly number[]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.pixels[offset] = color[0] ?? 0;
    this.pixels[offset + 1] = color[1] ?? 0;
    this.pixels[offset + 2] = color[2] ?? 0;
    this.pixels[offset + 3] = color[3] ?? 255;
  }
  fill(x: number, y: number, width: number, height: number, color: readonly number[]): void {
    for (let py = Math.max(0, y); py < Math.min(this.height, y + height); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(this.width, x + width); px += 1) this.set(px, py, color);
    }
  }
  line(x1: number, y1: number, x2: number, y2: number, color: readonly number[]): void {
    if (y1 === y2) for (let x = x1; x <= x2; x += 1) this.set(x, y1, color);
    else if (x1 === x2) for (let y = y1; y <= y2; y += 1) this.set(x1, y, color);
  }
  stroke(x: number, y: number, width: number, height: number, color: readonly number[]): void {
    this.line(x, y, x + width - 1, y, color);
    this.line(x, y + height - 1, x + width - 1, y + height - 1, color);
    this.line(x, y, x, y + height - 1, color);
    this.line(x + width - 1, y, x + width - 1, y + height - 1, color);
  }
}

const FONT: Record<string, string[]> = {
  ' ': ['000','000','000','000','000','000','000'], '-': ['000','000','000','111','000','000','000'],
  '.': ['000','000','000','000','000','010','010'], ':': ['000','010','010','000','010','010','000'],
  '/': ['001','001','010','010','100','100','000'], '_': ['000','000','000','000','000','000','111'],
  '?': ['110','001','001','010','000','010','000'],
  '0':['111','101','101','101','101','101','111'], '1':['010','110','010','010','010','010','111'],
  '2':['110','001','001','111','100','100','111'], '3':['110','001','001','111','001','001','110'],
  '4':['101','101','101','111','001','001','001'], '5':['111','100','100','110','001','001','110'],
  '6':['011','100','100','111','101','101','111'], '7':['111','001','001','010','010','010','010'],
  '8':['111','101','101','111','101','101','111'], '9':['111','101','101','111','001','001','110'],
  A:['010','101','101','111','101','101','101'], B:['110','101','101','110','101','101','110'],
  C:['011','100','100','100','100','100','011'], D:['110','101','101','101','101','101','110'],
  E:['111','100','100','110','100','100','111'], F:['111','100','100','110','100','100','100'],
  G:['011','100','100','101','101','101','011'], H:['101','101','101','111','101','101','101'],
  I:['111','010','010','010','010','010','111'], J:['001','001','001','001','101','101','010'],
  K:['101','101','110','100','110','101','101'], L:['100','100','100','100','100','100','111'],
  M:['101','111','111','101','101','101','101'], N:['101','111','111','111','111','111','101'],
  O:['010','101','101','101','101','101','010'], P:['110','101','101','110','100','100','100'],
  Q:['010','101','101','101','111','011','001'], R:['110','101','101','110','110','101','101'],
  S:['011','100','100','010','001','001','110'], T:['111','010','010','010','010','010','010'],
  U:['101','101','101','101','101','101','111'], V:['101','101','101','101','101','101','010'],
  W:['101','101','101','101','111','111','101'], X:['101','101','010','010','010','101','101'],
  Y:['101','101','101','010','010','010','010'], Z:['111','001','001','010','100','100','111'],
};

function drawText(image: Raster, x: number, y: number, value: string, color: readonly number[], maxWidth: number): void {
  let cursor = x;
  for (const raw of ascii(value).toUpperCase()) {
    if (cursor + 3 > x + maxWidth) break;
    const glyph = FONT[raw] ?? FONT['?']!;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row]![column] === '1') image.set(cursor + column, y + row, color);
      }
    }
    cursor += 4;
  }
}

function encodePng(image: Raster, description: string): Buffer {
  const stride = image.width * 4;
  const scanlines = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const target = y * (stride + 1);
    scanlines[target] = 0;
    scanlines.set(image.pixels.subarray(y * stride, (y + 1) * stride), target + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`Description\0${description}`, 'latin1')),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?');
}
