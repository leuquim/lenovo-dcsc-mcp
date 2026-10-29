import type { FabricOptions, NetworkType } from './fabric.js';
type Obj = Record<string, unknown>;
/** Current workspace choices include the SPA's imported cluster-preference form.
 * Native convertClusterPreference2NetworkType restores these fields before editing. */
export declare function workspaceNetworkTypes(fabric: FabricOptions, state: Obj): NetworkType[];
export {};
