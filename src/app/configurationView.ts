import { diffConfigurations } from '../model/diff.js';
import { buildIndex } from '../model/index.js';
import type { ConfigSession } from '../model/session.js';
import { fetchUpstreamFeatureDetails, summarizeFeatureSpec } from '../domain/featureDetails.js';
import {
  fetchSmartLfoRecommendation,
  fetchSubTabRecommendations,
  fetchSummaryRecommendations,
  type SummaryRecommendationPayload,
} from '../domain/recommendations.js';
import { fetchRuleVersionsInfo } from '../domain/ruleVersions.js';
import type { Runtime } from './runtime.js';

/** What DCSC's rules engine added, removed or substituted, plus its rule messages verbatim. */
export function explainConfiguration(session: ConfigSession, sinceRevision?: number) {
  const snapshots = session.snapshots;
  const baseline = sinceRevision !== undefined
    ? snapshots.find((s) => s.revision === sinceRevision)
    : snapshots[snapshots.length - 1];

  const messages = (
    (session.raw as {
      expansionMessages?: Array<{ type?: string; text?: string; code?: string; sectionName?: string }>;
    }).expansionMessages ?? []
  ).map((m) => ({
    severity: m.type ?? 'info',
    ...(m.code !== undefined ? { code: m.code } : {}),
    ...(m.sectionName !== undefined ? { section: m.sectionName } : {}),
    message: m.text ?? String(m),
  }));

  const lastIntent = session.intents[session.intents.length - 1];

  if (!baseline) {
    return {
      ruleMessages: messages,
      note:
        'No earlier revision is retained, so only the current rule messages are available. ' +
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
    note:
      'Entries flagged "auto" were chosen by DCSC, not requested. Rule messages are the engine\'s ' +
      'own words for the constraint it applied.',
  };
}

function productCodeOf(session: ConfigSession): string {
  const code = session.raw.code;
  return typeof code === 'string' && code ? code : session.product.code;
}

export type RecommendationKind = 'subtab' | 'summary' | 'smart-lfo';

export async function configurationRecommendations(rt: Runtime, session: ConfigSession, kind: RecommendationKind, country?: string) {
  const ctx = rt.newCtx({ locale: session.locale, solution: session.solution });
  const code = productCodeOf(session);
  if (kind === 'subtab') {
    const recommendations = await fetchSubTabRecommendations(rt.http, ctx, 'CTO', code);
    return { kind, productCode: code, count: recommendations.length, recommendations };
  }
  if (kind === 'smart-lfo') {
    const resolvedCountry = (country ?? ctx.locale.country ?? 'US').toUpperCase();
    const result = await fetchSmartLfoRecommendation(rt.http, ctx, resolvedCountry, code);
    return { kind, country: resolvedCountry, ctoCode: code, result };
  }
  const features: Array<{ code: string; quantity?: number }> = [];
  for (const tab of session.raw.tabs ?? []) {
    for (const subTab of tab.subTabs ?? []) {
      for (const sec of subTab.sections ?? []) {
        for (const res of sec.results ?? []) {
          if (res.code) features.push({ code: res.code, quantity: res.quantity ?? 1 });
        }
      }
    }
  }
  const payload: SummaryRecommendationPayload = {
    selectedProductDataLists: [[{ code, id: session.id, quantity: session.raw.quantity ?? 1, features }]],
  };
  const result = await fetchSummaryRecommendations(rt.http, ctx, payload);
  return { kind, ctoCode: code, result };
}

/** Upstream feature specs: lead times, lifecycle dates, top-choice flags and price breakdown. */
export async function upstreamFeatureSpecs(rt: Runtime, session: ConfigSession, codes: string[]) {
  const ctx = rt.newCtx({ locale: session.locale, solution: session.solution });
  const raw = await fetchUpstreamFeatureDetails(rt.http, ctx, productCodeOf(session), session.id, codes);
  return raw.map(summarizeFeatureSpec);
}

export async function configurationRuleVersions(rt: Runtime, ctoCode: string, tableCode?: string) {
  const info = await fetchRuleVersionsInfo(rt.http, await rt.ctxEnsuringSolution(), {
    ctoCode,
    tableCode,
  });
  return { ctoCode: info.ctoCode, versions: info.versions, tableCode: info.tableCode, ruleVersions: info.ruleVersions };
}
