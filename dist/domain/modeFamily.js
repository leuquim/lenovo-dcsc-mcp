/**
 * DCSC keeps the user-facing launch mode and the downstream wire family
 * separate. A preconfigured product launched "as CTO" retains that display
 * mode, but customization, workspace validation and export use CTO routes and
 * CTO payload semantics.
 */
export function hardwareModeFamily(mode) {
    return mode === 'cto' || mode === 'lfo-as-cto' ? 'cto' : 'lfo';
}
export function hardwareEndpointFamily(mode) {
    return hardwareModeFamily(mode) === 'cto' ? 'ctos' : 'lfos';
}
export function usesCtoWire(mode) {
    return hardwareModeFamily(mode) === 'cto';
}
//# sourceMappingURL=modeFamily.js.map