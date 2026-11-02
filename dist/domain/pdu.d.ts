/**
 * PDU selection for rack cabinets.
 *
 * A rack added via dcsc_rack_add is launched as a full configuration. Its
 * Power tab carries PDU, RACK_POWERCABLE and LINECORD sections. Selecting a
 * PDU is the same operation as any other feature change: put it in the
 * reduced model and round-trip through /ctos/autoDerive. DCSC's response is
 * authoritative — quantity, price and any auto-pulled line cords come back
 * from the server.
 *
 * `/pdu/pduPreference?codes=` exists and is what the SPA uses for the power
 * preference panel, but for the rack cabinets we have tested it returns `{}`
 * anonymously. The configuration tree is the reliable catalogue. Placement
 * rules (`pduPlacementRules` on the rackArea object from /racks/customize)
 * describe sidewall bays; they constrain physical install, not which feature
 * codes may be ordered.
 */
import type { ConfigIndex } from '../model/index.js';
import type { RackObject } from './rack.js';
export interface PduOption {
    code: string;
    description: string;
    section: string;
    min: number;
    max: number;
    unitPrice?: number | undefined;
    selectedQty: number;
}
export interface PduPlacementRuleSummary {
    groupName: string;
    features: string[];
    /** Max units of this type the sidewall rules allow, when known. */
    maxQuantity?: number | undefined;
}
export interface PduCatalog {
    options: PduOption[];
    placementRules: PduPlacementRuleSummary[];
    totalCombinedSlots?: number | undefined;
}
/**
 * Lists orderable PDUs and related power options from the rack configuration
 * index, plus sidewall rules from the last customize response.
 */
export declare function listPduCatalog(opts: {
    index: ConfigIndex;
    rackObject?: RackObject | undefined;
}): PduCatalog;
/** Selected PDU / cord lines currently on the rack configuration. */
export declare function selectedPowerLines(index: ConfigIndex): Array<{
    code: string;
    description: string;
    section: string;
    quantity: number;
    unitPrice?: number | undefined;
}>;
/**
 * Resolves a requested code to the section name autoDerive needs.
 *
 * Callers often know only the feature code; the index carries the section.
 */
export declare function resolvePowerChange(index: ConfigIndex, code: string, quantity: number): {
    section: string;
    code: string;
    quantity: number;
};
