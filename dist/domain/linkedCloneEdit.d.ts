import type { RawConfiguration } from '../model/types.js';
export interface LinkedCloneGroup {
    /** The object key is the authoritative root; member order is server owned. */
    rootId: string;
    memberIds: string[];
    linked: boolean;
}
/**
 * Resolves the one clone group containing an edited configuration.
 *
 * DCSC does not require the root to be the first member. Preserve the accepted
 * array order because the SPA forwards it as `customizingIds`; use `rootId`
 * separately wherever root identity matters.
 */
export declare function resolveLinkedCloneGroup(value: unknown, configurationIds: readonly string[], initiatingId: string): LinkedCloneGroup;
/**
 * Expands DCSC's single authoritative GP clone response to its explicit
 * `updateConfigurationIds` targets. The response list is treated as an exact
 * set while the accepted dependency order controls the returned projections.
 */
export declare function projectLinkedCloneResponse(response: RawConfiguration, group: LinkedCloneGroup): RawConfiguration[];
/** Native HPC applies repeated shared-root records in response order. */
export declare function projectHpcLinkedResponses(responses: RawConfiguration[], current: RawConfiguration[], dependency: unknown, requiredRoot: string, allowedRoots: ReadonlySet<string>, rootOnlyDependentRoots?: ReadonlySet<string>): RawConfiguration[];
