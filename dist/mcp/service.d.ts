import { type StorageNetworkChanges } from '../domain/storagePreferences.js';
import { type ManualConnectionEdit } from '../domain/manualCabling.js';
import type { ConfigMode } from '../config/constants.js';
import type { Config, Locale, SolutionContext } from '../config/schema.js';
import { type Catalog } from '../domain/catalog.js';
import { type SolutionModeInfo } from '../domain/context.js';
import { type ExportFileType } from '../domain/reduce.js';
import { type ReconciliationProposal } from '../domain/reconciliation.js';
import { type LayoutResult, type RackCabinet } from '../domain/rack.js';
import { type FabricOptions } from '../domain/fabric.js';
import { type AggregatedPower, type PowerReport } from '../domain/power.js';
import { type WorkspaceNetworkSelection } from '../domain/networkPreferences.js';
import { type DetachedStorageComponent } from '../domain/storageComponentLifecycle.js';
import { type StorageNetworkInput } from '../domain/storagePreferences.js';
import { type AutoConnectResult, type AutoConnectSettingsPatch } from '../domain/cabling.js';
import { type AcceptedStoragePlacement } from '../domain/storagePlacement.js';
import { type FloorPlacementResult } from '../domain/floor.js';
import { selectedPowerLines, type PduCatalog, type PduOption } from '../domain/pdu.js';
import { type ValidationReport } from '../domain/validate.js';
import { type RackedClonePlacement } from '../domain/physicalClone.js';
import { type NestedNodePlacement } from '../domain/nestedPhysical.js';
import { type LocaleOption } from '../domain/locale.js';
import { type ServiceCategory } from '../domain/services-catalog.js';
import { DcscHttpClient, type RequestCtx } from '../http/request.js';
import { SessionStore, type ConfigSession, type CableLink, type PduSelection } from '../session/SessionStore.js';
interface LaunchOptions {
    expectedRevision?: number | undefined;
    productCode: string;
    mode: ConfigMode;
    solution: SolutionContext;
    ctx: RequestCtx;
    label?: string | undefined;
    workspaceId?: string | undefined;
}
/** A part DCSC could not carry across an import, as it reports it. */
export interface ImportPart {
    productCode: string;
    description?: string;
    quantity?: number;
}
export interface ImportDiagnostics {
    /** Parts in the file that DCSC could not resolve at all. */
    missingParts: ImportPart[];
    /** Parts dropped because of rule changes or withdrawal. */
    removedParts: ImportPart[];
    /** Parts DCSC substituted for a successor. */
    replacedParts: ImportPart[];
    /** DCSC flagged one or more parts as export-controlled. Informational. */
    eccnRestricted: boolean;
    warnings?: string[];
}
/** Sizing for a cluster built by replicating one designed node. */
export interface ScaleOutPlan {
    nodeCode: string;
    nodeDescription: string;
    nodeSizeU: number;
    nodeWeightKg: number;
    rackCode: string;
    rackSizeU: number;
    nodes: number;
    /** How many DCSC actually accepted per cabinet, not the arithmetic maximum. */
    nodesPerRack: number;
    racksNeeded: number;
    totalListPrice: number;
    currency: string;
    priceScope: 'configured-nodes-only';
    excludedCosts: string[];
    lastRackNodes: number;
    fullestRackNodes: number;
    lastRackWeightKg: number;
    fullestRackWeightKg: number;
    totalWeightKg: number;
    powerPerNode?: PowerReport;
    clusterPower?: AggregatedPower;
    powerPerRack?: AggregatedPower;
    lastRackPower?: AggregatedPower;
}
export interface ImportResult {
    workspaceId: string;
    sessions: ConfigSession[];
    diagnostics: ImportDiagnostics;
    standaloneKind?: 'software' | 'service';
}
export declare class DcscService {
    #private;
    readonly config: Config;
    readonly http: DcscHttpClient;
    readonly sessions: SessionStore;
    constructor(config: Config);
    /** Compatibility for unmigrated mutations; transactions persist before publication. */
    persist(): void;
    get locale(): Locale;
    /** Overrides the process locale for subsequent newCtx/launch calls. */
    setLocale(locale: Locale): void;
    /** A fresh request context with its own correlation id and request budget. */
    newCtx(overrides?: {
        locale?: Locale;
        solution?: SolutionContext;
    }): RequestCtx;
    solutionModes(ctx: RequestCtx): Promise<SolutionModeInfo[]>;
    /** Resolves the solution context, fetching modes if they are not cached. */
    resolveSolution(ctx: RequestCtx, preferred?: string): Promise<SolutionContext>;
    /**
     * Which solution modes' catalogs contain each of these product codes.
     *
     * DCSC resolves a product against the catalog of whichever mode it is asked
     * about, and launch does not enforce membership — so a model can launch and
     * price cleanly under a mode it is not in, then be rejected outright on
     * import. SR685a V3 (7DHCCTO1WW) is General Purpose only and behaves exactly
     * that way. Knowing where a model actually lives makes that visible up front
     * instead of three steps later.
     *
     * Costs at most one request per mode per day thanks to the catalog cache.
     */
    modesContaining(ctx: RequestCtx, codes: string[]): Promise<Map<string, string[]>>;
    blueprintAvailability(ctx: RequestCtx): Promise<{
        available: boolean;
        availableModes: string[];
        catalogCheckedAt: string;
        historicalVerification: {
            date: string;
            country: string;
            currency: string;
            listPrice: number;
        };
        availabilityNote: string;
        id: string;
        name: string;
        productCode: string;
        solutionMode: string;
        accelerator: string;
        cooling: "air" | "direct water";
        summary: string;
        verifiedListPriceUsd: number;
        verifiedOn: string;
        shipsWithout: string[];
        approxMaxKWPerNode?: number | undefined;
    }[]>;
    catalog(ctx: RequestCtx, solution: SolutionContext): Promise<Catalog>;
    /**
     * Launches a configuration and opens a session within a workspace.
     */
    launch(opts: LaunchOptions): Promise<ConfigSession>;
    /**
     * Applies selection changes and commits the reconciled result.
     */
    configure(session: ConfigSession, changes: Array<{
        section: string;
        code: string;
        quantity: number;
    }>, ctx: RequestCtx, expectedRevision?: number): Promise<ConfigSession>;
    assertTrustedWorkspace(handle: string): void;
    proposeReconciliation(handle: string, ctx: RequestCtx): Promise<ReconciliationProposal>;
    reconciliationProposal(handle: string, proposalId: string): ReconciliationProposal;
    acceptReconciliation(handle: string, proposalId: string): Promise<{
        workspace: string;
        revision: number;
        integrity: string;
    }>;
    /** Website controls apply consistently to the complete workspace. */
    setConfigurationControls(handle: string, opts: {
        validationMode?: 'guided' | 'expert' | undefined;
        autoCorrect?: boolean | undefined;
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        revision: number;
        validationMode: 'guided' | 'expert';
        autoCorrect: boolean;
    }>;
    /**
     * Sets how many identical units of this configuration are wanted.
     */
    setQuantity(session: ConfigSession, quantity: number, expectedRevision?: number): Promise<ConfigSession>;
    undo(session: ConfigSession, expectedRevision?: number): Promise<boolean>;
    closeSession(handle: string, expectedRevision?: number): Promise<boolean>;
    /** Rack cabinets available in the workspace's solution mode. */
    rackCabinets(ctx: RequestCtx, solution: SolutionContext, masterCode?: string, hardwareType?: 'rack' | 'chassis' | 'node'): Promise<RackCabinet[]>;
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
    scaleOut(opts: {
        sessionHandle: string;
        nodes: number;
        rackCode: string;
        ctx: RequestCtx;
    }): Promise<ScaleOutPlan>;
    /**
     * The fabric vocabulary: network topologies, node roles and storage switches.
     *
     * Cached for the same reason the catalog is — these lists change on Lenovo's
     * release cadence, not within a session.
     */
    fabricOptions(ctx: RequestCtx, solution: SolutionContext): Promise<FabricOptions>;
    /**
     * Adds a rack cabinet and returns DCSC's validated layout.
     *
     * A rack is a configurable product in its own right, not just a container:
     * it is launched as a configuration in the workspace so that it carries its
     * own price, PDUs and rails. Exports reference racks by configuration id, and
     * a rackArea entry pointing at an id with no matching configuration makes the
     * export endpoint fail with "Index 0 out of bounds for length 0".
     */
    addRack(sessionHandle: string, rackCode: string, ctx: RequestCtx, expectedRevision?: number): Promise<LayoutResult>;
    /**
     * Places a configured product into a rack at a given U position.
     *
     * Omit `position` to let DCSC arrange it — the placement rules are per
     * product and per rack (a SR680a V3 cannot sit below U3 in a 42U cabinet),
     * so guessing a slot client-side mostly produces rejections.
     */
    placeInRack(sessionHandle: string, opts: {
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
    /** Reconcile physical edits using the sequence captured for the affected shape. */
    editLayout(handle: string, opts: {
        action: 'unplace' | 'remove' | 'detach' | 'arrange';
        configurationId?: string | undefined;
        contents?: 'unplace' | 'delete' | undefined;
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<LayoutResult>;
    /**
     * Runs DCSC auto-connect and replaces the workspace cable list with the
     * server's connections. Manual port maps are not invented here.
     */
    runAutoConnect(sessionHandle: string, ctx: RequestCtx, expectedRevision?: number, settings?: AutoConnectSettingsPatch): Promise<AutoConnectResult>;
    inspectManualCabling(handle: string, expectedWorkspaceRevision?: number): {
        workspace: string;
        revision: number;
        report: import("../domain/manualCabling.js").ManualCablingCatalog;
    };
    editManualCabling(handle: string, edit: ManualConnectionEdit & {
        expectedRevision: number;
        ctx: RequestCtx;
    }): Promise<{
        configurationChange?: {
            session: string;
            configurationId: string;
            previousTotalPrice: number | null;
            totalPrice: number | null;
            priceDelta: number | null;
            currency: string;
            priceScope: "editable-configuration";
        };
        swappedConnections?: import("../domain/manualCabling.js").ManualConnectionView[];
        connection: import("../domain/manualCabling.js").ManualConnectionView;
        workspace: string;
        revision: number;
    }>;
    /** Local planning annotation; excluded from the authoritative export connection graph. */
    addManualCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>, expectedRevision?: number): Promise<CableLink>;
    /** @deprecated Use runAutoConnect or addManualCabling. */
    addCabling(sessionHandle: string, cable: Omit<CableLink, 'id'>): Promise<CableLink>;
    /**
     * Places a rack on the floor grid.
     *
     * Client-side only — see domain/floor.ts. Validates the rack exists in the
     * workspace and that the tile is free; does not invent DCSC validation.
     */
    placeOnFloor(sessionHandle: string, rackId: string, x: number, y: number, expectedRevision?: number): Promise<FloorPlacementResult>;
    /** Lock an existing item or reserve an empty U using the website physical mutation. */
    setRackLock(handle: string, opts: {
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
    copyRackItem(handle: string, opts: {
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<{
        source: ConfigSession;
        copy: ConfigSession;
        placement: RackedClonePlacement;
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
    cloneConfiguration(opts: {
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
    }>;
    pduCatalog(sessionHandle: string, rackId: string): {
        catalog: PduCatalog;
        rackSession: ConfigSession;
    };
    /**
     * Selects a PDU / power cord on a rack via DCSC autoDerive.
     *
     * The accepted quantities and price come from the server response — we do
     * not store a local selection unless DCSC confirmed it.
     */
    configurePdu(sessionHandle: string, rackId: string, opts: {
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
    /**
     * Imports a CFXML through DCSC's own import endpoint.
     *
     * This deliberately posts the file to /multiple/cfxml_import rather than
     * parsing it locally and re-launching each product code. Launch does not
     * enforce slice membership, so a local replay happily "imports" a CFXML that
     * the real DCSC rejects — a config whose declared solution mode does not
     * contain the model comes back from launch fully priced, while the genuine
     * import drops it as a missing part. Only the server can tell us that, so we
     * ask it, and surface whatever it reports.
     *
     * Whether a model imports at all is decided by the solution mode of *this
     * request*, not by the file: DCSC resolves each product against the mode's
     * catalog. The same CFXML for a General-Purpose-only model (SR685a V3, say)
     * imports cleanly under "General Purpose" and is rejected outright under
     * "HPC and AI - Systems". Callers who know better can override the mode.
     */
    importConfig(opts: {
        content: string;
        ctx: RequestCtx;
        mode?: ConfigMode;
        workspaceId?: string;
        fileName?: string;
        solutionMode?: string;
        expectedRevision?: number | undefined;
    }): Promise<ImportResult>;
    /**
     * Validates a configuration against DCSC's LMC validation endpoint.
     *
     * The SPA posts the export payload to /lmc_validation and receives a
     * manufacturing handoff (build entity + deep link). Local expansionMessages
     * from autoDerive are merged in so callers still see rule text that is
     * already on the tree.
     */
    validate(sessionHandle: string, ctx: RequestCtx, opts?: {
        deadlineMs?: number | undefined;
    }): Promise<ValidationReport & {
        jobId: string;
        payloadSha256: string;
        freshValidationRequired: boolean;
        sessionHandle: string;
        validatedRevision: number;
        stale: boolean;
        workspaceId?: string | undefined;
        headroom: Array<{
            configuration: string;
            productCode: string;
            constraints: unknown[];
            breached: string[];
        }>;
        source: 'lmc_validation';
        /** True when racks were present but omitted from the LMC payload (same gap as export). */
        rackDataOmitted: boolean;
        /** What the isValid verdict actually covers. Never claims more than was sent. */
        validatedScope: {
            scope: 'configuration' | 'workspace';
            configurations: number;
            racksInSolution: number;
            racksValidated: number;
            covers: string;
        };
        warning?: string | undefined;
    }>;
    /** Saved reports are inspectable without making another result request. */
    validationJobs(handle: string): {
        report: import("../domain/validate.js").LmcValidationResult;
        scopeWarning?: string;
        stale: boolean;
        isValid: boolean;
        currentStatus: import("../domain/validate.js").ValidationStatus;
        freshValidationRequired: boolean;
        version: 1;
        id: string;
        payloadSha256: string;
        validatedRevision: number;
        target?: {
            handle: string;
            scope: "configuration" | "workspace";
        } | undefined;
        mode: string;
        status: import("../domain/validate.js").ValidationStatus;
        observedStatus?: import("../domain/validate.js").ValidationStatus | undefined;
        terminal: boolean;
        descriptors: unknown[];
        startRaw?: unknown;
        resultRaw?: unknown;
        startedAt: number;
        descriptorReceivedAt?: number | undefined;
        resultRequestedAt?: number | undefined;
        resultReceivedAt?: number | undefined;
        completedAt?: number | undefined;
        error?: import("../domain/validate.js").ValidationRequestError | undefined;
        projection?: import("../domain/validationJobs.js").ValidationJobProjection | undefined;
    }[];
    listLocales(ctx: RequestCtx): Promise<LocaleOption[]>;
    /**
     * Resolves a country (and optional language) against /locales into a Locale.
     * Does not mutate server config; callers pass the result into newCtx/launch.
     */
    resolveLocale(ctx: RequestCtx, countryCode: string, languageCode?: string): Promise<Locale>;
    servicePortalCategories(ctx: RequestCtx, solution: SolutionContext): Promise<ServiceCategory | undefined>;
    /**
     * Applies a network topology shortName to a configuration and optionally
     * re-runs auto-connect so DCSC can recompute cabling for the fabric choice.
     */
    applyTopology(opts: {
        sessionHandle: string;
        topology: string;
        networkName?: string | undefined;
        connectorIds?: string[] | undefined;
        ports?: string[] | undefined;
        expectedRevision?: number | undefined;
        autoConnect?: boolean | undefined;
        ctx: RequestCtx;
    }): Promise<{
        session: string;
        topology: string;
        selectedTopologies: Record<string, unknown>;
        autoConnect?: AutoConnectResult | undefined;
    }>;
    /** The rack + Storage Network action installs physical instances of managed templates. */
    placeStorageNetwork(handle: string, opts: {
        name: string;
        rackId: string;
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        revision: number;
        storageName: string;
        placements: AcceptedStoragePlacement[];
        templates: Array<{
            session: string;
            configurationId: string;
            created: boolean;
        }>;
    }>;
    openStorageController(handle: string, opts: {
        name: string;
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<{
        controllerId: string;
        workspace: string;
        revision: number;
        storageName: string;
        session: string;
        created: boolean;
    }>;
    openStorageSwitch(handle: string, opts: {
        name: string;
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<{
        switchId: string;
        workspace: string;
        revision: number;
        storageName: string;
        session: string;
        created: boolean;
    }>;
    /** Applies the website's server-to-storage selection in full workspace context. */
    assignStorageNetwork(handle: string, opts: {
        networkName: string | null;
        expectedRevision?: number | undefined;
        autoConnect?: boolean | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        session: string;
        configurationId: string;
        revision: number;
        configurationRevision: number;
        selectedStorageNetwork: string;
        autoConnectRequired: boolean;
        connectionCount?: number;
        connectionGraphStale: boolean;
    }>;
    addStorageNetwork(handle: string, opts: {
        input: Omit<StorageNetworkInput, 'controllerId'> & {
            controllerId?: string | undefined;
        };
        expectedRevision?: number | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        revision: number;
        storageNetworkCount: number;
    }>;
    editStorageNetwork(handle: string, opts: {
        action: 'rename' | 'remove';
        name: string;
        newName?: string | undefined;
        clearAssignments?: boolean | undefined;
        expectedRevision?: number | undefined;
    }): Promise<{
        workspace: string;
        revision: number;
        storageNetworkCount: number;
        updatedAssignments: number;
        removedConfigurations: number;
    }>;
    reconfigureStorageNetwork(handle: string, opts: {
        name: string;
        changes: StorageNetworkChanges;
        expectedRevision: number;
        autoConnect?: boolean | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        revision: number;
        storageNetworkCount: number;
        connectionGraphStale: boolean;
        autoConnectRequired: boolean;
        connectionCount?: number;
        retainedComponents: Array<Omit<DetachedStorageComponent, 'physicalIds'> & {
            physicalCount: number;
        }>;
    }>;
    setNetworkPreferences(handle: string, opts: {
        selections: WorkspaceNetworkSelection[];
        expectedRevision?: number | undefined;
        autoConnect?: boolean | undefined;
        ctx: RequestCtx;
    }): Promise<{
        workspace: string;
        revision: number;
        selections: unknown[];
        connectionCount?: number;
        connectionGraphStale: boolean;
        autoConnectRequired: boolean;
    }>;
    diffSessions(sessionHandleA: string, sessionHandleB: string): {
        added: import("../model/diff.js").PartChange[];
        removed: import("../model/diff.js").PartChange[];
        replaced: import("../model/diff.js").Replacement[];
        quantityChanged: import("../model/diff.js").PartChange[];
        price: {
            before: number;
            after: number;
            delta: number;
            currency: string;
        };
        constraints: import("../model/project.js").Constraint[];
        autoChanges: number;
        sessionA: string;
        sessionB: string;
        productA: {
            code: string;
            description: string;
            type: string;
        };
        productB: {
            code: string;
            description: string;
            type: string;
        };
        currency: string;
    };
    /**
     * Streams the export ZIP to disk and returns where it landed.
     *
     * Scope follows the handle: a configuration id exports that configuration,
     * a workspace id exports the workspace. That distinction is load-bearing —
     * resolving a configuration id to its parent used to export every product in
     * the workspace, which both surprised the caller and walked into the rack
     * payload rejection below.
     *
     * Rack export uses the website's slim hierarchy plus independent physical
     * rackData. A failed full-workspace handoff is surfaced without dropping layout.
     */
    exportZip(sessionHandle: string, opts: {
        fileTypes: ExportFileType[];
        fileName: string;
        ctx: RequestCtx;
        scope?: 'auto' | 'configuration' | 'workspace' | undefined;
        /** Retained for compatibility; rack data is always included for workspace export. */
        attemptRackPayload?: boolean | undefined;
    }): Promise<{
        stream: NodeJS.ReadableStream;
        contentDisposition: string | undefined;
        rackDataOmitted: boolean;
        scope: 'configuration' | 'workspace';
        configurationsExported: number;
        manualPlanningLinksOmitted: number;
    }>;
    close(): Promise<void>;
}
export {};
