import type { Obj } from '../util/coerce.js';
export interface RackImageWorkspace {
    rackArea: Obj[];
    configurations?: ReadonlyMap<string, {
        configurationId?: string | undefined;
        product?: {
            description?: string | undefined;
        } | undefined;
        raw?: Obj | undefined;
    }> | undefined;
}
/**
 * Renders the current physical rackArea as a deterministic PNG data URL.
 * DCSC requires this image form field before it emits the Rack Report sheet.
 */
export declare function renderRackImage(workspace: RackImageWorkspace): string;
