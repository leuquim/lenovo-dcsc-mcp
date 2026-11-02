import type { ConfigMode } from '../config/constants.js';
import type { SolutionContext } from '../config/schema.js';
import { type ReducedConfiguration } from '../domain/reduce.js';
import { type RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
import { type CreateSessionInput } from '../session/SessionStore.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import type { Runtime } from './runtime.js';
interface LaunchOptions {
    expectedRevision?: number | undefined;
    productCode: string;
    mode: ConfigMode;
    solution: SolutionContext;
    ctx: RequestCtx;
    label?: string | undefined;
    workspaceId?: string | undefined;
}
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
export declare function modesContaining(rt: Runtime, ctx: RequestCtx, codes: string[]): Promise<Map<string, string[]>>;
/**
 * Launches a configuration and opens a session within a workspace.
 */
export declare function launch(rt: Runtime, opts: LaunchOptions): Promise<ConfigSession>;
export declare function prepareLaunch(rt: Runtime, opts: LaunchOptions): Promise<CreateSessionInput>;
export declare function autoDerive(rt: Runtime, reduced: ReducedConfiguration, opts: {
    ctx: RequestCtx;
    solution: SolutionContext;
    mode: ConfigMode;
    validationMode: 'guided' | 'expert';
    autoCorrect?: boolean;
    softwareEdit?: boolean;
    switchedFullModeToExpress?: boolean;
    sourceRaw?: RawConfiguration;
    workspace?: WorkspaceSession;
}): Promise<RawConfiguration | undefined>;
/**
 * Applies selection changes and commits the reconciled result.
 */
export declare function configure(rt: Runtime, session: ConfigSession, changes: Array<{
    section: string;
    code: string;
    quantity: number;
}>, ctx: RequestCtx, expectedRevision?: number): Promise<ConfigSession>;
export declare function loadUnconfigured(rt: Runtime, handle: string, expectedWorkspaceRevision: number, ctx: RequestCtx): Promise<ConfigSession>;
export declare function setUnconfigured(rt: Runtime, handle: string, changes: Array<{
    section: string;
    code: string;
    quantity: number;
}>, expectedWorkspaceRevision: number): Promise<ConfigSession>;
/** Operates only on a detached transaction draft; never acquires another lock. */
export declare function configureDraft(rt: Runtime, session: ConfigSession, changes: Array<{
    section: string;
    code: string;
    quantity: number;
}>, ctx: RequestCtx, workspace?: WorkspaceSession, switchedFullModeToExpress?: boolean): Promise<ConfigSession>;
/** Website controls apply consistently to the complete workspace. */
export declare function setConfigurationControls(rt: Runtime, handle: string, opts: {
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
/** The configurator's Lenovo AI Express / Full Mode switch: re-derives with showExpressMode flipped. */
export declare function setExpressMode(rt: Runtime, session: ConfigSession, express: boolean, ctx: RequestCtx, expectedRevision?: number): Promise<ConfigSession>;
/**
 * Sets how many identical units of this configuration are wanted.
 */
export declare function setQuantity(rt: Runtime, session: ConfigSession, quantity: number, expectedRevision?: number): Promise<ConfigSession>;
export declare function undo(rt: Runtime, session: ConfigSession, expectedRevision?: number): Promise<boolean>;
export declare function closeSession(rt: Runtime, handle: string, expectedRevision?: number): Promise<boolean>;
/** Unconfigured selections are client-held, so they never go through DCSC derivation. */
export declare function applySelections(rt: Runtime, session: ConfigSession, changes: Array<{
    section: string;
    code: string;
    quantity: number;
}>, ctx: RequestCtx, expectedWorkspaceRevision?: number): Promise<{
    unconfigured: boolean;
    session: ConfigSession;
}>;
export {};
