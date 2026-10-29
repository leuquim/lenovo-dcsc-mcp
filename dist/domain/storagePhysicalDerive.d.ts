import type { RawConfiguration } from '../model/types.js';
import { type RackObject } from './rack.js';
export interface StoragePhysicalDeriveSplit {
    /** Partial ordinary/editable configuration response, safe to merge by configuration id. */
    configurations: RawConfiguration[];
    /**
     * Physical derived variants keyed by physical alias identity. The raw value deliberately keeps
     * DCSC's managed-template `id`; the object key supplies the physical identity and preserves the
     * distinction between an editable template and its rack-context derived result.
     */
    physicalConfigurations: Record<string, RawConfiguration>;
}
/**
 * Refreshes a placed storage alias from its rack-context derived raw while retaining envelope,
 * placement and future physical metadata. `response` is the enclosing auto-derive response; its
 * placement results supply the installations that DCSC adds before Back to Workspace.
 */
export declare function refreshStoragePhysicalFeatures(physical: RackObject, editableTemplate: RawConfiguration, response: unknown): RackObject;
/**
 * Separates `/ctos/autoDerive` configuration patches from managed-storage physical variants.
 *
 * DCSC uses the managed template id for both response kinds. An editable-template result targets
 * the template itself; a physical result targets one or more physical aliases through
 * `updateConfigurationIds`. Physical raws remain byte-for-byte response objects and are keyed by
 * alias rather than rewritten to pretend that each alias is an editable configuration.
 */
export declare function splitStoragePhysicalDerive(current: readonly RawConfiguration[], response: unknown, aliases: ReadonlyMap<string, string>): StoragePhysicalDeriveSplit;
