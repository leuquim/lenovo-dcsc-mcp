import type { RawConfiguration } from '../model/types.js';
/**
 * Clones one canonical DCSC configuration under a fresh configuration id.
 *
 * The configuration DTO uses `id` and `workspaceId` for the same per-product
 * identity. Some imported DTOs also retain an explicit `configurationId`.
 * Modern `selectedTopologies` is keyed by network name; older payloads wrapped
 * that map in one configuration-id key. Only that exact legacy key is renamed.
 * No recursive string replacement is safe because product metadata, connector
 * data, descriptions, and unknown server fields may legitimately contain the
 * old id as ordinary data.
 */
export declare function cloneConfigurationRaw(raw: RawConfiguration, oldId: string, newId: string): RawConfiguration;
