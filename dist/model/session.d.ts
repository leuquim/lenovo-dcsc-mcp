import type { ConfigMode } from '../config/constants.js';
import type { Locale, SolutionContext } from '../config/schema.js';
import type { RackObject, RackSummary } from '../domain/rack.js';
import type { ReducedConfiguration } from '../domain/reduce.js';
import type { ConfigIndex } from './index.js';
import type { RawConfiguration } from './types.js';
export interface ConfigIntent {
    at: number;
    changes: Array<{
        section: string;
        code: string;
        quantity: number;
    }>;
}
export interface ConfigSession {
    id: string;
    workspaceId: string;
    label?: string | undefined;
    locale: Locale;
    solution: SolutionContext;
    product: {
        code: string;
        description: string;
        type: string;
    };
    mode: ConfigMode;
    validationMode: 'guided' | 'expert';
    /** Independent from guided/expert mode, matching the website checkbox. */
    autoCorrect: boolean;
    raw: RawConfiguration;
    configurationId: string;
    reduced: ReducedConfiguration;
    primed: boolean;
    /** False for preconfigured models: the tree has no sections to change. */
    configurable: boolean;
    index: ConfigIndex;
    revision: number;
    intents: ConfigIntent[];
    snapshots: Array<{
        revision: number;
        raw: RawConfiguration;
        reduced: ReducedConfiguration;
    }>;
    createdAt: number;
    lastAccessAt: number;
    pricedAt: number;
}
export interface CableLink {
    id: string;
    fromConfigId: string;
    fromPort: string;
    toConfigId: string;
    toPort: string;
    cableCode?: string;
    description?: string;
}
export interface FloorItem {
    id: string;
    rackId: string;
    x: number;
    y: number;
}
export interface PduSelection {
    rackId: string;
    pduCode?: string | undefined;
    cordCode?: string | undefined;
    voltage?: string | undefined;
}
export interface WorkspaceHistoryEntry {
    revision: number;
    /** JSON-safe canonical workspace state; derived configuration views are omitted. */
    state: Record<string, unknown>;
}
export interface WorkspaceHistory {
    undo: WorkspaceHistoryEntry[];
    redo: WorkspaceHistoryEntry[];
}
export interface WorkspaceSession {
    id: string;
    label?: string | undefined;
    locale: Locale;
    solution: SolutionContext;
    validationMode: 'guided' | 'expert';
    configurations: Map<string, ConfigSession>;
    /** DCSC's own rackArea objects, re-posted verbatim on every mutation. */
    rackArea: RackObject[];
    /** DCSC objects currently outside a physical rack. */
    nonRackArea: RackObject[];
    /** Lossless original import/export envelope and client-held workspace metadata. */
    serverState: Record<string, unknown>;
    /** Reduced view of the last layout DCSC validated. */
    rackSummaries: RackSummary[];
    cables: CableLink[];
    floorItems: FloorItem[];
    powerSelections: PduSelection[];
    integrity: 'verified' | 'legacy-unverified' | 'damaged';
    integrityWarnings: string[];
    recoveryData?: unknown[] | undefined;
    history?: WorkspaceHistory | undefined;
    revision: number;
    createdAt: number;
    lastAccessAt: number;
    pricedAt: number;
}
