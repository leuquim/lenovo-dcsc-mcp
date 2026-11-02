import { errorCustomizeWithAutoDerivePath } from './endpoints.js';
import { hardwareEndpointFamily } from './modeFamily.js';
/**
 * Discovers candidate hardware sections eligible for auto-fix on a CTO product.
 *
 * Upstream route: POST /api/cto/hardware/autoFix/config?cto=${ctoCode}&country_or_region=${country}&language=${language}&currency=${currency}
 * Returns list of eligible sections with tab title, character name and description.
 */
export async function inspectAutoFixCandidates(http, ctoCode, ctx) {
    const code = ctoCode.trim();
    if (!code) {
        throw new Error('A CTO product code is required to inspect auto-fix candidates.');
    }
    const response = await http.send({
        endpoint: 'inspect_auto_fix_candidates',
        method: 'POST',
        path: '/cto/hardware/autoFix/config',
        query: {
            cto: code,
        },
        requiresSolution: false,
        responseKind: 'json',
        timeoutClass: 'interactive',
        ctx,
    });
    const raw = response.raw;
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.map((item) => {
        const obj = (item && typeof item === 'object' ? item : {});
        return {
            tabTitle: typeof obj['tabTitle'] === 'string' ? obj['tabTitle'] : '',
            characterName: typeof obj['characterName'] === 'string' ? obj['characterName'] : '',
            characterDesc: typeof obj['characterDesc'] === 'string' ? obj['characterDesc'] : '',
        };
    });
}
/**
 * Extracts current section selections from a raw configuration tree.
 *
 * Formats selections into the wire shape expected by POST /cto/hardware/autoFix.
 */
export function buildAutoFixCurrentSelections(raw) {
    const bySection = new Map();
    const addResult = (sectionName, featureCode, quantity) => {
        if (!sectionName || !featureCode)
            return;
        let sectionMap = bySection.get(sectionName);
        if (!sectionMap) {
            sectionMap = new Map();
            bySection.set(sectionName, sectionMap);
        }
        const current = sectionMap.get(featureCode) ?? 0;
        sectionMap.set(featureCode, current + quantity);
    };
    const processSection = (section) => {
        if (!section || typeof section !== 'object')
            return;
        const name = typeof section.name === 'string' ? section.name : '';
        if (!name)
            return;
        const results = Array.isArray(section.results) ? section.results : [];
        for (const r of results) {
            if (!r || typeof r !== 'object')
                continue;
            const rec = r;
            const code = String(rec['featureCode'] ?? rec['code'] ?? '').trim();
            if (!code)
                continue;
            const quantity = typeof rec['quantity'] === 'number' ? rec['quantity'] : 1;
            addResult(name, code, quantity);
        }
    };
    for (const tab of raw.tabs ?? []) {
        for (const subTab of tab.subTabs ?? []) {
            for (const section of subTab.sections ?? []) {
                processSection(section);
            }
        }
    }
    const unselectable = Array.isArray(raw['unSelectableCharacters'])
        ? raw['unSelectableCharacters']
        : [];
    for (const sec of unselectable) {
        processSection(sec);
    }
    const topSections = Array.isArray(raw['sections'])
        ? raw['sections']
        : [];
    for (const sec of topSections) {
        processSection(sec);
    }
    return [...bySection.entries()].map(([name, codeMap]) => ({
        name,
        results: [...codeMap.entries()].map(([featureCode, quantity]) => ({
            featureCode,
            quantity,
        })),
    }));
}
/**
 * Executes hardware auto-fix against DCSC to resolve rule validation errors.
 *
 * Upstream route: POST /api/cto/hardware/autoFix?country_or_region=${country}&language=${language}&currency=${currency}
 */
export async function executeAutoFix(http, ctoCode, requiredSections, currentSelections, ctx, configuration) {
    const code = ctoCode.trim();
    if (!code) {
        throw new Error('A CTO product code is required to execute auto-fix.');
    }
    const response = await http.send({
        endpoint: 'execute_auto_fix',
        method: 'POST',
        path: '/cto/hardware/autoFix',
        query: { configurationId: configuration.configurationId },
        body: {
            kind: 'json',
            value: {
                cto: code,
                requiredSections,
                currentSelections,
                showExpressMode: configuration.showExpressMode,
                selectedTceAudience: configuration.selectedTceAudience ?? null,
            },
        },
        requiresSolution: false,
        responseKind: 'json',
        timeoutClass: 'heavy',
        ctx,
    });
    const raw = response.raw;
    if (!raw || typeof raw !== 'object') {
        throw new Error('DCSC returned an unrecognised response to hardware auto-fix.');
    }
    const rawSections = Array.isArray(raw['sections'])
        ? raw['sections']
        : [];
    const rawNotices = Array.isArray(raw['notices'])
        ? raw['notices']
        : [];
    const notices = rawNotices.map((n) => ({
        message: typeof n['message'] === 'string' ? n['message'] : String(n),
        severity: typeof n['severity'] === 'string' ? n['severity'] : undefined,
    }));
    return {
        ctoCode: typeof raw['ctoCode'] === 'string' ? raw['ctoCode'] : code,
        sections: rawSections,
        hipos: Array.isArray(raw['hipos']) ? raw['hipos'] : undefined,
        errors: Array.isArray(raw['errors']) ? raw['errors'] : null,
        notices: notices.length > 0 ? notices : null,
        message: typeof raw['message'] === 'string' ? raw['message'] : undefined,
        autoFixResult: typeof raw['autoFixResult'] === 'string' ? raw['autoFixResult'] : 'FIX_FAIL',
        pciWizard: raw['pciWizard'],
        tceEnabled: raw['tceEnabled'] === true,
    };
}
/**
 * Merges updated section selections from auto-fix into the configuration tree.
 *
 * Matches sections by `name`, replaces their results with the resolved selections,
 * restores feature metadata (description, ctoCode, type, cost) from existing section features,
 * and clears resolved section errors.
 */
