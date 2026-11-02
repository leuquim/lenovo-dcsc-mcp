import { ulid } from 'ulid';
const SUFFIX_LENGTH = { sess: 6, ws: 8, rack: 6, cable: 6, floor: 6 };
function suffix(length) {
    return ulid().slice(-length).toLowerCase();
}
export function newId(kind, productCode) {
    const body = suffix(SUFFIX_LENGTH[kind]);
    return kind === 'sess' ? `sess_${productCode}_${body}` : `${kind}_${body}`;
}
//# sourceMappingURL=ids.js.map