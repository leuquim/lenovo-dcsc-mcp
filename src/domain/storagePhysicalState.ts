import type { RawConfiguration } from '../model/types.js';
import { storagePhysicalTemplateIds } from './storagePreferences.js';
import type { Obj } from '../util/coerce.js';

export interface StoragePhysicalWorkspace {
  serverState?: Obj;
  rackArea?: Obj[];
  nonRackArea?: Obj[];
}

/** The editable template and the server-derived placed product are separate records. */
export function storagePhysicalConfigurations(
  workspace: StoragePhysicalWorkspace,
  templateId: string,
  template: RawConfiguration,
): Array<{ physicalId: string; raw: RawConfiguration }> {
  const stored = workspace.serverState?.storagePhysicalConfigurations;
  const records = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Obj : {};
  return [...storagePhysicalTemplateIds(workspace)].filter(([, root]) => root === templateId)
    .map(([physicalId]) => {
      const value = records[physicalId];
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) ||
          (value as Obj).id !== templateId)) {
        throw new Error(`Invalid derived storage record for ${physicalId}. Recalculate the physical layout before using its price.`);
      }
      return { physicalId, raw: (value ?? template) as RawConfiguration };
    });
}
