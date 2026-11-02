import { HPC_SOLUTION_MODE } from '../config/constants.js';
export function autoDerivePath(family) {
    return `/${family}/autoDerive`;
}
export function exportZipPath(family) {
    return `/${family}/export_zip`;
}
export function racksCustomizePath(family) {
    return `/${family}/racks/customize`;
}
export function errorCustomizeWithAutoDerivePath(family) {
    return `/${family}/errorCustomizeWithAutoDerive`;
}
export function exportXlsPath(family) {
    return `/${family}/power/export_xls`;
}
/** Launch route for a product code; the launch mode picks the route, not only the family. */
export function launchPath(mode, productCode) {
    const code = encodeURIComponent(productCode);
    switch (mode) {
        case 'lfo': return `/lfos/${code}/as_lfo_launch`;
        case 'lfo-as-cto': return `/lfos/${code}/as_cto_launch`;
        case 'lfo-add-options': return `/lfos/${code}/add_options_launch`;
        case 'cto': return `/ctos/${code}/launch`;
    }
}
/** The website sends controlExpressModal=false in the HPC mode and true otherwise. */
export function isExpressModalControl(solutionMode) {
    return solutionMode !== HPC_SOLUTION_MODE;
}
export function launchQuery(solutionMode, scope) {
    return {
        serviceCto: true, serviceType: 'servicecto', controlExpressModal: isExpressModalControl(solutionMode),
        ...(scope ? { scope } : {}),
    };
}
export function rackLaunchPath(rackCode) {
    return `/ctos/racks/${encodeURIComponent(rackCode)}/launch`;
}
export function rackLaunchQuery(solutionMode) {
    return { controlExpressModal: isExpressModalControl(solutionMode), serviceCto: true };
}
/** CTO-family launch for service-only or generated products (no mode involved). */
export function ctoLaunchPath(productCode) {
    return `/ctos/${encodeURIComponent(productCode)}/launch`;
}
export function racksHardwarePath(family) {
    return `/${family}/racks/hardware`;
}
//# sourceMappingURL=endpoints.js.map