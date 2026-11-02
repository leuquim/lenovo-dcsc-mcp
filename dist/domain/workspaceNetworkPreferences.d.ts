import type { FabricOptions, NetworkType } from './fabric.js';
import { type Obj } from '../util/coerce.js';
/** Current workspace choices include the SPA's imported cluster-preference form.
 * Native convertClusterPreference2NetworkType restores these fields before editing. */
export declare function workspaceNetworkTypes(fabric: FabricOptions, state: Obj): NetworkType[];
