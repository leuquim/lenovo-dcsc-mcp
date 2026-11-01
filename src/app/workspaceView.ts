import { standaloneHardwareTotal } from '../domain/standaloneHardware.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import { projectSummary } from '../model/project.js';
import {
  projectWorkspaceIntegrity,
  projectWorkspaceLayout,
  projectWorkspacePage,
  projectWorkspaceSummary,
} from '../model/workspaceProjection.js';
import { unplacedManagedStorageComponentIds } from '../domain/storagePreferences.js';
import { assertWorkspaceRevision } from './serviceHelpers.js';
import { hardwareState, serviceState, softwareState } from './standalone.js';
import type { Runtime } from './runtime.js';

const TOOL = 'dcsc_workspace_get';

export function requireConfigSession(rt: Runtime, id: string): ConfigSession {
  const resolved = rt.sessions.resolveHandle(id);
  if (!resolved) {
    throw new Error(
      `No such configuration session: ${id}. Use dcsc_session_list to see open sessions, or dcsc_launch to start one.`,
    );
  }
  if (resolved.kind === 'configuration') return resolved.session;
  const sessions = [...resolved.workspace.configurations.values()];
  if (sessions.length === 1) return sessions[0]!;
  throw new Error(
    `Workspace ${id} contains ${sessions.length} configurations, so a configuration target is ambiguous. ` +
      `Pass one configuration session ID: ${sessions.map((session) => session.id).join(', ')}.`,
  );
}

/** The workspace owning a configuration or workspace handle. */
export function requireWorkspaceOf(rt: Runtime, handle: string): WorkspaceSession {
  const resolved = rt.sessions.resolveHandle(handle);
  if (!resolved) {
    throw new Error(`No such session or workspace: ${handle}. Use dcsc_session_list to see open sessions.`);
  }
  if (!resolved.workspace) throw new Error(`Configuration ${handle} is not attached to an open workspace.`);
  return resolved.workspace;
}

export interface WorkspacePageRequest {
  session: string;
  view: 'summary' | 'layout';
  path?: string[] | undefined;
  offset: number;
  limit: number;
  expectedRevision?: number | undefined;
}

/** A configuration's or workspace's compact summary, or the physical layout, with revision-bound detail pages. */
export function inspectWorkspace(rt: Runtime, request: WorkspacePageRequest): Record<string, unknown> {
  const resolved = rt.sessions.resolveHandle(request.session);
  if (!resolved) {
    throw new Error(`No such session or workspace: ${request.session}. Use dcsc_session_list to see open sessions.`);
  }
  const workspace = requireWorkspaceOf(rt, request.session);
  if (request.expectedRevision !== undefined && request.expectedRevision !== workspace.revision) {
    throw new Error(
      `Workspace ${workspace.id} changed from revision ${request.expectedRevision} to ${workspace.revision}. ` +
        `Restart ${TOOL} without path before following new continuations.`,
    );
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
  if (
    resolved.kind === 'workspace' &&
    (workspace.configurations.size > 1 || workspace.serverState.standaloneSoftwareState ||
      workspace.serverState.standaloneHardwareState ||
      unplacedManagedStorageComponentIds(workspace).size > 0)
  ) {
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
            note:
              'Preconfigured model with no configurable sections: there is nothing to prime and ' +
              'dcsc_configure does not apply. Browsing, pricing and export all work.',
          }
        : session.mode === 'lfo'
          ? {
              note:
                'DCSC rejects the priming body on /lfos/autoDerive for this model, so ' +
                'dcsc_configure will NOT work in "lfo" mode. Browsing, pricing and export do work. ' +
                'To change anything, relaunch the same code with mode "lfo-as-cto": that returns ' +
                'a configurable tree and primes correctly (note it prices the CTO base, not the ' +
                'preconfigured bundle).',
            }
          : {
              warning:
                'This configuration could not be primed, so dcsc_configure may fail. ' +
                'Browsing, pricing and export still work.',
            }),
  };
}

/** Undo and redo depth of the workspace, so callers know whether dcsc_undo can act. */
export function inspectHistory(rt: Runtime, handle: string): Record<string, unknown> {
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

interface BasketRow {
  basket: 'software' | 'hardware' | 'services';
  code: string;
  description?: string | undefined;
  quantity: number;
  unitPrice?: number | undefined;
  totalPrice?: number | undefined;
}

const roundPrice = (value: number): number => Math.round(value * 100) / 100;

/** The standalone software, hardware and services baskets of a workspace, as one paged list of lines. */
export function inspectBaskets(rt: Runtime, request: { session: string; offset: number; limit: number }): Record<string, unknown> {
  const workspace = requireWorkspaceOf(rt, request.session);
  const software = softwareState(workspace, false);
  const hardware = hardwareState(workspace, false);
  const services = serviceState(workspace, false);
  const rows: BasketRow[] = [
    ...(software?.selections ?? []).map((selection): BasketRow => ({
      basket: 'software', code: selection.code, description: selection.feature.description,
      quantity: selection.quantity, unitPrice: selection.unitPrice, totalPrice: selection.totalPrice,
    })),
    ...(hardware?.selections ?? []).map((selection): BasketRow => ({
      basket: 'hardware', code: selection.code, description: selection.description, quantity: selection.quantity,
      unitPrice: selection.unitPrice,
      totalPrice: selection.unitPrice !== undefined ? roundPrice(selection.unitPrice * selection.quantity) : undefined,
    })),
    ...(services?.selections ?? []).map((selection): BasketRow => ({
      basket: 'services', code: selection.code, description: selection.description, quantity: selection.quantity,
    })),
  ];
  const page = rows.slice(request.offset, request.offset + request.limit);
  return {
    session: request.session,
    revision: workspace.revision,
    currency: workspace.locale.currency,
    priceType: 'LIST',
    baskets: {
      ...(software ? { software: { catalogItems: software.features.length,
        totalListPrice: roundPrice(software.selections.reduce((total, selection) => total + (selection.totalPrice ?? 0), 0)) } } : {}),
      ...(hardware ? { hardware: { totalListPrice: standaloneHardwareTotal(hardware) ?? null } } : {}),
      ...(services ? { services: { product: services.product, subCategory: services.subCategory } } : {}),
    },
    total: rows.length,
    offset: request.offset,
    returned: page.length,
    lines: page,
    ...(request.offset + page.length < rows.length
      ? { next: { tool: TOOL, arguments: { session: request.session, view: 'baskets', offset: request.offset + page.length, limit: request.limit } } }
      : {}),
  };
}

export function assertCurrentWorkspaceRevision(rt: Runtime, handle: string, expected: number | undefined): WorkspaceSession {
  const workspace = requireWorkspaceOf(rt, handle);
  assertWorkspaceRevision(workspace, expected);
  return workspace;
}
