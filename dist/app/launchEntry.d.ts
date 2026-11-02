import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import type { StandaloneSoftwareState } from '../domain/standalone.js';
import type { ImportResult } from './serviceHelpers.js';
import type { Runtime } from './runtime.js';
export declare const HARDWARE_LAUNCH_MODES: readonly ["cto", "lfo", "lfo-as-cto", "lfo-add-options"];
export declare const LAUNCH_MODES: readonly ["cto", "lfo", "lfo-as-cto", "lfo-add-options", "reference-solution", "software", "services", "unconfigured"];
export type LaunchEntryMode = (typeof LAUNCH_MODES)[number];
export interface LaunchEntryInput {
    mode: LaunchEntryMode;
    productCode?: string | undefined;
    sid?: string | undefined;
    session?: string | undefined;
    expectedRevision?: number | undefined;
    label?: string | undefined;
    solutionMode?: string | undefined;
    replace: boolean;
    refresh: boolean;
    productQuantity: number;
    productDescription?: string | undefined;
    subCategory: string;
}
export type LaunchEntryOutcome = {
    kind: 'configuration';
    session: ConfigSession;
    solutionMode: string;
    availableIn: string[];
    outOfCatalog: boolean;
} | {
    kind: 'unconfigured';
    session: ConfigSession;
} | {
    kind: 'reference-solution';
    result: ImportResult;
} | {
    kind: 'software';
    workspace: WorkspaceSession;
    state: StandaloneSoftwareState;
} | {
    kind: 'services';
    workspace: WorkspaceSession;
};
/** Opens whatever the website's Customize entry points open, from one set of inputs. */
export declare function launchEntry(rt: Runtime, input: LaunchEntryInput): Promise<LaunchEntryOutcome>;
