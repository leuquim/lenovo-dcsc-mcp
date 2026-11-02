import { type ConfigMode } from '../config/constants.js';
import type { hardwareEndpointFamily } from './modeFamily.js';
/** Derive the family from a mode with `hardwareEndpointFamily`; never compare modes inline. */
export type EndpointFamily = ReturnType<typeof hardwareEndpointFamily>;
export type AutoDerivePath = `/${EndpointFamily}/autoDerive`;
export type ExportZipPath = `/${EndpointFamily}/export_zip`;
export declare function autoDerivePath(family: EndpointFamily): AutoDerivePath;
export declare function exportZipPath(family: EndpointFamily): ExportZipPath;
export declare function racksCustomizePath(family: EndpointFamily): string;
export declare function errorCustomizeWithAutoDerivePath(family: EndpointFamily): string;
export declare function exportXlsPath(family: EndpointFamily): string;
/** Launch route for a product code; the launch mode picks the route, not only the family. */
export declare function launchPath(mode: ConfigMode, productCode: string): string;
/** The website sends controlExpressModal=false in the HPC mode and true otherwise. */
export declare function isExpressModalControl(solutionMode: string): boolean;
export declare function launchQuery(solutionMode: string, scope?: 'SW' | 'HW'): Record<string, string | boolean>;
export declare function rackLaunchPath(rackCode: string): string;
export declare function rackLaunchQuery(solutionMode: string): Record<string, string | boolean>;
/** CTO-family launch for service-only or generated products (no mode involved). */
export declare function ctoLaunchPath(productCode: string): string;
export declare function racksHardwarePath(family: EndpointFamily): string;
