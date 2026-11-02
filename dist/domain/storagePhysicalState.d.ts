import type { RawConfiguration } from '../model/types.js';
import type { Obj } from '../util/coerce.js';
export interface StoragePhysicalWorkspace {
    serverState?: Obj;
    rackArea?: Obj[];
    nonRackArea?: Obj[];
}
/** The editable template and the server-derived placed product are separate records. */
export declare function storagePhysicalConfigurations(workspace: StoragePhysicalWorkspace, templateId: string, template: RawConfiguration): Array<{
    physicalId: string;
    raw: RawConfiguration;
}>;
