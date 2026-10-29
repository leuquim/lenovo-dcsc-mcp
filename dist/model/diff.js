import { projectConstraints } from './project.js';
function describe(index, code) {
    const hit = index.byCode.get(code)?.[0];
    const text = hit?.description ?? '';
    const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return clean.length <= 70 ? clean : `${clean.slice(0, 69)}…`;
}
function round(n) {
    return Math.round(n * 100) / 100;
}
export function diffConfigurations(opts) {
    const before = opts.beforeIndex.selected;
    const after = opts.afterIndex.selected;
    const added = [];
    const removed = [];
    const quantityChanged = [];
    let autoChanges = 0;
    const mark = (code) => {
        const auto = !opts.requested.has(code);
        if (auto)
            autoChanges += 1;
        return auto;
    };
    for (const [code, qty] of after) {
        const prior = before.get(code);
        if (prior === undefined) {
            const auto = mark(code);
            added.push({ code, desc: describe(opts.afterIndex, code), qty, ...(auto ? { auto } : {}) });
        }
        else if (prior !== qty) {
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
    const replaced = [];
    const sectionOf = (index, code) => index.byCode.get(code)?.[0]?.section;
    for (let i = removed.length - 1; i >= 0; i -= 1) {
        const gone = removed[i];
        if (!gone)
            continue;
        const section = sectionOf(opts.beforeIndex, gone.code);
        if (section === undefined)
            continue;
        const replacementIdx = added.findIndex((a) => sectionOf(opts.afterIndex, a.code) === section);
        if (replacementIdx === -1)
            continue;
        const incoming = added[replacementIdx];
        if (!incoming)
            continue;
        replaced.push({
            from: gone.code,
            to: incoming.code,
            desc: incoming.desc,
            section: opts.afterIndex.sectionById.get(section)?.title ?? section,
        });
        if (gone.auto)
            autoChanges -= 1;
        if (incoming.auto)
            autoChanges -= 1;
        removed.splice(i, 1);
        added.splice(replacementIdx, 1);
    }
    const priceBefore = opts.beforeRaw.totalPrice ?? 0;
    const priceAfter = opts.afterRaw.totalPrice ?? 0;
    return {
        added,
        removed,
        replaced,
        quantityChanged,
        price: {
            before: round(priceBefore),
            after: round(priceAfter),
            delta: round(priceAfter - priceBefore),
            currency: opts.currency,
        },
        constraints: projectConstraints(opts.afterRaw),
        autoChanges,
    };
}
//# sourceMappingURL=diff.js.map