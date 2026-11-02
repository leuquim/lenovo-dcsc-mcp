export interface ValueDigest {
    /** sha256 of the value's JSON text. */
    hash: string;
    /** Size of that JSON text in bytes. */
    bytes: number;
}
export declare function sha256Hex(data: string | Buffer): string;
export declare function canonicalJson(value: unknown): string;
/**
 * Digest of a value that is immutable once it is part of a published workspace,
 * a history entry or a snapshot. The digest is cached per object, so a value
 * mutated after it was digested must be passed to forgetDigest first.
 */
export declare function digestOf(value: object): ValueDigest;
export declare function forgetDigest(value: object): void;
/** Equality by content for immutable values; `undefined` equals only `undefined`. */
export declare function sameValue(left: unknown, right: unknown): boolean;
/** Published values are shared with history and cached by digest, so they must never change in place. */
export declare function deepFreeze<T>(value: T): T;
