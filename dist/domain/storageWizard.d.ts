import type { RawConfiguration } from '../model/types.js';
import { type WireSection } from './dcscWire.js';
import { type Obj } from '../util/coerce.js';
export interface StorageWizardChange {
    optionId: string | null;
    feature?: {
        groupIndex: number;
        code: string;
        quantity: number;
    };
}
export declare function storageWizardOptions(raw: RawConfiguration): Obj[];
export declare function storageWizardOption(raw: RawConfiguration): Obj | null;
export declare function stageStorageWizardChange(raw: RawConfiguration, change: StorageWizardChange): RawConfiguration;
/** Native query builder emits selected wizard features outside Controller and Backplane. */
export declare function storageWizardSections(raw: RawConfiguration, sections: WireSection[], detectDriveChanges?: boolean): WireSection[];
/** SPA SECTIONS_FOR_HDD_FEATURES, also used by the no-HDD deselection guard. */
export declare function storageWizardDriveSelections(sections: WireSection[]): Array<{
    code: string;
    quantity: number;
}>;
/** Native RAID Type radio groups: 2212 and 5977 have the same clearing behavior. */
export declare function isStorageRaidModeChange(raw: RawConfiguration, code: string): boolean;
/** CTO buildQueryStorageWizard clearing; LFO requires fixed/preselected restoration. */
export declare function clearStorageRaidSections(raw: RawConfiguration, sections: WireSection[]): WireSection[];
