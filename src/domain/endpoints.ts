import type { ConfigMode } from '../config/constants.js';
import type { hardwareEndpointFamily } from './modeFamily.js';

/** Derive the family from a mode with `hardwareEndpointFamily`; never compare modes inline. */
export type EndpointFamily = ReturnType<typeof hardwareEndpointFamily>;

export type AutoDerivePath = `/${EndpointFamily}/autoDerive`;
export type ExportZipPath = `/${EndpointFamily}/export_zip`;

export function autoDerivePath(family: EndpointFamily): AutoDerivePath {
  return `/${family}/autoDerive`;
}

export function exportZipPath(family: EndpointFamily): ExportZipPath {
  return `/${family}/export_zip`;
}

export function racksCustomizePath(family: EndpointFamily): string {
  return `/${family}/racks/customize`;
}

export function errorCustomizeWithAutoDerivePath(family: EndpointFamily): string {
  return `/${family}/errorCustomizeWithAutoDerive`;
}

export function exportXlsPath(family: EndpointFamily, report: 'power' | 'group'): string {
  return `/${family}/${report}/export_xls`;
}

/** Launch route for a product code; the launch mode picks the route, not only the family. */
export function launchPath(mode: ConfigMode, productCode: string): string {
  const code = encodeURIComponent(productCode);
  switch (mode) {
    case 'lfo': return `/lfos/${code}/as_lfo_launch`;
    case 'lfo-as-cto': return `/lfos/${code}/as_cto_launch`;
    case 'lfo-add-options': return `/lfos/${code}/add_options_launch`;
    case 'cto': return `/ctos/${code}/launch`;
  }
}

/** CTO-family launch for service-only or generated products (no mode involved). */
export function ctoLaunchPath(productCode: string): string {
  return `/ctos/${encodeURIComponent(productCode)}/launch`;
}
