import type { RawConfiguration, RawSection, RawSubTab } from '../model/types.js';
/** Outgoing selections are distinct from both the full catalog and MCP views. */
export interface WireResult {
    code: string;
    quantity: number;
    ctoCode?: string;
    type?: string;
    description?: string;
    optionCode?: string;
    storageWizardDerived?: boolean;
    [key: string]: unknown;
}
export interface WireSection {
    name: string;
    multipleSelectable?: boolean;
    type?: string;
    subTabTitle?: string;
    results: WireResult[];
    [key: string]: unknown;
}
/** Captured SPA selectableSectionSelector semantics, without mutating raw data. */
export declare function serializeSection(section: RawSection, subTab: RawSubTab, type?: string): WireSection[];
/**
 * Serialize a newly selected software group exactly as the SPA sends it before
 * auto-derive has regenerated the group's filter and HIPO results.
 *
 * A new group selection is deliberately different from serializeSection():
 * its request contains only the group anchor. The server response owns the
 * derived licence lines and filter selections that follow.
 */
export declare function serializeSoftwareGroupSelection(section: RawSection, subTab: RawSubTab, groupCode: string): WireSection;
export declare function serializeSections(raw: RawConfiguration): WireSection[];
export declare function nonemptyCode(...values: unknown[]): string;
