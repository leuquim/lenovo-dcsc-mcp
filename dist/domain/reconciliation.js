import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildExportGroups } from './exportGroups.js';
import { reduceConfiguration } from './reduce.js';
import { VALIDATION_JOBS_STATE_KEY } from './validationJobs.js';
import { assertConfigurationReconciliationAllowed, hasPhysicalState } from './workspaceIntegrity.js';
import { buildIndex } from '../model/index.js';
export const RECONCILIATION_HISTORY_STATE_KEY = 'reconciliationHistory';
/** Pending proposals are metadata and must not invalidate their own source hash. */
export const RECONCILIATION_PROPOSALS_STATE_KEY = 'reconciliationProposals';
export class ReconciliationConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReconciliationConflictError';
    }
}
/** Hashes the canonical source that must remain unchanged until acceptance. */
export function canonicalWorkspaceHash(workspace) {
    const serverState = structuredClone(workspace.serverState);
    delete serverState[VALIDATION_JOBS_STATE_KEY];
    delete serverState[RECONCILIATION_PROPOSALS_STATE_KEY];
    return sha256({
        id: workspace.id,
        label: workspace.label,
        locale: workspace.locale,
        solution: workspace.solution,
        validationMode: workspace.validationMode,
        integrity: workspace.integrity,
        integrityWarnings: workspace.integrityWarnings,
        recoveryData: workspace.recoveryData,
        racks: [...workspace.racks].sort(([left], [right]) => left.localeCompare(right)),
        rackArea: workspace.rackArea,
        nonRackArea: workspace.nonRackArea,
        serverState,
        rackSummaries: workspace.rackSummaries,
        cables: workspace.cables,
        floorItems: workspace.floorItems,
        powerSelections: workspace.powerSelections,
        configurations: [...workspace.configurations.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((session) => ({
            id: session.id,
            configurationId: session.configurationId,
            product: session.product,
            mode: session.mode,
            validationMode: session.validationMode,
            autoCorrect: session.autoCorrect,
            configurable: session.configurable,
            primed: session.primed,
            revision: session.revision,
            intents: session.intents,
            raw: session.raw,
        })),
    });
}
/** Builds a read-only, reviewable proposal from an accepted current derive. */
export function proposeLegacyReconciliation(workspace, derived, now = Date.now()) {
    assertConfigurationReconciliationAllowed(workspace);
    assertFiniteTimestamp(now, 'proposal timestamp');
    assertDerivedMatchesSource(workspace, derived);
    const derivedBySession = new Map(derived.configurations.map((item) => [item.sessionId, item]));
    const warnings = [];
    if (workspace.integrity === 'legacy-unverified') {
        for (const warning of workspace.integrityWarnings) {
            warnings.push({ code: 'legacy-integrity-warning', message: warning });
        }
    }
    if ((workspace.recoveryData?.length ?? 0) > 0) {
        warnings.push({
            code: 'recovery-data-retained',
            message: 'Quarantined recovery records remain available and are not repaired by configuration reconciliation.',
        });
    }
    const diffs = [...workspace.configurations.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((session) => {
        const candidate = derivedBySession.get(session.id);
        const diff = compareConfiguration(session, candidate.raw, workspace.locale.currency);
        collectIntentWarnings(workspace, session, candidate.raw, diff, warnings);
        return diff;
    });
    const target = {
        completedAt: derived.completedAt,
        country: derived.country,
        currency: derived.currency,
        solutionMode: derived.solutionMode,
        configurations: derived.configurations
            .map((item) => ({
            sessionId: item.sessionId,
            configurationId: item.configurationId,
            raw: structuredClone(item.raw),
        }))
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    };
    const targetHash = sha256(target);
    const id = `recon_${sha256({
        workspaceId: workspace.id,
        sourceRevision: workspace.revision,
        sourceHash: derived.sourceHash,
        targetHash,
        createdAt: now,
    }).slice(0, 20)}`;
    return {
        version: 1,
        id,
        workspaceId: workspace.id,
        sourceRevision: workspace.revision,
        sourceHash: derived.sourceHash,
        targetHash,
        createdAt: now,
        status: diffs.some((diff) => diff.changed) ? 'changes-proposed' : 'no-change',
        diffs,
        warnings: dedupeWarnings(warnings),
        target,
    };
}
/**
 * Applies an explicitly accepted proposal to a detached workspace value.
 * SessionStore.transact remains responsible for revision bumps and durability.
 */
export function applyReconciliationProposal(workspace, proposal, acceptance) {
    assertConfigurationReconciliationAllowed(workspace);
    if (acceptance.proposalId !== proposal.id) {
        throw new ReconciliationConflictError('Acceptance does not identify this reconciliation proposal.');
    }
    assertFiniteTimestamp(acceptance.acceptedAt, 'acceptance timestamp');
    if (proposal.version !== 1) {
        throw new ReconciliationConflictError(`Unsupported reconciliation proposal version ${String(proposal.version)}.`);
    }
    if (workspace.id !== proposal.workspaceId) {
        throw new ReconciliationConflictError('Reconciliation proposal belongs to a different workspace.');
    }
    if (workspace.revision !== proposal.sourceRevision) {
        throw new ReconciliationConflictError(`Reconciliation proposal is stale: expected workspace revision ${proposal.sourceRevision}, current ${workspace.revision}.`);
    }
    if (canonicalWorkspaceHash(workspace) !== proposal.sourceHash) {
        throw new ReconciliationConflictError('Reconciliation source state no longer matches the proposal.');
    }
    if (sha256(proposal.target) !== proposal.targetHash) {
        throw new ReconciliationConflictError('Reconciliation target state does not match its canonical hash.');
    }
    if (workspace.locale.country !== proposal.target.country ||
        workspace.locale.currency !== proposal.target.currency ||
        workspace.solution.solutionMode !== proposal.target.solutionMode) {
        throw new ReconciliationConflictError('Reconciliation target context does not match the workspace.');
    }
    const targetBySession = new Map(proposal.target.configurations.map((item) => [item.sessionId, item]));
    if (targetBySession.size !== workspace.configurations.size) {
        throw new ReconciliationConflictError('Reconciliation target configuration set has changed.');
    }
    const reconciled = cloneWorkspace(workspace);
    for (const session of reconciled.configurations.values()) {
        const target = targetBySession.get(session.id);
        if (!target || target.configurationId !== session.configurationId) {
            throw new ReconciliationConflictError(`Reconciliation target does not match configuration ${session.id}.`);
        }
        assertCompleteDerivedRaw(target.raw, session);
        const raw = structuredClone(target.raw);
        raw.id = session.configurationId;
        session.raw = raw;
        session.reduced = reduceConfiguration(raw, session.configurationId, session.mode === 'cto' ? 'cto' : 'lfo', reconciled.solution.solutionMode);
        session.index = buildIndex(raw);
        session.product = {
            code: productIdentity(raw) || session.product.code,
            description: raw.description ?? session.product.description,
            type: raw.type ?? session.product.type,
        };
        session.pricedAt = proposal.target.completedAt;
    }
    const priorHistory = Array.isArray(reconciled.serverState[RECONCILIATION_HISTORY_STATE_KEY])
        ? reconciled.serverState[RECONCILIATION_HISTORY_STATE_KEY]
        : [];
    const nextServerState = {
        ...reconciled.serverState,
        [RECONCILIATION_HISTORY_STATE_KEY]: [
            ...priorHistory,
            {
                proposalId: proposal.id,
                acceptedAt: acceptance.acceptedAt,
                sourceRevision: proposal.sourceRevision,
                sourceHash: proposal.sourceHash,
                targetHash: proposal.targetHash,
                changedConfigurations: proposal.diffs.filter((diff) => diff.changed).map((diff) => diff.sessionId),
                acknowledgedWarnings: proposal.warnings,
            },
        ].slice(-20),
    };
    // Every pending proposal is bound to the pre-acceptance revision and becomes
    // stale after this content change.
    delete nextServerState[RECONCILIATION_PROPOSALS_STATE_KEY];
    reconciled.serverState = nextServerState;
    const unverifiedLayout = workspace.integrity === 'legacy-unverified' && hasPhysicalState(workspace);
    reconciled.integrity = unverifiedLayout ? 'legacy-unverified' : 'verified';
    reconciled.integrityWarnings = unverifiedLayout
        ? [...new Set([...workspace.integrityWarnings,
                'Configurations were reconciled, but legacy physical layout, floor, power and cable state remains unverified. Re-import complete current CFXML before workspace export or manufacturing validation.'])]
        : [];
    reconciled.pricedAt = proposal.target.completedAt;
    return reconciled;
}
function assertDerivedMatchesSource(workspace, derived) {
    if (derived.workspaceId !== workspace.id)
        throw new Error('Derived state belongs to a different workspace.');
    if (derived.sourceRevision !== workspace.revision) {
        throw new Error(`Derived state is stale: expected workspace revision ${workspace.revision}, received ${derived.sourceRevision}.`);
    }
    const sourceHash = canonicalWorkspaceHash(workspace);
    if (derived.sourceHash !== sourceHash) {
        throw new Error('Derived state was not produced from the current canonical workspace source.');
    }
    if (derived.country !== workspace.locale.country ||
        derived.currency !== workspace.locale.currency ||
        derived.solutionMode !== workspace.solution.solutionMode) {
        throw new Error('Derived locale, currency, or solution mode does not match the workspace.');
    }
    assertFiniteTimestamp(derived.completedAt, 'derive completion timestamp');
    if (workspace.configurations.size === 0) {
        throw new Error('A workspace without configurations cannot be reconciled through configuration derive.');
    }
    if (derived.configurations.length !== workspace.configurations.size) {
        throw new Error('Derived state must contain every workspace configuration exactly once.');
    }
    const seen = new Set();
    for (const candidate of derived.configurations) {
        if (candidate.accepted !== true) {
            throw new Error(`Configuration ${candidate.sessionId} has no accepted derive result.`);
        }
        if (seen.has(candidate.sessionId)) {
            throw new Error(`Derived state contains duplicate configuration ${candidate.sessionId}.`);
        }
        seen.add(candidate.sessionId);
        const session = workspace.configurations.get(candidate.sessionId);
        if (!session || candidate.configurationId !== session.configurationId) {
            throw new Error(`Derived state configuration ${candidate.sessionId} does not match the workspace.`);
        }
        assertCompleteDerivedRaw(candidate.raw, session);
    }
}
function assertCompleteDerivedRaw(raw, session) {
    if (!Array.isArray(raw.tabs))
        throw new Error(`Derived configuration ${session.id} has no complete tabs array.`);
    if (!Array.isArray(raw.hipoDerivedItems)) {
        throw new Error(`Derived configuration ${session.id} has no complete associated-software array.`);
    }
    if (!Array.isArray(raw.hipoServiceCtoServices)) {
        throw new Error(`Derived configuration ${session.id} has no complete associated-service array.`);
    }
    if (!Array.isArray(raw.totalPrices)) {
        throw new Error(`Derived configuration ${session.id} has no complete price array.`);
    }
    if (!Object.hasOwn(raw, 'unitPrice') || !Object.hasOwn(raw, 'totalPrice')) {
        throw new Error(`Derived configuration ${session.id} has no complete price fields.`);
    }
    if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity) || raw.quantity <= 0) {
        throw new Error(`Derived configuration ${session.id} has no valid sales quantity.`);
    }
    const rawId = string(raw.id);
    if (rawId && rawId !== session.configurationId) {
        throw new Error(`Derived configuration ${session.id} has a mismatched canonical id.`);
    }
    const existingProduct = productIdentity(session.raw) || session.product.code;
    if (!existingProduct || productIdentity(raw) !== existingProduct) {
        throw new Error(`Derived configuration ${session.id} has a mismatched product identity.`);
    }
}
function compareConfiguration(session, targetRaw, currency) {
    const beforeSelections = selectionSnapshot(session.raw);
    const afterSelections = selectionSnapshot(targetRaw);
    const beforeBom = bomSnapshot(session.raw, session.configurationId, currency);
    const afterBom = bomSnapshot(targetRaw, session.configurationId, currency);
    const beforePricing = pricingSnapshot(session.raw, currency);
    const afterPricing = pricingSnapshot(targetRaw, currency);
    const selectionsChanged = !isDeepStrictEqual(beforeSelections, afterSelections);
    const bomChanged = !isDeepStrictEqual(beforeBom, afterBom);
    const pricingChanged = !isDeepStrictEqual(beforePricing, afterPricing);
    return {
        sessionId: session.id,
        configurationId: session.configurationId,
        productCode: session.product.code,
        changed: selectionsChanged || bomChanged || pricingChanged,
        selections: { changed: selectionsChanged, before: beforeSelections, after: afterSelections },
        bom: { changed: bomChanged, before: beforeBom, after: afterBom },
        pricing: { changed: pricingChanged, before: beforePricing, after: afterPricing },
    };
}
function selectionSnapshot(raw) {
    const lines = [];
    for (const tabValue of array(raw.tabs)) {
        const tab = object(tabValue);
        for (const subTabValue of array(tab['subTabs'])) {
            const subTab = object(subTabValue);
            for (const sectionValue of array(subTab['sections'])) {
                const section = object(sectionValue);
                for (const resultValue of array(section['results'])) {
                    const result = object(resultValue);
                    const code = string(result['code']);
                    if (!code)
                        continue;
                    lines.push({
                        path: {
                            tabType: string(tab['type']),
                            tabTitle: string(tab['title']),
                            subTab: string(subTab['title']),
                            source: string(subTab['source']),
                            section: string(section['name']) || string(section['title']),
                            sectionCode: string(section['code']),
                        },
                        code,
                        quantity: finiteNumber(result['quantity'], 1),
                        type: string(result['type']),
                        result: structuredClone(result),
                    });
                }
            }
        }
    }
    return lines.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}
