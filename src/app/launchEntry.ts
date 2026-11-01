import type { ConfigMode } from '../config/constants.js';
import type { ConfigSession, WorkspaceSession } from '../model/session.js';
import type { StandaloneSoftwareState } from '../domain/standalone.js';
import { launch, loadUnconfigured, modesContaining } from './launch.js';
import { launchReferenceSolution } from './importExport.js';
import { launchServices, launchSoftware } from './standalone.js';
import type { ImportResult } from './serviceHelpers.js';
import type { Runtime } from './runtime.js';

export const HARDWARE_LAUNCH_MODES = ['cto', 'lfo', 'lfo-as-cto', 'lfo-add-options'] as const satisfies readonly ConfigMode[];
export const LAUNCH_MODES = [...HARDWARE_LAUNCH_MODES, 'reference-solution', 'software', 'services', 'unconfigured'] as const;
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

export type LaunchEntryOutcome =
  | { kind: 'configuration'; session: ConfigSession; solutionMode: string; availableIn: string[]; outOfCatalog: boolean }
  | { kind: 'unconfigured'; session: ConfigSession }
  | { kind: 'reference-solution'; result: ImportResult }
  | { kind: 'software'; workspace: WorkspaceSession; state: StandaloneSoftwareState }
  | { kind: 'services'; workspace: WorkspaceSession };

function isHardwareMode(mode: LaunchEntryMode): mode is ConfigMode {
  return (HARDWARE_LAUNCH_MODES as readonly string[]).includes(mode);
}

/** Opens whatever the website's Customize entry points open, from one set of inputs. */
export async function launchEntry(rt: Runtime, input: LaunchEntryInput): Promise<LaunchEntryOutcome> {
  if (input.mode === 'unconfigured') {
    if (!input.session) throw new Error('Pass the configuration session to load Unconfigured options for.');
    const workspace = rt.sessions.getWorkspace(input.session);
    if (!workspace) throw new Error(`Session ${input.session} not found.`);
    const session = await loadUnconfigured(rt, input.session, input.expectedRevision ?? workspace.revision, rt.newCtx());
    return { kind: 'unconfigured', session };
  }
  if (input.mode === 'reference-solution') {
    if (!input.sid) throw new Error('sid is required to customize a reference solution.');
    const result = await launchReferenceSolution(rt, input.sid, rt.newCtx(), input.solutionMode);
    return { kind: 'reference-solution', result };
  }
  if (input.mode === 'software') {
    const { workspace, state } = await launchSoftware(rt, {
      session: input.session, solutionMode: input.solutionMode, label: input.label,
      replace: input.replace, refresh: input.refresh, expectedRevision: input.expectedRevision,
    });
    return { kind: 'software', workspace, state };
  }
  if (input.mode === 'services') {
    const workspace = await launchServices(rt, {
      productCode: input.productCode, productQuantity: input.productQuantity,
      productDescription: input.productDescription, subCategory: input.subCategory,
      session: input.session, solutionMode: input.solutionMode, label: input.label,
      replace: input.replace, refresh: input.refresh, expectedRevision: input.expectedRevision,
    });
    return { kind: 'services', workspace };
  }
  if (!isHardwareMode(input.mode)) throw new Error(`Unsupported launch mode ${input.mode}.`);
  if (!input.productCode) throw new Error('productCode is required to launch a configuration.');
  const workspace = input.session ? rt.sessions.getWorkspace(input.session) : undefined;
  if (input.session && !workspace) throw new Error(`Workspace ${input.session} not found.`);
  const ctx = rt.newCtx(workspace ? { locale: workspace.locale, solution: workspace.solution } : {});
  const solution = await rt.resolveSolution(ctx, input.solutionMode ?? workspace?.solution.solutionMode);
  const availability = await modesContaining(rt, ctx, [input.productCode]);
  const availableIn = availability.get(input.productCode.toUpperCase()) ?? [];
  const session = await launch(rt, {
    productCode: input.productCode,
    mode: input.mode,
    solution,
    ctx,
    workspaceId: input.session,
    expectedRevision: input.expectedRevision,
    ...(input.label !== undefined ? { label: input.label } : {}),
  });
  return {
    kind: 'configuration',
    session,
    solutionMode: solution.solutionMode,
    availableIn,
    outOfCatalog: availableIn.length > 0 && !availableIn.includes(solution.solutionMode),
  };
}
