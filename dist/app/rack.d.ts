import { type LayoutResult } from '../domain/rack.js';
import { type FloorPlacementResult, type FloorPreferenceChange } from '../domain/floor.js';
import { selectedPowerLines, type PduCatalog, type PduOption } from '../domain/pdu.js';
import { type RackedClonePlacement } from '../domain/physicalClone.js';
import { type NestedNodePlacement } from '../domain/nestedPhysical.js';
import { type RequestCtx } from '../http/request.js';
import type { ConfigSession, PduSelection } from '../model/session.js';
import { type ScaleOutPlan } from './serviceHelpers.js';
import type { Runtime } from './runtime.js';
/**
 * Sizes a cluster built from one designed node.
 *
 * Rack capacity is established empirically rather than by dividing U heights:
 * DCSC enforces per-product position rules (an SR680a V3 may only occupy U3
 * to U35 of a 42U cabinet), so the usable slot count is always lower than the
 * arithmetic suggests. Nodes are placed one at a time until DCSC refuses,
 * and that refusal is the answer.
 *
 * This sizes and prices the cluster; it does not materialise every node as a
 * separate configuration.
 */
export declare function scaleOut(rt: Runtime, opts: {
    sessionHandle: string;
    nodes: number;
    rackCode: string;
    ctx: RequestCtx;
}): Promise<ScaleOutPlan>;
/**
 * Adds a rack cabinet and returns DCSC's validated layout.
 *
 * A rack is a configurable product in its own right, not just a container:
 * it is launched as a configuration in the workspace so that it carries its
 * own price, PDUs and rails. Exports reference racks by configuration id, and
 * a rackArea entry pointing at an id with no matching configuration makes the
 * export endpoint fail with "Index 0 out of bounds for length 0".
 */
export declare function addRack(rt: Runtime, sessionHandle: string, rackCode: string, ctx: RequestCtx, expectedRevision?: number, containedConfiguration?: string): Promise<LayoutResult>;
/** Website Add Hardware on a rack: DCSC places the catalog product, then it is launched and customized as a configuration. */
export declare function addHardware(rt: Runtime, sessionHandle: string, opts: {
    rackId: string;
    productCode: string;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<LayoutResult>;
/** Website Change rack model: the new rack model replaces the old one and keeps its contents. */
export declare function changeRackModel(rt: Runtime, sessionHandle: string, opts: {
    rackId: string;
    rackCode: string;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<LayoutResult>;
/**
 * Places a configured product into a rack at a given U position.
 *
 * Omit `position` to let DCSC arrange it — the placement rules are per
 * product and per rack (a SR680a V3 cannot sit below U3 in a 42U cabinet),
 * so guessing a slot client-side mostly produces rejections.
 */
export declare function placeInRack(rt: Runtime, sessionHandle: string, opts: {
    rackId: string;
    sessionId: string;
    chassisId?: string | undefined;
    position?: number | undefined;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<LayoutResult & {
    nestedPlacement?: NestedNodePlacement & {
        session: string;
    };
}>;
type LayoutEditOptions = {
    action: 'unplace' | 'remove' | 'detach' | 'arrange';
    configurationId?: string | undefined;
    contents?: 'unplace' | 'delete' | undefined;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
};
/** Reconcile physical edits using the sequence captured for the affected shape. */
export declare function editLayout(rt: Runtime, handle: string, opts: LayoutEditOptions): Promise<LayoutResult>;
/**
 * Places a rack on the floor grid.
 *
 * Client-side only — see domain/floor.ts. Validates the rack exists in the
 * workspace and that the tile is free; does not invent DCSC validation.
 */
export declare function placeOnFloor(rt: Runtime, sessionHandle: string, rackId: string, x: number, y: number, expectedRevision?: number): Promise<FloorPlacementResult>;
/** Floor Preference modal: grid size and distances, stored as client-side workspace state. */
export declare function setFloorPreferences(rt: Runtime, sessionHandle: string, change: FloorPreferenceChange, expectedRevision?: number): Promise<Record<string, unknown>>;
/** Workspace Auto Arrange and COG Validation switches; every later layout request carries them. */
export declare function setLayoutControls(rt: Runtime, sessionHandle: string, controls: {
    autoArrange?: boolean | undefined;
    cogValidation?: boolean | undefined;
}, expectedRevision?: number): Promise<{
    autoArrange: boolean;
    cogValidation: boolean;
}>;
/** Website rack-item Color action: the colour travels on the rack item and its floor grid entry. */
export declare function setRackItemColor(rt: Runtime, sessionHandle: string, itemId: string, color: string, expectedRevision?: number): Promise<void>;
/** Lock an existing item or reserve an empty U using the website physical mutation. */
export declare function setRackLock(rt: Runtime, handle: string, opts: {
    target: {
        itemId: string;
    } | {
        rackId: string;
        position: number;
    };
    locked: boolean;
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    rackId: string;
    itemId?: string;
    position: number;
    locked: boolean;
    layout: LayoutResult;
}>;
/** The distinct website Copy action creates an independent item in the same rack. */
export declare function copyRackItem(rt: Runtime, handle: string, opts: {
    expectedRevision?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    source: ConfigSession;
    copy: ConfigSession;
    placement: RackedClonePlacement;
    nestedCopies: ConfigSession[];
}>;
/**
 * Copies an already-configured product N times inside the same workspace.
 *
 * A multi-node solution needs N configurations, not one with quantity N:
 * quantity extends the price and the export line but places a single item in
 * a rack. Rebuilding each node with launch + configure costs a round trip per
 * option per node and lets them drift apart silently, so the copy is made
 * locally from the source's own post-autoDerive tree.
 *
 * Each clone gets a fresh DCSC configuration id — placements, topologies and
 * cabling are all keyed by it, so sharing one would alias the nodes together.
 */
export declare function cloneConfiguration(rt: Runtime, opts: {
    sessionHandle: string;
    count: number;
    labelPrefix?: string | undefined;
    expectedRevision?: number | undefined;
    placement?: 'none' | 'same-rack' | undefined;
    ctx?: RequestCtx | undefined;
}): Promise<{
    source: ConfigSession;
    clones: ConfigSession[];
    placements?: RackedClonePlacement[];
    nestedConfigurations?: ConfigSession[];
}>;
/**
 * Selects a PDU / power cord on a rack via DCSC autoDerive.
 *
 * The accepted quantities and price come from the server response — we do
 * not store a local selection unless DCSC confirmed it.
 */
export declare function configurePdu(rt: Runtime, sessionHandle: string, rackId: string, opts: {
    expectedRevision?: number | undefined;
    pduCode?: string | undefined;
    cordCode?: string | undefined;
    quantity?: number | undefined;
    ctx: RequestCtx;
}): Promise<{
    rackId: string;
    rackSessionId: string;
    selection: PduSelection;
    selected: ReturnType<typeof selectedPowerLines>;
    totalPrice: number | null;
    catalog?: PduCatalog | undefined;
    /**
     * Whether the rack can actually be connected to facility power.
     *
     * A PDU with no LINECORD cannot reach the facility feed, and DCSC neither
     * requires one nor complains: the rack prices, validates and exports
     * happily while being unorderable. Jumper cords do not substitute — they
     * connect equipment to PDU outlets, not the PDU to the building.
     */
    powerReadiness?: {
        hasPdu: boolean;
        hasLineCord: boolean;
        complete: boolean;
        availableLineCords: PduOption[];
        warning?: string | undefined;
    } | undefined;
}>;
export {};
