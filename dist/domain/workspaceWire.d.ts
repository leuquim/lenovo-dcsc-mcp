import type { ConfigMode } from '../config/constants.js';
import type { Obj } from '../util/coerce.js';
/** Export hierarchy, distinct from the physical one-based rackData contract. */
export declare function buildItemHierarchy(item: Obj, rackIndex?: number): Obj;
/** Current SPA _buildStructure contract, captured with a rack and SR630 V3. */
export declare function buildRackHierarchy(rack: Obj, rackIndex?: number): Obj;
export declare function physicalRackData(rack: Obj): Obj;
/** A workspace request must use the hardware family represented by every configuration. */
export declare function workspaceHardwareMode(configurations: Iterable<{
    mode: ConfigMode;
}>): 'cto' | 'lfo';