function bomSnapshot(raw, configurationId, currency) {
    return {
        currency,
        products: structuredClone(buildExportGroups(raw, configurationId)[0]?.products ?? []),
        associatedSoftware: sortCanonical(array(raw.hipoDerivedItems)),
        associatedServices: sortCanonical(array(raw.hipoServiceCtoServices)),
    };
}
function pricingSnapshot(raw, currency) {
    return {
        currency,
        quantity: finiteNumber(raw.quantity, 1),
        unitPrice: nullableNumber(raw.unitPrice),
        totalPrice: nullableNumber(raw.totalPrice),
        totalPrices: structuredClone(array(raw.totalPrices)),
        priceNotAvailable: raw.priceNotAvailable === true,
    };
}
function collectIntentWarnings(workspace, session, targetRaw, diff, warnings) {
    if (workspace.integrity !== 'legacy-unverified')
        return;
    if (session.intents.length === 0) {
        warnings.push({
            code: 'missing-edit-intent',
            sessionId: session.id,
            message: `Configuration ${session.id} has no retained edit-intent history; reconciliation cannot infer omitted user choices.`,
        });
    }
    if (!Array.isArray(session.raw.hipoDerivedItems)) {
        warnings.push({
            code: 'omitted-software-field',
            sessionId: session.id,
            message: `Configuration ${session.id} omitted its associated-software field in legacy state. Current derived lines are a proposal, not proof of recovered intent.`,
        });
    }
    if (!Array.isArray(session.raw.hipoServiceCtoServices)) {
        warnings.push({
            code: 'omitted-service-field',
            sessionId: session.id,
            message: `Configuration ${session.id} omitted its associated-service field in legacy state. Current derived lines are a proposal, not proof of recovered intent.`,
        });
    }
    if (diff.changed) {
        const targetHasSoftware = array(targetRaw.hipoDerivedItems).length > 0;
        const targetHasServices = array(targetRaw.hipoServiceCtoServices).length > 0;
        warnings.push({
            code: 'catalog-or-intent-ambiguity',
            sessionId: session.id,
            message: `Configuration ${session.id} differs from the current successful derive` +
                `${targetHasSoftware || targetHasServices ? ' including associated products' : ''}. ` +
                'The comparison cannot distinguish legacy data loss from later catalog or rule changes; applying it is explicit acceptance of the shown current state.',
        });
    }
}
function cloneWorkspace(workspace) {
    const clone = structuredClone({ ...workspace, configurations: undefined, racks: undefined });
    return {
        ...clone,
        configurations: new Map([...workspace.configurations].map(([id, session]) => {
            const sessionClone = structuredClone({ ...session, index: undefined });
            return [id, { ...sessionClone, index: buildIndex(sessionClone.raw) }];
        })),
        racks: new Map([...workspace.racks].map(([id, rack]) => [id, structuredClone(rack)])),
    };
}
function productIdentity(raw) {
    return firstNonempty(raw.lfoCode, raw.sliceCtoCode, raw.ctoCode, raw.code);
}
function firstNonempty(...values) {
    for (const value of values)
        if (typeof value === 'string' && value.trim())
            return value.trim();
    return '';
}
function dedupeWarnings(warnings) {
    const seen = new Set();
    return warnings.filter((warning) => {
        const key = `${warning.code}\u0000${warning.sessionId ?? ''}\u0000${warning.message}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function assertFiniteTimestamp(value, label) {
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`Invalid ${label}.`);
}
function sha256(value) {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    const record = value;
    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(',')}}`;
}
function sortCanonical(values) {
    return structuredClone(values).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function string(value) {
    return typeof value === 'string' ? value : '';
}
function finiteNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function nullableNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
//# sourceMappingURL=reconciliation.js.map