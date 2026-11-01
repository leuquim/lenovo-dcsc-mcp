import { createHash } from 'node:crypto';

export interface ValueDigest {
  /** sha256 of the value's JSON text. */
  hash: string;
  /** Size of that JSON text in bytes. */
  bytes: number;
}

const digests = new WeakMap<object, ValueDigest>();

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Digest of a value that is immutable once it is part of a published workspace,
 * a history entry or a snapshot. The digest is cached per object, so a value
 * mutated after it was digested must be passed to forgetDigest first.
 */
export function digestOf(value: object): ValueDigest {
  let digest = digests.get(value);
  if (digest === undefined) {
    const json = canonicalJson(value);
    digest = { hash: sha256Hex(json), bytes: Buffer.byteLength(json) };
    digests.set(value, digest);
  }
  return digest;
}

export function forgetDigest(value: object): void {
  digests.delete(value);
}

/** Equality by content for immutable values; `undefined` equals only `undefined`. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  return digestOf(left).hash === digestOf(right).hash;
}
