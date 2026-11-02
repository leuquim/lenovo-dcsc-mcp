import { extractPowerReport, powerLoadFactor } from './power.js';
import { objectOrEmpty } from '../util/coerce.js';
const objects = (value) => Array.isArray(value) ? value.map(objectOrEmpty) : [];
/** IDs are the website selector values, not a new voltage vocabulary. */
export function inspectPowerControls(raw) {
    const voltages = objects(raw.optionalVoltages).filter(value => typeof value['displayValue'] === 'string' && typeof value['type'] === 'string')
        .map(value => ({ id: `${value['displayValue']}@${value['type']}`, voltage: structuredClone(value) }));
    const policies = objects(raw.powerPolicies).filter(value => typeof value['value'] === 'number' || typeof value['value'] === 'string')
        .map(value => ({ value: value['value'], description: value['description'], key: value['key'] }));
    const voltage = objectOrEmpty(raw.voltage);
    return {
        available: extractPowerReport(raw) !== undefined,
        current: {
            voltage: typeof voltage['displayValue'] === 'string' && typeof voltage['type'] === 'string'
                ? `${voltage['displayValue']}@${voltage['type']}` : null,
            loadFactor: powerLoadFactor(raw) ?? null,
            powerPolicy: raw.currentPowerPolicy ?? null,
        },
        voltages, policies,
        loadFactorRange: { min: 0, max: 100, step: 1 },
    };
}
/** Stage the power dialog's client-held fields without changing committed state. */
export function stagePowerControls(raw, changes) {
    if (Object.values(changes).every(value => value === undefined))
        throw new Error('Supply a voltage, loadFactor or powerPolicy change.');
    const options = inspectPowerControls(raw);
    if (!options.available)
        throw new Error('DCSC supplies no complete numeric power report for this configuration. Power controls are unavailable.');
    const draft = structuredClone(raw);
    if (changes.voltage !== undefined) {
        const matches = options.voltages.filter(choice => choice.id === changes.voltage);
        if (matches.length !== 1)
            throw new Error('Voltage must be one exact unambiguous ID from dcsc_power_get.');
        draft.voltage = structuredClone(matches[0].voltage);
    }
    if (changes.powerPolicy !== undefined) {
        if (options.policies.filter(choice => choice.value === changes.powerPolicy).length !== 1) {
            throw new Error('Power policy must be one exact unambiguous value from dcsc_power_get.');
        }
        draft.currentPowerPolicy = changes.powerPolicy;
    }
    if (changes.loadFactor !== undefined && (!Number.isInteger(changes.loadFactor) || changes.loadFactor < 0 || changes.loadFactor > 100)) {
        throw new Error('loadFactor must be an integer from 0 through 100.');
    }
    const loadFactor = changes.loadFactor ?? powerLoadFactor(raw);
    draft.loadFactor = loadFactor;
    const container = objectOrEmpty(draft.powerReportResponse);
    container['powerReport'] = { ...objectOrEmpty(container['powerReport']), loadFactor };
    draft.powerReportResponse = container;
    return draft;
}
/** Captured powerReportQuerySelector; quantity is not multiplied into a unit report. */
export function buildPowerCalculationRequest(raw) {
    const features = [];
    for (const tab of raw.tabs ?? [])
        for (const subTab of tab.subTabs ?? []) {
            for (const section of subTab.sections ?? [])
                for (const result of section.results ?? []) {
                    features.push({ characterName: section.name, featureCode: result.code, ctoCode: result.ctoCode,
                        derived: result['derived'], quantity: result.quantity });
                }
        }
    for (const section of objects(raw.unSelectableCharacters ?? raw.unSelectableCharacterResults)) {
        for (const result of objects(section['results']))
            features.push({
                characterName: section['name'] ?? section['characterName'], featureCode: result['code'],
                ctoCode: result['ctoCode'], derived: result['derived'], quantity: result['quantity'],
            });
    }
    return [{ features, operationVoltage: raw.voltage, type: raw.type,
            productNumber: raw.code, utilization: powerLoadFactor(raw), currentPowerPolicy: raw.currentPowerPolicy }];
}
/** Native Save updates both retained unselectable shapes; never synthesizes a selection. */
export function acceptPowerCalculation(draft, response) {
    const accepted = objectOrEmpty(response);
    const report = objectOrEmpty(accepted['powerReport']);
    const errors = accepted['errorMsg'];
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0) && errors !== '') {
        throw new Error('DCSC rejected the requested power settings. No power changes were saved.');
    }
    const result = structuredClone(draft);
    result.powerReportResponse = structuredClone(accepted);
    if (!extractPowerReport(result))
        throw new Error('DCSC returned no complete numeric power calculation. No power changes were saved.');
    const voltage = objectOrEmpty(draft.voltage);
    const expectedVoltage = `${voltage['displayValue']}-${voltage['type']}`;
    if (report['loadFactor'] !== powerLoadFactor(draft) || report['operatingVoltage'] !== expectedVoltage ||
        objectOrEmpty(report['powerPolicy'])['value'] !== draft.currentPowerPolicy) {
        throw new Error('DCSC did not retain the requested power settings. No power changes were saved.');
    }
    result.loadFactor = report['loadFactor'];
    result.currentPowerPolicy = objectOrEmpty(report['powerPolicy'])['value'];
    for (const [name, code] of [['VOLTAGE_MI', report['voltageMI']], ['POWER_POLICY_MI', accepted['powerPolicyMI']]]) {
        for (const shape of ['unSelectableCharacters', 'unSelectableCharacterResults']) {
            const section = objects(result[shape]).find(section => (section['name'] ?? section['characterName']) === name);
            const first = objects(section?.['results'])[0];
            if (first) {
                if (typeof code !== 'string' || !code)
                    throw new Error(`DCSC omitted ${name} needed to preserve the saved power settings in export. No changes were saved.`);
                first['code'] = code;
            }
        }
    }
    result.voltageMI = report['voltageMI'];
    result.powerPolicyMI = accepted['powerPolicyMI'];
    return result;
}
//# sourceMappingURL=powerControls.js.map