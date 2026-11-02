import type { ConfigMode } from '../config/constants.js';
import type { RawConfiguration } from '../model/types.js';
export type CloneDependency = Record<string, string[]>;
/** Read a persisted color owner and reject malformed present ownership. */
export declare function cloneColorMembers(value: unknown, root: string, options?: {
    allowEmpty?: boolean;
    allowRootless?: boolean;
}): string[] | undefined;
export declare function sameIdentitySet(left: readonly string[], right: readonly string[]): boolean;
/** Identifies a complete physical-only storage color group whose managed template is outside the group. */
export declare function exactStorageAliasRoot(members: readonly string[], storageAliases: ReadonlyMap<string, string>): string | undefined;
/**
 * Releases before the compressed-import dependency fix persisted the validated
 * clone expansion only as provenance. Repair exactly that known shape: every
 * member is still an active singleton, the retained native root color names
 * the same identities, and each member still equals a clone of the source.
 * Anything else may represent a later independent edit and fails closed.
 */
export declare function reconcileImportedCloneOwnership(opts: {
    dependency: CloneDependency;
    colors: Record<string, unknown>;
    provenance: unknown;
    activeConfigurationIds: ReadonlySet<string>;
    storageRoots: ReadonlySet<string>;
    storageAliases?: ReadonlyMap<string, string> | undefined;
    configurations: readonly {
        configurationId: string;
        raw: RawConfiguration;
        mode?: ConfigMode | undefined;
        validationMode?: 'guided' | 'expert' | undefined;
        autoCorrect?: boolean | undefined;
        configurable?: boolean | undefined;
    }[];
}): {
    dependency: CloneDependency;
    colors: Record<string, unknown>;
    changed: boolean;
};
