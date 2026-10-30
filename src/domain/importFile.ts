import { readSavedBreakoutConnections } from './importCabling.js';
import { parseCfxml } from './import.js';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'node:zlib';

export function inspectXconfigSource(xml: string) {
  const data = new XMLParser({ ignoreAttributes: false }).parse(xml)?.CFXML?.CFData;
  const properties = Array.isArray(data?.ProprietaryInformation) ? data.ProprietaryInformation : [data?.ProprietaryInformation];
  const identifier: unknown = properties.find((p: { Name?: unknown; Value?: unknown } | undefined) => p?.Name === 'Configurator Identifier')?.Value;
  const isXconfig = typeof identifier === 'string' && /^XCONFIG[.]/i.test(identifier);
  if (!isXconfig) return { isXconfig: false, savedCabling: false, savedFloor: false };
  try {
    const blob = unzipSync(Buffer.from(String(data?.CSEBLOB ?? ''), 'base64'), { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8');
    const populated = (name: string) => new RegExp(`(?:^|\\n)${name}\\{\\s*[^\\s}]`).test(blob);
    return { isXconfig: true, savedCabling: populated('CABLES') || populated('USERP2PS'), savedFloor: populated('FLOOR') };
  } catch {
    return { isXconfig: true, savedCabling: false, savedFloor: false, sourceInspectionUnavailable: true };
  }
}

/** Excel is sent intact to Lenovo; its contents are never reconstructed locally. */
export function prepareImportFile(content: string | Uint8Array, fileName = 'configuration.xml') {
  const extension = /\.(xlsx|xls)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (extension) {
    if (typeof content === 'string') throw new Error('Excel imports require binary file content. Use filePath.');
    const bytes = Buffer.from(content);
    const signature = extension === 'xlsx' ? Buffer.from([0x50, 0x4b, 0x03, 0x04])
      : Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    if (!bytes.subarray(0, signature.length).equals(signature)) {
      throw new Error(`Invalid ${extension.toUpperCase()} file signature.`);
    }
    return { content: bytes, fileName, solutionMode: undefined, source: undefined,
      contentType: extension === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/vnd.ms-excel' };
  }
  const xml = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  const parsed = parseCfxml(xml);
  return { content: xml, fileName, solutionMode: parsed.solutionMode, contentType: 'text/xml', source: { ...inspectXconfigSource(xml), breakoutConnections: readSavedBreakoutConnections(xml) } };
}
