import type { RawConfiguration } from '../model/types.js';
import type { WireSection } from './dcscWire.js';
import { type Obj } from '../util/coerce.js';
export interface PciWizardChange {
    optionId: string;
    rowId?: string;
    enabled?: boolean;
    slotCodes?: string[];
}
/** Native initPciWizardOptions: retain catalog metadata and initialize UI selections. */
export declare function pciWizardOptions(raw: RawConfiguration): Obj[];
export declare function stagePciWizardChange(raw: RawConfiguration, change: PciWizardChange): {
    option: Obj;
    options: Obj[];
    operate?: 'add' | 'cancel';
};
/** Validation reallocates adapters; native UI retains slot/pricing metadata by lineNumber. */
export declare function acceptPciWizardValidation(option: Obj, response: unknown, operate?: 'add' | 'cancel'): Obj;
export declare function withPciWizardOption(raw: RawConfiguration, options: Obj[], option: Obj): RawConfiguration;
/** The SPA includes the physical-slot map on export, deliberately omitting it on derive. */
export declare function pciWizardWireFields(raw: RawConfiguration, purpose?: 'derive' | 'export'): Obj;
export declare function pciWizardSections(raw: RawConfiguration, sections: WireSection[]): WireSection[];
