import { diffConfigurations } from '../model/diff.js';
import { buildIndex } from '../model/index.js';
import { fetchRuleVersionsInfo } from '../domain/ruleVersions.js';
/** What DCSC's rules engine added, removed or substituted, plus its rule messages verbatim. */
export function explainConfiguration(session, sinceRevision) {
    const snapshots = session.snapshots;
    const baseline = sinceRevision !== undefined
        ? snapshots.find((s) => s.revision === sinceRevision)
        : snapshots[snapshots.length - 1];
    const messages = (session.raw.expansionMessages ?? []).map((m) => ({
        severity: m.type ?? 'info',
        ...(m.code !== undefined ? { code: m.code } : {}),
        ...(m.sectionName !== undefined ? { section: m.sectionName } : {}),
        message: m.text ?? String(m),
    }));
    const lastIntent = session.intents[session.intents.length - 1];
    if (!baseline) {
        return {
            ruleMessages: messages,
            note: 'No earlier revision is retained, so only the current rule messages are available. ' +
                'Rule messages explain constraints DCSC is enforcing on this configuration.',
        };
    }
    const diff = diffConfigurations({
        beforeIndex: buildIndex(baseline.raw),
        afterIndex: session.index,
        beforeRaw: baseline.raw,
        afterRaw: session.raw,
        currency: session.locale.currency,
        requested: new Set((lastIntent?.changes ?? []).map((c) => c.code)),
    });
    return {
        comparedFrom: baseline.revision,
        comparedTo: session.revision,
        requested: lastIntent?.changes ?? [],
        ...diff,
        ruleMessages: messages,
        note: 'Entries flagged "auto" were chosen by DCSC, not requested. Rule messages are the engine\'s ' +
            'own words for the constraint it applied.',
    };
}
export async function configurationRuleVersions(rt, ctoCode, tableCode) {
    const info = await fetchRuleVersionsInfo(rt.http, await rt.ctxEnsuringSolution(), {
        ctoCode,
        tableCode,
    });
    return { ctoCode: info.ctoCode, versions: info.versions, tableCode: info.tableCode, ruleVersions: info.ruleVersions };
}
//# sourceMappingURL=configurationView.js.map