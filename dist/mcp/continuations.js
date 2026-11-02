/** Internal continuations carry flat dcsc_workspace_get arguments; the tool takes the read selector under `view`. */
export function nestWorkspaceGetContinuations(value) {
    if (Array.isArray(value))
        return value.map(nestWorkspaceGetContinuations);
    if (value === null || typeof value !== 'object')
        return value;
    const record = value;
    const args = record['arguments'];
    if (record['tool'] === 'dcsc_workspace_get' && args !== null && typeof args === 'object'
        && typeof args['view'] !== 'object') {
        const { session, expectedRevision, view, ...rest } = args;
        return { ...record, arguments: {
                session, ...(expectedRevision !== undefined ? { expectedRevision } : {}),
                view: { kind: view ?? 'summary', ...rest },
            } };
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, nestWorkspaceGetContinuations(entry)]));
}
//# sourceMappingURL=continuations.js.map