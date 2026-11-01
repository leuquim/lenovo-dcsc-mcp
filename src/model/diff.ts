import type { ConfigIndex } from './index.js';
import type { RawConfiguration } from './types.js';
import { configurationListPrice } from '../domain/pricing.js';
import { projectConstraints, type Constraint } from './project.js';

/**
 * Diff between two configuration revisions.
 *
 * Computed from our own before/after selection sets rather than DCSC's
 * `addedParts` / `removedParts` arrays: those reflect only the last internal
 * reconciliation step and miss changes made earlier in the same pass.
 *
 * A mutation returns this instead of the tree — roughly 1 KB for a change that
 * can rewrite a third of the configuration.
 */

export interface PartChange {
  code: string;
  desc: string;
  qty?: number;
  from?: number;
  to?: number;
  /** True when DCSC made this change itself rather than the caller asking. */
  auto?: boolean;
}

export interface Replacement {
  from: string;
  to: string;
  desc: string;
  section: string;
}

export interface ConfigDiff {
  added: PartChange[];
  removed: PartChange[];
  /** Swaps within one section — the expected result of a choose-one change. */
  replaced: Replacement[];
  quantityChanged: PartChange[];
  price: {
    before: number | null;
    after: number | null;
    delta: number | null;
    currency: string;
  };
  constraints: Constraint[];
  autoChanges: number;
}

function describe(index: ConfigIndex, code: string): string {
  const hit = index.byCode.get(code)?.[0];
  const text = hit?.description ?? '';
  const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return clean.length <= 70 ? clean : `${clean.slice(0, 69)}…`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function diffConfigurations(opts: {
  beforeIndex: ConfigIndex;
  afterIndex: ConfigIndex;
  beforeRaw: RawConfiguration;
  afterRaw: RawConfiguration;
  currency: string;
  /** Codes the caller explicitly asked for; everything else is flagged auto. */
  requested: ReadonlySet<string>;
}): ConfigDiff {
  const before = opts.beforeIndex.selected;
  const after = opts.afterIndex.selected;

  const added: PartChange[] = [];
  const removed: PartChange[] = [];
  const quantityChanged: PartChange[] = [];
  let autoChanges = 0;

  const mark = (code: string): boolean => {
    const auto = !opts.requested.has(code);
    if (auto) autoChanges += 1;
    return auto;
  };

  for (const [code, qty] of after) {
    const prior = before.get(code);
    if (prior === undefined) {
      const auto = mark(code);
      added.push({ code, desc: describe(opts.afterIndex, code), qty, ...(auto ? { auto } : {}) });
    } else if (prior !== qty) {
      const auto = mark(code);
      quantityChanged.push({
        code,
        desc: describe(opts.afterIndex, code),
        from: prior,
        to: qty,
        ...(auto ? { auto } : {}),
      });
    }
  }

  for (const [code, qty] of before) {
    if (!after.has(code)) {
      const auto = mark(code);
      removed.push({
        code,
        desc: describe(opts.beforeIndex, code),
        qty,
        ...(auto ? { auto } : {}),
      });
    }
  }

  // A code vanishing while another appears in the SAME section is a swap, not
  // an unexplained removal. Reporting it as an "auto change" would cry wolf on
  // every ordinary choose-one edit and erode trust in the genuine warnings.
  const replaced: Replacement[] = [];
  const sectionOf = (index: ConfigIndex, code: string): string | undefined =>
    index.byCode.get(code)?.[0]?.section;

  for (let i = removed.length - 1; i >= 0; i -= 1) {
    const gone = removed[i];
    if (!gone) continue;
    const section = sectionOf(opts.beforeIndex, gone.code);
    if (section === undefined) continue;

    const replacementIdx = added.findIndex(
      (a) => sectionOf(opts.afterIndex, a.code) === section,
    );
    if (replacementIdx === -1) continue;

    const incoming = added[replacementIdx];
    if (!incoming) continue;

    replaced.push({
      from: gone.code,
      to: incoming.code,
      desc: incoming.desc,
      section: opts.afterIndex.sectionById.get(section)?.title ?? section,
    });
    if (gone.auto) autoChanges -= 1;
    if (incoming.auto) autoChanges -= 1;
    removed.splice(i, 1);
    added.splice(replacementIdx, 1);
  }

  const priceBefore = configurationListPrice(opts.beforeRaw);
  const priceAfter = configurationListPrice(opts.afterRaw);

  return {
    added,
    removed,
    replaced,
    quantityChanged,
    price: {
      before: priceBefore,
      after: priceAfter,
      delta: priceBefore === null || priceAfter === null ? null : round(priceAfter - priceBefore),
      currency: opts.currency,
    },
    constraints: projectConstraints(opts.afterRaw),
    autoChanges,
  };
}