export function applyAutoFixSections(raw, fixedSections) {
    const draft = structuredClone(raw);
    const sectionsChanged = [];
    const fixedByName = new Map();
    for (const fs of fixedSections) {
        if (!fs || typeof fs !== 'object')
            continue;
        const name = typeof fs['name'] === 'string' ? fs['name'] : '';
        if (name) {
            fixedByName.set(name, fs);
        }
    }
    if (fixedByName.size === 0) {
        return { configuration: draft, sectionsChanged };
    }
    const updateSection = (section) => {
        const name = typeof section.name === 'string' ? section.name : '';
        if (!name || !fixedByName.has(name))
            return false;
        const fixed = fixedByName.get(name);
        const rawFixedResults = Array.isArray(fixed['results'])
            ? fixed['results']
            : [];
        const existingFeatures = Array.isArray(section.features)
            ? section.features
            : [];
        const featureMap = new Map();
        for (const f of existingFeatures) {
            if (f.code)
                featureMap.set(f.code, f);
        }
        const newResults = [];
        for (const item of rawFixedResults) {
            const code = String(item['featureCode'] ?? item['code'] ?? '').trim();
            if (!code)
                continue;
            const quantity = typeof item['quantity'] === 'number' ? item['quantity'] : 1;
            const feat = featureMap.get(code);
            const resultEntry = {
                code,
                quantity,
                description: feat?.description ?? item['description'] ?? '',
                ctoCode: feat?.ctoCode ?? draft.sliceCtoCode ?? '',
                type: feat?.type ?? 'hardware',
                characterName: name,
                deSelectable: true,
                cost: feat?.unitPrice ?? 0,
                ...item,
            };
            newResults.push(resultEntry);
        }
        section.results = newResults;
        if (Array.isArray(fixed['errors'])) {
            section.errors = fixed['errors'];
        }
        else {
            section.errors = [];
        }
        return true;
    };
    for (const tab of draft.tabs ?? []) {
        for (const subTab of tab.subTabs ?? []) {
            for (const section of subTab.sections ?? []) {
                if (updateSection(section)) {
                    const name = section.name;
                    if (!sectionsChanged.includes(name))
                        sectionsChanged.push(name);
                }
            }
        }
    }
    const unselectable = Array.isArray(draft['unSelectableCharacters'])
        ? draft['unSelectableCharacters']
        : [];
    for (const sec of unselectable) {
        if (updateSection(sec)) {
            const name = sec['name'];
            if (!sectionsChanged.includes(name))
                sectionsChanged.push(name);
        }
    }
    const topSections = Array.isArray(draft['sections'])
        ? draft['sections']
        : [];
    for (const sec of topSections) {
        if (updateSection(sec)) {
            const name = sec['name'];
            if (!sectionsChanged.includes(name))
                sectionsChanged.push(name);
        }
    }
    return { configuration: draft, sectionsChanged };
}
/**
 * Dispatches batch error customize with auto derive to either CTO or LFO endpoints.
 *
 * Upstream routes:
 *   POST /api/ctos/errorCustomizeWithAutoDerive
 *   POST /api/lfos/errorCustomizeWithAutoDerive
 */
export async function errorCustomizeWithAutoDerive(http, ctx, input) {
    const mode = input.mode === 'lfo' ? 'lfo' : 'cto';
    const path = errorCustomizeWithAutoDerivePath(hardwareEndpointFamily(mode));
    const endpoint = mode === 'lfo' ? 'lfos.errorCustomizeWithAutoDerive' : 'ctos.errorCustomizeWithAutoDerive';
    const response = await http.send({
        endpoint,
        method: 'POST',
        path,
        body: {
            kind: 'json',
            value: { configurations: input.configurations },
        },
        responseKind: 'json',
        timeoutClass: 'interactive',
        requiresSolution: true,
        ctx,
    });
    const raw = response.raw;
    return Array.isArray(raw) ? raw : [];
}
//# sourceMappingURL=autoFix.js.map