import { createHash } from 'node:crypto';
const digests = new WeakMap();
export function sha256Hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
export function canonicalJson(value) {
    return JSON.stringify(value);
}
/**
 * Digest of a value that is immutable once it is part of a published workspace,
 * a history entry or a snapshot. The digest is cached per object, so a value
 * mutated after it was digested must be passed to forgetDigest first.
 */
export function digestOf(value) {
    let digest = digests.get(value);
    if (digest === undefined) {
        const json = canonicalJson(value);
        digest = { hash: sha256Hex(json), bytes: Buffer.byteLength(json) };
        digests.set(value, digest);
    }
    return digest;
}
export function forgetDigest(value) {
    digests.delete(value);
}
/** Equality by content for immutable values; `undefined` equals only `undefined`. */
export function sameValue(left, right) {
    if (left === right)
        return true;
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
        return false;
    }
    return digestOf(left).hash === digestOf(right).hash;
}
/** Published values are shared with history and cached by digest, so they must never change in place. */
export function deepFreeze(value) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
    }
    return value;
}
//# sourceMappingURL=valueDigest.js.map