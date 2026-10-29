/** Lossless, bounded navigation for retained upstream reports and recovery state. */
export function projectJsonPage(source, options) {
    let value = source;
    for (const key of options.path) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
            throw new Error(`Unknown report path ${options.path.join('.')}.`);
        }
        value = value[key];
    }
    const pathArgument = options.pathArgument ?? 'path';
    const args = { ...options.arguments, [pathArgument]: options.path, limit: options.limit };
    const next = (offset) => ({ tool: options.tool, arguments: { ...args, offset } });
    if (typeof value === 'string') {
        const text = value.slice(options.offset, options.offset + Math.min(options.limit, 1000));
        return { path: options.path, offset: options.offset, total: value.length, text,
            ...(options.offset + text.length < value.length ? { next: next(options.offset + text.length) } : {}) };
    }
    const entries = value && typeof value === 'object' ? Object.entries(value) : [['value', value]];
    const page = entries.slice(options.offset, options.offset + Math.min(options.limit, 50)).map(([key, entry]) => {
        const large = Buffer.byteLength(JSON.stringify(entry) ?? '') > 1000;
        return large ? { key, type: Array.isArray(entry) ? 'array' : typeof entry,
            next: { tool: options.tool, arguments: { ...args, [pathArgument]: [...options.path, key], offset: 0,
                    ...(typeof entry === 'string' ? { limit: 1000 } : {}) } } }
            : { key, value: entry };
    });
    const result = () => ({ path: options.path, offset: options.offset, total: entries.length, returned: page.length,
        items: page, ...(options.offset + page.length < entries.length ? { next: next(options.offset + page.length) } : {}) });
    while (Buffer.byteLength(JSON.stringify(result(), null, 2)) > 7500 && page.length > 1)
        page.pop();
    if (Buffer.byteLength(JSON.stringify(result(), null, 2)) > 7500)
        throw new Error('Report path exceeds the response budget. Inspect a parent path.');
    return result();
}
//# sourceMappingURL=pagedJson.js.map