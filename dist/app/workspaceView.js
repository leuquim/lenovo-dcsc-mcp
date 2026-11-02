import { projectSummary } from '../model/project.js';
import { projectWorkspaceIntegrity, projectWorkspaceLayout, projectWorkspacePage, projectWorkspaceSummary, } from '../model/workspaceProjection.js';
import { unplacedManagedStorageComponentIds } from '../domain/storagePreferences.js';
import { assertWorkspaceRevision } from './serviceHelpers.js';
import { basketView, presentBaskets } from './standalone.js';
const TOOL = 'dcsc_workspace_get';
export function requireConfigSession(rt, id) {
    const resolved = rt.sessions.resolveHandle(id);
    if (!resolved) {
        throw new Error(`No such configuration session: ${id}. Use dcsc_session_list to see open sessions, or dcsc_launch to start one.`);
    }
    if (resolved.kind === 'configuration')
        return resolved.session;
    const sessions = [...resolved.workspace.configurations.values()];
    if (sessions.length === 1)
        return sessions[0];
    throw new Error(`Workspace ${id} contains ${sessions.length} configurations, so a configuration target is ambiguous. ` +
        `Pass one configuration session ID: ${sessions.map((session) => session.id).join(', ')}.`);
}
/** The workspace owning a configuration or workspace handle. */
export function requireWorkspaceOf(rt, handle) {
    const resolved = rt.sessions.resolveHandle(handle);
    if (!resolved) {
        throw new Error(`No such session or workspace: ${handle}. Use dcsc_session_list to see open sessions.`);
    }
    if (!resolved.workspace)
        throw new Error(`Configuration ${handle} is not attached to an open workspace.`);
    return resolved.workspace;
}
/** A configuration's or workspace's compact summary, or the physical layout, with revision-bound detail pages. */
export function inspectWorkspace(rt, request) {
    const resolved = rt.sessions.resolveHandle(request.session);
    if (!resolved) {
        throw new Error(`No such session or workspace: ${request.session}. Use dcsc_session_list to see open sessions.`);
    }
    const workspace = requireWorkspaceOf(rt, request.session);
    if (request.expectedRevision !== undefined && request.expectedRevision !== workspace.revision) {
        throw new Error(`Workspace ${workspace.id} changed from revision ${request.expectedRevision} to ${workspace.revision}. ` +
            `Restart ${TOOL} without path before following new continuations.`);
    }
    const continuation = {
        tool: TOOL,
        arguments: { session: workspace.id, view: request.view, expectedRevision: workspace.revision },
    };
    if (request.path !== undefined) {
        if (request.expectedRevision === undefined) {
            throw new Error(`expectedRevision is required for detail pages. Call ${TOOL} without path and follow its continuation.`);
        }
        return projectWorkspacePage(workspace, {
            ...continuation, path: request.path, offset: request.offset, limit: request.limit,
        });
    }
    if (request.view === 'layout') {
        return { session: workspace.id, revision: workspace.revision, ...projectWorkspaceLayout(workspace, continuation) };
    }
    if (resolved.kind === 'workspace' && workspace.configurations.size === 0) {
        const kind = workspace.serverState.standaloneServiceState ? 'service'
            : workspace.serverState.standaloneSoftwareState ? 'software'
                : workspace.serverState.standaloneHardwareState ? 'hardware' : 'empty';
        return {
            session: workspace.id, revision: workspace.revision, kind, configurations: [],
            ...projectWorkspaceIntegrity(workspace, continuation),
            currency: workspace.locale.currency, country: workspace.locale.country,
            ...(kind !== 'empty' ? { next: { tool: TOOL, arguments: { session: workspace.id, view: 'baskets' } } } : {}),
        };
    }
    if (resolved.kind === 'workspace' &&
        (workspace.configurations.size > 1 || workspace.serverState.standaloneSoftwareState ||
            workspace.serverState.standaloneHardwareState ||
            unplacedManagedStorageComponentIds(workspace).size > 0)) {
        return { session: workspace.id, revision: workspace.revision, ...projectWorkspaceSummary(workspace, continuation) };
    }
    const session = requireConfigSession(rt, request.session);
    return {
        ...projectSummary({
            sessionId: session.id,
            revision: workspace.revision,
            raw: session.raw,
            index: session.index,
            currency: session.locale.currency,
            country: session.locale.country,
            pricedAt: session.pricedAt,
        }),
        workspace: workspace.id,
        ...projectWorkspaceIntegrity(workspace, continuation),
        validationMode: session.validationMode,
        autoCorrect: session.autoCorrect,
        mode: session.mode,
        primed: session.primed,
        configurable: session.configurable,
        ...(session.primed
            ? {}
            : !session.configurable
                ? {
                    note: 'Preconfigured model with no configurable sections: there is nothing to prime and ' +
                        'dcsc_configure does not apply. Browsing, pricing and export all work.',
                }
                : session.mode === 'lfo'
                    ? {
                        note: 'DCSC rejects the priming body on /lfos/autoDerive for this model, so ' +
                            'dcsc_configure will NOT work in "lfo" mode. Browsing, pricing and export do work. ' +
                            'To change anything, relaunch the same code with mode "lfo-as-cto": that returns ' +
                            'a configurable tree and primes correctly (note it prices the CTO base, not the ' +
                            'preconfigured bundle).',
                    }
                    : {
                        warning: 'This configuration could not be primed, so dcsc_configure may fail. ' +
                            'Browsing, pricing and export still work.',
                    }),
    };
}
/** Undo and redo depth of the workspace, so callers know whether dcsc_undo can act. */
export function inspectHistory(rt, handle) {
    const workspace = requireWorkspaceOf(rt, handle);
    const undo = workspace.history?.undo ?? [];
    const redo = workspace.history?.redo ?? [];
    return {
        session: handle,
        revision: workspace.revision,
        undoAvailable: undo.length > 0,
        redoAvailable: redo.length > 0,
        undoRevisions: undo.map((entry) => entry.revision),
        redoRevisions: redo.map((entry) => entry.revision),
    };
}
/** The standalone baskets of a workspace: the single present basket in full, or a pointer to each of several. */
export function inspectBaskets(rt, request) {
    const workspace = requireWorkspaceOf(rt, request.session);
    const present = presentBaskets(workspace);
    const selected = request.basket ?? (present.length === 1 ? present[0] : undefined);
    if (selected !== undefined) {
        if (!present.includes(selected))
            throw new Error(`The workspace has no ${selected} basket.`);
        return { basket: selected, ...basketView(workspace, selected, { offset: request.offset, limit: request.limit }) };
    }
    return {
        session: workspace.id,
        revision: workspace.revision,
        baskets: present.map((basket) => ({
            basket, next: { tool: TOOL, arguments: { session: workspace.id, view: 'baskets', basket } },
        })),
    };
}
export function assertCurrentWorkspaceRevision(rt, handle, expected) {
    const workspace = requireWorkspaceOf(rt, handle);
    assertWorkspaceRevision(workspace, expected);
    return workspace;
}
//# sourceMappingURL=workspaceView.js.map