import type { ConfigMode } from '../config/constants.js';
/**
 * DCSC keeps the user-facing launch mode and the downstream wire family
 * separate. A preconfigured product launched "as CTO" retains that display
 * mode, but customization, workspace validation and export use CTO routes and
 * CTO payload semantics.
 */
export declare function hardwareModeFamily(mode: ConfigMode): 'cto' | 'lfo';
export declare function hardwareEndpointFamily(mode: ConfigMode): 'ctos' | 'lfos';
export declare function usesCtoWire(mode: ConfigMode): boolean;
