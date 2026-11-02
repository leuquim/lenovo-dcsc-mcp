import { launch, loadUnconfigured, modesContaining } from './launch.js';
import { launchReferenceSolution } from './importExport.js';
import { launchServices, launchSoftware } from './standalone.js';
export const HARDWARE_LAUNCH_MODES = ['cto', 'lfo', 'lfo-as-cto', 'lfo-add-options'];
export const LAUNCH_MODES = [...HARDWARE_LAUNCH_MODES, 'reference-solution', 'software', 'services', 'unconfigured'];
function isHardwareMode(mode) {
    return HARDWARE_LAUNCH_MODES.includes(mode);
}
/** Opens whatever the website's Customize entry points open, from one set of inputs. */
export async function launchEntry(rt, input) {
    if (input.mode === 'unconfigured') {
        if (!input.session)
            throw new Error('Pass the configuration session to load Unconfigured options for.');
        const workspace = rt.sessions.getWorkspace(input.session);
        if (!workspace)
            throw new Error(`Session ${input.session} not found.`);
        const session = await loadUnconfigured(rt, input.session, input.expectedRevision ?? workspace.revision, rt.newCtx());
        return { kind: 'unconfigured', session };
    }
    if (input.mode === 'reference-solution') {
        if (!input.sid)
            throw new Error('sid is required to customize a reference solution.');
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
    if (!isHardwareMode(input.mode))
        throw new Error(`Unsupported launch mode ${input.mode}.`);
    if (!input.productCode)
        throw new Error('productCode is required to launch a configuration.');
    const workspace = input.session ? rt.sessions.getWorkspace(input.session) : undefined;
    if (input.session && !workspace)
        throw new Error(`Workspace ${input.session} not found.`);
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
//# sourceMappingURL=launchEntry.js.map