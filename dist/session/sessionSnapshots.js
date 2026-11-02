import { isDeepStrictEqual } from 'node:util';
import { LocaleSchema, SolutionContextSchema, } from '../config/schema.js';
import { reconcileImportedCloneOwnership, } from '../domain/importCloneOwnership.js';
import { hardwareModeFamily } from '../domain/modeFamily.js';
import { detachedNestedNodeIds } from '../domain/nestedPhysical.js';
import { RECONCILIATION_HISTORY_STATE_KEY, RECONCILIATION_PROPOSALS_STATE_KEY, } from '../domain/reconciliation.js';
import { reduceConfiguration } from '../domain/reduce.js';
import { managedStorageComponentIds, storagePhysicalTemplateIds, } from '../domain/storagePreferences.js';
import { VALIDATION_JOBS_STATE_KEY } from '../domain/validationJobs.js';
import { buildIndex } from '../model/index.js';
import { errorMessage } from '../util/coerce.js';
import { newId } from './ids.js';
import { digestOf, sameValue } from './valueDigest.js';
export function firstNonempty(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
export function normalizeNewWorkspaceId(requested) {
    if (requested === undefined)
        return newId('ws');
    const id = requested.trim();
    if (!id || id !== requested)
        throw new Error('New workspace id must be non-empty and trimmed');
    return id;
}
export function buildEmptyWorkspace(id, input, now = Date.now()) {
    return {
        id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        locale: structuredClone(input.locale),
        solution: structuredClone(input.solution),
        validationMode: input.validationMode ?? 'guided',
        configurations: new Map(),
        rackArea: [],
        nonRackArea: [],
        serverState: {},
        rackSummaries: [],
        cables: [],
        floorItems: [],
        powerSelections: [],
        integrity: 'verified',
        integrityWarnings: [],
        history: { undo: [], redo: [] },
        revision: 1,
        createdAt: now,
        lastAccessAt: now,
        pricedAt: now,
    };
}
/** Adds a validated configuration to a detached transaction candidate only. */
export function stageConfiguration(workspace, input) {
    const session = buildConfigSession(input, workspace.id);
    assertBatchCanJoin(workspace, [session]);
    workspace.configurations.set(session.id, session);
    return session;
}
export function buildConfigSession(input, workspaceId, now = Date.now()) {
    const code = firstNonempty(input.reduced.lfoCode, input.raw.lfoCode, input.raw.sliceCtoCode, input.reduced.sliceCtoCode);
    if (!code)
        throw new Error('A non-empty product code is required');
    const configurationId = input.configurationId.trim();
    if (!configurationId)
        throw new Error('A non-empty configuration id is required');
    const canonicalRaw = structuredClone(input.raw);
    canonicalRaw.id = configurationId;
    return {
        id: newId('sess', code),
        workspaceId,
        ...(input.label !== undefined ? { label: input.label } : {}),
        locale: structuredClone(input.locale),
        solution: structuredClone(input.solution),
        product: {
            code,
            description: input.raw.description ?? '',
            type: input.raw.type ?? 'unknown',
        },
        mode: input.mode,
        validationMode: input.validationMode ?? 'guided',
        autoCorrect: input.validationMode === 'expert' ? false : input.autoCorrect ?? true,
        raw: canonicalRaw,
        configurationId,
        reduced: reduceConfiguration(canonicalRaw, configurationId, reducedMode(input.mode), input.solution.solutionMode),
        primed: input.primed,
        configurable: input.configurable ?? true,
        index: buildIndex(canonicalRaw),
        revision: 1,
        intents: [],
        snapshots: [],
        createdAt: now,
        lastAccessAt: now,
        pricedAt: now,
    };
}
export function assertBatchCanJoin(workspace, sessions) {
    const handles = new Set(workspace.configurations.keys());
    const canonicalIds = new Set([...workspace.configurations.values()].map((session) => session.configurationId));
    for (const session of sessions) {
        if (!isDeepStrictEqual(workspace.locale, session.locale)) {
            throw new Error(`Configuration ${session.id} locale does not match workspace ${workspace.id}`);
        }
        if (!isDeepStrictEqual(workspace.solution, session.solution)) {
            throw new Error(`Configuration ${session.id} solution does not match workspace ${workspace.id}`);
        }
        if (handles.has(session.id))
            throw new Error(`Duplicate configuration handle ${session.id}`);
        if (canonicalIds.has(session.configurationId)) {
            throw new Error(`Duplicate canonical configuration id ${session.configurationId}`);
        }
        handles.add(session.id);
        canonicalIds.add(session.configurationId);
    }
}
export function assertPreparedBatchPresent(workspace, sessions) {
    for (const session of sessions) {
        if (workspace.configurations.get(session.id) !== session) {
            throw new Error(`Prepare callback removed or replaced configuration ${session.id}`);
        }
    }
}
export function applyWorkspaceState(workspace, state) {
    if (!state)
        return;
    if ('label' in state)
        workspace.label = state.label;
    if (state.validationMode !== undefined)
        workspace.validationMode = state.validationMode;
    if (state.rackArea !== undefined)
        workspace.rackArea = structuredClone(state.rackArea);
    if (state.nonRackArea !== undefined)
        workspace.nonRackArea = structuredClone(state.nonRackArea);
    if (state.serverState !== undefined)
        workspace.serverState = structuredClone(state.serverState);
    if (state.rackSummaries !== undefined) {
        workspace.rackSummaries = structuredClone(state.rackSummaries);
    }
    if (state.cables !== undefined)
        workspace.cables = structuredClone(state.cables);
    if (state.floorItems !== undefined)
        workspace.floorItems = structuredClone(state.floorItems);
    if (state.powerSelections !== undefined) {
        workspace.powerSelections = structuredClone(state.powerSelections);
    }
    if (state.integrity !== undefined)
        workspace.integrity = state.integrity;
    if (state.integrityWarnings !== undefined) {
        workspace.integrityWarnings = structuredClone(state.integrityWarnings);
    }
    if ('recoveryData' in state)
        workspace.recoveryData = structuredClone(state.recoveryData);
}
/**
 * Each undo entry is a full workspace snapshot, so ten of them on a solution
 * with dozens of configurations reached ~400 MB and the persisted session file
 * could no longer be loaded. Keep the newest entries that fit the budget, and
 * always at least one so a single undo still works.
 */
export const WORKSPACE_HISTORY_BYTE_BUDGET = 48 * 1024 * 1024;
const historyEntryBytes = new WeakMap();
function valueBytes(value) {
    if (typeof value === 'string')
        return value.length;
    return typeof value === 'object' && value !== null ? digestOf(value).bytes : 0;
}
function entryBytes(entry) {
    let bytes = historyEntryBytes.get(entry);
    if (bytes === undefined) {
        bytes = 0;
        for (const [key, value] of Object.entries(entry.state)) {
            if (key === 'configurations' && Array.isArray(value)) {
                for (const configuration of value) {
                    bytes += valueBytes(configuration['raw']);
                }
            }
            else {
                bytes += valueBytes(value);
            }
        }
        historyEntryBytes.set(entry, bytes);
    }
    return bytes;
}
export function trimHistoryToBudget(entries, budget = WORKSPACE_HISTORY_BYTE_BUDGET) {
    let total = 0;
    let keepFrom = entries.length;
    while (keepFrom > 0) {
        const bytes = entryBytes(entries[keepFrom - 1]);
        if (keepFrom < entries.length && total + bytes > budget)
            break;
        total += bytes;
        keepFrom -= 1;
    }
    return entries.slice(keepFrom);
}
/** Entries share the workspace's immutable values; nothing is copied. */
export function captureWorkspaceHistoryState(workspace) {
    return {
        label: workspace.label,
        locale: workspace.locale,
        solution: workspace.solution,
        validationMode: workspace.validationMode,
        configurations: [...workspace.configurations.values()].map((session) => ({
            id: session.id,
            label: session.label,
            product: session.product,
            mode: session.mode,
            validationMode: session.validationMode,
            autoCorrect: session.autoCorrect,
            raw: session.raw,
            configurationId: session.configurationId,
            primed: session.primed,
            configurable: session.configurable,
            revision: session.revision,
            intents: session.intents,
            createdAt: session.createdAt,
            lastAccessAt: session.lastAccessAt,
            pricedAt: session.pricedAt,
        })),
        rackArea: workspace.rackArea,
        nonRackArea: workspace.nonRackArea,
        serverState: withoutOperationalMetadata(workspace.serverState),
        rackSummaries: workspace.rackSummaries,
        cables: workspace.cables,
        floorItems: workspace.floorItems,
        powerSelections: workspace.powerSelections,
        integrity: workspace.integrity,
        integrityWarnings: workspace.integrityWarnings,
        recoveryData: workspace.recoveryData,
        createdAt: workspace.createdAt,
        lastAccessAt: workspace.lastAccessAt,
        pricedAt: workspace.pricedAt,
    };
}
export function restoreWorkspaceHistory(workspace, direction) {
    const history = (workspace.history ??= { undo: [], redo: [] });
    const source = history[direction];
    const entry = source.pop();
    if (!entry)
        return false;
    const destination = direction === 'undo' ? history.redo : history.undo;
    destination.push({
        revision: workspace.revision,
        state: captureWorkspaceHistoryState(workspace),
    });
    if (destination.length > 10)
        destination.shift();
    applyWorkspaceHistoryState(workspace, entry.state);
    return true;
}
export function applyWorkspaceHistoryState(workspace, state) {
    const locale = LocaleSchema.safeParse(state['locale']);
    const solution = SolutionContextSchema.safeParse(state['solution']);
    const configurations = state['configurations'];
    if (!locale.success || !solution.success || !Array.isArray(configurations)) {
        throw new Error('Workspace history snapshot is malformed');
    }
    const restored = new Map();
    for (const value of configurations) {
        const session = restoreHistoryConfig(value, workspace.id, locale.data, solution.data, workspace.configurations);
        if (restored.has(session.id)) {
            throw new Error(`Workspace history contains duplicate handle ${session.id}`);
        }
        restored.set(session.id, session);
    }
    workspace.label = typeof state['label'] === 'string' ? state['label'] : undefined;
    workspace.locale = locale.data;
    workspace.solution = solution.data;
    workspace.validationMode = state['validationMode'] === 'expert' ? 'expert' : 'guided';
    workspace.configurations = restored;
    workspace.rackArea = arrayOrEmpty(state['rackArea']);
    workspace.nonRackArea = arrayOrEmpty(state['nonRackArea']);
    const currentServerState = workspace.serverState;
    workspace.serverState = recordOrEmpty(state['serverState']);
    preserveOperationalMetadata(currentServerState, workspace.serverState);
    workspace.rackSummaries = arrayOrEmpty(state['rackSummaries']);
    workspace.cables = arrayOrEmpty(state['cables']);
    workspace.floorItems = arrayOrEmpty(state['floorItems']);
    workspace.powerSelections = arrayOrEmpty(state['powerSelections']);
    workspace.integrity =
        state['integrity'] === 'legacy-unverified' || state['integrity'] === 'damaged'
            ? state['integrity']
            : 'verified';
    workspace.integrityWarnings = arrayOrEmpty(state['integrityWarnings']);
    workspace.recoveryData = Array.isArray(state['recoveryData'])
        ? structuredClone(state['recoveryData'])
        : undefined;
    validateKnownReferences(workspace);
}
function restoreHistoryConfig(value, workspaceId, locale, solution, current) {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Workspace history contains a malformed configuration');
    }
    const saved = value;
    const id = firstNonempty(saved['id']);
    const configurationId = firstNonempty(saved['configurationId']);
    const rawValue = saved['raw'];
    if (!id || !configurationId || typeof rawValue !== 'object' || rawValue === null) {
        throw new Error('Workspace history configuration has no usable identity/raw data');
    }
    const raw = structuredClone(rawValue);
    raw.id = configurationId;
    const product = recordOrEmpty(saved['product']);
    const code = firstNonempty(product['code'], raw.lfoCode, raw.sliceCtoCode, raw.code);
    if (!code)
        throw new Error(`Workspace history configuration ${id} has no product code`);
    const mode = isConfigMode(saved['mode']) ? saved['mode'] : 'cto';
    const revision = typeof saved['revision'] === 'number' ? saved['revision'] : 1;
    const snapshots = (current.get(id)?.snapshots ?? [])
        .filter((snapshot) => snapshot.revision < revision)
        .slice(-10);
    return {
        id,
        workspaceId,
        ...(typeof saved['label'] === 'string' ? { label: saved['label'] } : {}),
        locale: structuredClone(locale),
        solution: structuredClone(solution),
        product: {
            code,
            description: firstNonempty(product['description'], raw.description) ?? '',
            type: firstNonempty(product['type'], raw.type) ?? 'unknown',
        },
        mode,
        validationMode: saved['validationMode'] === 'expert' ? 'expert' : 'guided',
        autoCorrect: saved['validationMode'] !== 'expert' && saved['autoCorrect'] !== false,
        raw,
        configurationId,
        reduced: reduceConfiguration(raw, configurationId, reducedMode(mode), solution.solutionMode),
        primed: saved['primed'] === true,
        configurable: saved['configurable'] !== false,
        index: buildIndex(raw),
        revision,
        intents: arrayOrEmpty(saved['intents']),
        snapshots,
        createdAt: typeof saved['createdAt'] === 'number' ? saved['createdAt'] : Date.now(),
        lastAccessAt: typeof saved['lastAccessAt'] === 'number' ? saved['lastAccessAt'] : Date.now(),
        pricedAt: typeof saved['pricedAt'] === 'number' ? saved['pricedAt'] : Date.now(),
    };
}
export function restoreWorkspaceHistoryEnvelope(value, warnings = [], discarded = []) {
    if (value === undefined)
        return { undo: [], redo: [] };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        const warning = 'Malformed workspace history envelope was discarded';
        warnings.push(warning);
        recordDiscardedHistory(discarded, warning, value);
        return { undo: [], redo: [] };
    }
    const history = value;
    return {
        undo: restoreHistoryEntries(history['undo'], 'undo', warnings, discarded),
        redo: restoreHistoryEntries(history['redo'], 'redo', warnings, discarded),
    };
}
function restoreHistoryEntries(value, direction, warnings, discarded) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        const warning = `Malformed workspace ${direction} history was discarded`;
        warnings.push(warning);
        recordDiscardedHistory(discarded, warning, value);
        return [];
    }
    const restored = value.flatMap((candidate, index) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            const warning = `Malformed workspace ${direction} history entry ${index} was discarded`;
            warnings.push(warning);
            recordDiscardedHistory(discarded, warning, candidate);
            return [];
        }
        const entry = candidate;
        if (!Number.isSafeInteger(entry['revision']) || entry['revision'] < 0) {
            const warning = `Malformed workspace ${direction} history entry ${index} was discarded`;
            warnings.push(warning);
            recordDiscardedHistory(discarded, warning, candidate);
            return [];
        }
        if (typeof entry['state'] !== 'object' ||
            entry['state'] === null ||
            Array.isArray(entry['state'])) {
            const warning = `Malformed workspace ${direction} history entry ${index} was discarded`;
            warnings.push(warning);
            recordDiscardedHistory(discarded, warning, candidate);
            return [];
        }
        return [
            {
                revision: entry['revision'],
                state: entry['state'],
            },
        ];
    });
    if (restored.length > 10) {
        const overflow = restored.slice(0, -10);
        const warning = `Workspace ${direction} history exceeded 10 entries; ${overflow.length} oldest entries were discarded`;
        warnings.push(warning);
        for (const entry of overflow)
            recordDiscardedHistory(discarded, warning, entry);
    }
    return restored.slice(-10);
}
function cloneOwnershipRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value;
}
/** Returns a detached canonical graph; callers publish it only after every check succeeds. */
export function reconcileRestoredCloneOwnership(workspace) {
    const provenance = workspace.serverState.importCloneExpansion;
    if (provenance === undefined) {
        return {
            dependency: workspace.serverState.cloneDependency,
            colors: (workspace.serverState.cloneDependencyColor ?? {}),
            changed: false,
        };
    }
    if (!Array.isArray(provenance)) {
        throw new Error('Imported clone expansion provenance is malformed.');
    }
    const dependency = cloneOwnershipRecord(workspace.serverState.cloneDependency, 'Clone dependency');
    const colors = workspace.serverState.cloneDependencyColor === undefined
        ? {}
        : cloneOwnershipRecord(workspace.serverState.cloneDependencyColor, 'Clone dependency colors');
    const detached = detachedNestedNodeIds(workspace);
    const configurations = [...workspace.configurations.values()].map((session) => ({
        configurationId: session.configurationId,
        raw: session.raw,
        mode: session.mode,
        validationMode: session.validationMode,
        autoCorrect: session.autoCorrect,
        configurable: session.configurable,
    }));
    const activeConfigurationIds = new Set(configurations
        .map((configuration) => configuration.configurationId)
        .filter((configurationId) => !detached.has(configurationId)));
    const storageAliases = storagePhysicalTemplateIds(workspace);
    const storageRoots = new Set([
        ...managedStorageComponentIds(workspace.serverState),
        ...storageAliases.values(),
    ]);
    return reconcileImportedCloneOwnership({
        dependency,
        colors,
        provenance,
        activeConfigurationIds,
        storageRoots,
        storageAliases,
        configurations,
    });
}
/** Removes snapshots that are structurally plausible but cannot be restored safely. */
export function discardInvalidHistorySnapshots(workspace) {
    const warnings = [];
    let migrated = 0;
    const history = workspace.history;
    if (!history)
        return { warnings, migrated };
    for (const direction of ['undo', 'redo']) {
        history[direction] = history[direction].flatMap((entry, index) => {
            try {
                const probe = { ...workspace, configurations: new Map() };
                applyWorkspaceHistoryState(probe, entry.state);
                const migration = reconcileRestoredCloneOwnership(probe);
                if (!migration.changed)
                    return [entry];
                const next = structuredClone(entry);
                const nextServerState = cloneOwnershipRecord(next.state['serverState'], 'Workspace history clone state');
                nextServerState.cloneDependency = migration.dependency;
                nextServerState.cloneDependencyColor = migration.colors;
                next.state['serverState'] = nextServerState;
                migrated += 1;
                return [next];
            }
            catch (error) {
                const detail = errorMessage(error);
                const warning = `Unrestorable workspace ${direction} history entry ${index} was discarded: ${detail}`;
                warnings.push(warning);
                workspace.recoveryData = mergeRecoveryRecords(workspace.recoveryData ?? [], [
                    { kind: 'discarded-history', warning, record: structuredClone(entry) },
                ]);
                return [];
            }
        });
    }
    return { warnings, migrated };
}
function recordDiscardedHistory(target, warning, record) {
    const value = { kind: 'discarded-history', warning, record: structuredClone(record) };
    if (!target.some((candidate) => isDeepStrictEqual(candidate, value)))
        target.push(value);
}
export function mergeRecoveryRecords(existing, added) {
    const merged = structuredClone(existing);
    for (const value of added) {
        if (!merged.some((candidate) => isDeepStrictEqual(candidate, value))) {
            merged.push(structuredClone(value));
        }
    }
    return merged;
}
export function isConfigMode(value) {
    return (value === 'cto' ||
        value === 'lfo' ||
        value === 'lfo-as-cto' ||
        value === 'lfo-add-options');
}
/** Entries are immutable once recorded, so copies share them and only own the lists. */
export function copyHistory(history) {
    return history && { undo: [...history.undo], redo: [...history.redo] };
}
export function cloneWorkspace(workspace) {
    return {
        ...structuredClone({
            ...workspace,
            configurations: undefined,
            history: undefined,
        }),
        history: copyHistory(workspace.history),
        configurations: new Map([...workspace.configurations].map(([id, session]) => [id, cloneConfig(session)])),
    };
}
export function cloneConfig(session) {
    const clone = structuredClone({ ...session, index: undefined, snapshots: undefined });
    return { ...clone, snapshots: [...session.snapshots], index: buildIndex(clone.raw) };
}
function sameSnapshots(left, right) {
    return left.length === right.length && left.every((snapshot, position) => {
        const other = right[position];
        return snapshot === other ||
            (snapshot.revision === other.revision && sameValue(snapshot.raw, other.raw));
    });
}
export function sameConfigCanonicalState(left, right) {
    return left.label === right.label &&
        left.mode === right.mode &&
        left.validationMode === right.validationMode &&
        left.autoCorrect === right.autoCorrect &&
        left.configurationId === right.configurationId &&
        left.primed === right.primed &&
        left.configurable === right.configurable &&
        isDeepStrictEqual(left.locale, right.locale) &&
        isDeepStrictEqual(left.solution, right.solution) &&
        isDeepStrictEqual(left.product, right.product) &&
        isDeepStrictEqual(left.intents, right.intents) &&
        sameValue(left.raw, right.raw) &&
        sameSnapshots(left.snapshots, right.snapshots);
}
const DIGESTED_WORKSPACE_FIELDS = [
    'rackArea',
    'nonRackArea',
    'serverState',
    'rackSummaries',
    'cables',
    'floorItems',
    'powerSelections',
    'recoveryData',
];
export function sameWorkspaceCanonicalState(left, right) {
    if (!isDeepStrictEqual([...left.configurations.keys()], [...right.configurations.keys()])) {
        return false;
    }
    for (const [id, leftSession] of left.configurations) {
        const rightSession = right.configurations.get(id);
        if (!rightSession || !sameConfigCanonicalState(leftSession, rightSession))
            return false;
    }
    return left.label === right.label &&
        left.validationMode === right.validationMode &&
        left.integrity === right.integrity &&
        isDeepStrictEqual(left.locale, right.locale) &&
        isDeepStrictEqual(left.solution, right.solution) &&
        isDeepStrictEqual(left.integrityWarnings, right.integrityWarnings) &&
        DIGESTED_WORKSPACE_FIELDS.every((field) => sameValue(left[field], right[field]));
}
/** An unchanged draft value becomes the original's own object, so history entries keep sharing it. */
export function shareUnchangedValues(original, draft) {
    const share = (field) => {
        if (sameValue(original[field], draft[field]))
            draft[field] = original[field];
    };
    for (const field of DIGESTED_WORKSPACE_FIELDS)
        share(field);
}
/** The draft is discarded after publication, so its values move to the live session uncopied. */
export function assignConfig(target, source) {
    Object.assign(target, source);
}
export function preserveOperationalMetadata(source, target) {
    if (Object.hasOwn(source, VALIDATION_JOBS_STATE_KEY)) {
        target[VALIDATION_JOBS_STATE_KEY] = source[VALIDATION_JOBS_STATE_KEY];
    }
    else {
        delete target[VALIDATION_JOBS_STATE_KEY];
    }
    const sourceHistory = reconciliationHistory(source);
    const targetHistory = reconciliationHistory(target);
    const sourceAccepted = new Set(sourceHistory.map(reconciliationProposalId).filter(Boolean));
    const newlyAccepted = targetHistory.some((entry) => {
        const id = reconciliationProposalId(entry);
        return id !== '' && !sourceAccepted.has(id);
    });
    const mergedHistory = mergeReconciliationHistory(sourceHistory, targetHistory);
    if (mergedHistory.length > 0) {
        target[RECONCILIATION_HISTORY_STATE_KEY] = mergedHistory;
    }
    else {
        delete target[RECONCILIATION_HISTORY_STATE_KEY];
    }
    if (newlyAccepted) {
        delete target[RECONCILIATION_PROPOSALS_STATE_KEY];
    }
    else if (Object.hasOwn(source, RECONCILIATION_PROPOSALS_STATE_KEY)) {
        target[RECONCILIATION_PROPOSALS_STATE_KEY] = source[RECONCILIATION_PROPOSALS_STATE_KEY];
    }
    else {
        delete target[RECONCILIATION_PROPOSALS_STATE_KEY];
    }
}
export function withoutOperationalMetadata(state) {
    if (!Object.hasOwn(state, VALIDATION_JOBS_STATE_KEY) &&
        !Object.hasOwn(state, RECONCILIATION_PROPOSALS_STATE_KEY))
        return state;
    const copy = { ...state };
    delete copy[VALIDATION_JOBS_STATE_KEY];
    delete copy[RECONCILIATION_PROPOSALS_STATE_KEY];
    return copy;
}
export function saveReconciliationProposal(serverState, proposal) {
    const existing = Array.isArray(serverState[RECONCILIATION_PROPOSALS_STATE_KEY])
        ? serverState[RECONCILIATION_PROPOSALS_STATE_KEY]
            .filter(isStoredReconciliationProposal)
            .filter((value) => value.id !== proposal.id)
        : [];
    const proposals = [...existing, structuredClone(proposal)]
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .slice(-5);
    return {
        ...serverState,
        [RECONCILIATION_PROPOSALS_STATE_KEY]: proposals,
    };
}
export function normalizeReconciliationProposalMetadata(serverState, workspaceId) {
    if (!Object.hasOwn(serverState, RECONCILIATION_PROPOSALS_STATE_KEY))
        return serverState;
    const normalized = Array.isArray(serverState[RECONCILIATION_PROPOSALS_STATE_KEY])
        ? serverState[RECONCILIATION_PROPOSALS_STATE_KEY]
            .filter(isStoredReconciliationProposal)
            .filter((proposal) => proposal.workspaceId === workspaceId)
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
            .slice(-5)
            .map((proposal) => structuredClone(proposal))
        : [];
    const copy = structuredClone(serverState);
    if (normalized.length > 0)
        copy[RECONCILIATION_PROPOSALS_STATE_KEY] = normalized;
    else
        delete copy[RECONCILIATION_PROPOSALS_STATE_KEY];
    return copy;
}
function isStoredReconciliationProposal(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const proposal = value;
    return (proposal.version === 1 &&
        typeof proposal.id === 'string' &&
        proposal.id.trim().length > 0 &&
        typeof proposal.workspaceId === 'string' &&
        proposal.workspaceId.trim().length > 0 &&
        typeof proposal.sourceRevision === 'number' &&
        Number.isFinite(proposal.sourceRevision) &&
        typeof proposal.sourceHash === 'string' &&
        typeof proposal.targetHash === 'string' &&
        typeof proposal.createdAt === 'number' &&
        Number.isFinite(proposal.createdAt) &&
        typeof proposal.target === 'object' &&
        proposal.target !== null &&
        Array.isArray(proposal.diffs) &&
        Array.isArray(proposal.warnings));
}
function reconciliationHistory(state) {
    return Array.isArray(state[RECONCILIATION_HISTORY_STATE_KEY])
        ? state[RECONCILIATION_HISTORY_STATE_KEY]
        : [];
}
function reconciliationProposalId(value) {
    if (typeof value !== 'object' || value === null)
        return '';
    const id = value['proposalId'];
    return typeof id === 'string' ? id : '';
}
function mergeReconciliationHistory(source, target) {
    const merged = [];
    const seen = new Set();
    for (const entry of [...source, ...target]) {
        const id = reconciliationProposalId(entry);
        const key = id || JSON.stringify(entry);
        if (seen.has(key))
            continue;
        seen.add(key);
        merged.push(entry);
    }
    return merged.slice(-20);
}
export function arrayOrEmpty(value) {
    return Array.isArray(value) ? structuredClone(value) : [];
}
export function recordOrEmpty(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? structuredClone(value)
        : {};
}
export function markDamaged(workspace, warning, value, historyOnly = false) {
    if (!historyOnly)
        workspace.integrity = 'damaged';
    workspace.integrityWarnings.push(warning);
    workspace.recoveryData = [
        ...(workspace.recoveryData ?? []),
        historyOnly
            ? { kind: 'discarded-history', warning, record: structuredClone(value) }
            : structuredClone(value),
    ];
}
export function restoreSnapshots(value, mode, solutionMode, workspace, sessionId) {
    if (!Array.isArray(value))
        return [];
    const restored = [];
    for (const [position, candidate] of value.entries()) {
        if (typeof candidate !== 'object' || candidate === null) {
            markDamaged(workspace, `Snapshot ${position} for ${sessionId} was discarded`, candidate, true);
            continue;
        }
        const snapshot = candidate;
        const raw = snapshot['raw'];
        const revision = snapshot['revision'];
        if (typeof raw !== 'object' || raw === null || typeof revision !== 'number') {
            markDamaged(workspace, `Snapshot ${position} for ${sessionId} was discarded`, candidate, true);
            continue;
        }
        const canonicalRaw = structuredClone(raw);
        const configurationId = firstNonempty(canonicalRaw.id, sessionId);
        if (!configurationId) {
            markDamaged(workspace, `Snapshot ${position} for ${sessionId} has no identity`, candidate, true);
            continue;
        }
        restored.push({
            revision,
            raw: canonicalRaw,
            reduced: reduceConfiguration(canonicalRaw, configurationId, reducedMode(mode), solutionMode),
        });
    }
    return restored.slice(-10);
}
export function restoreObjectArray(value, name, discarded) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        discarded.push({ warning: `Malformed ${name} collection was quarantined`, record: value });
        return [];
    }
    const restored = [];
    for (const [position, candidate] of value.entries()) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            discarded.push({ warning: `Malformed ${name} record ${position} was quarantined`, record: candidate });
            continue;
        }
        restored.push(candidate);
    }
    return restored;
}
export function validateKnownReferences(workspace) {
    const configurationIds = new Set();
    for (const session of workspace.configurations.values()) {
        configurationIds.add(session.id);
        configurationIds.add(session.configurationId);
    }
    const rackIds = new Set();
    for (const item of workspace.rackArea) {
        if (typeof item['id'] === 'string')
            rackIds.add(item['id']);
    }
    const cableEndpointIds = new Set(configurationIds);
    try {
        for (const [physicalId, templateId] of storagePhysicalTemplateIds(workspace)) {
            if (configurationIds.has(templateId))
                cableEndpointIds.add(physicalId);
        }
    }
    catch (error) {
        markDamaged(workspace, `Cable endpoint ownership could not be resolved: ${String(error)}`, workspace.serverState.cloneDependency);
    }
    workspace.cables = workspace.cables.filter((cable) => {
        const valid = cableEndpointIds.has(cable.fromConfigId) && cableEndpointIds.has(cable.toConfigId);
        if (!valid)
            markDamaged(workspace, `Cable ${cable.id} has a missing endpoint`, cable);
        return valid;
    });
    workspace.floorItems = workspace.floorItems.filter((item) => {
        const valid = rackIds.has(item.rackId);
        if (!valid)
            markDamaged(workspace, `Floor item ${item.id} references missing rack ${item.rackId}`, item);
        return valid;
    });
    workspace.powerSelections = workspace.powerSelections.filter((item) => {
        const valid = rackIds.has(item.rackId);
        if (!valid)
            markDamaged(workspace, `Power selection references missing rack ${item.rackId}`, item);
        return valid;
    });
}
export function reducedMode(mode) {
    return hardwareModeFamily(mode);
}
//# sourceMappingURL=sessionSnapshots.js.map