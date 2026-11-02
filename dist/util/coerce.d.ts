export type Obj = Record<string, unknown>;
/** A plain JSON object: non-null, not an array. */
export declare function isObject(value: unknown): value is Obj;
export declare function objectOrEmpty(value: unknown): Obj;
export declare function objectOrUndefined(value: unknown): Obj | undefined;
/** The plain-object elements of an array; anything else yields []. */
export declare function objectItems(value: unknown): Obj[];
export declare function stringOrEmpty(value: unknown): string;
/** A string other than ''; whitespace-only strings are kept. */
export declare function nonEmptyString(value: unknown): string | undefined;
/** A string with non-whitespace content, returned untrimmed. */
export declare function nonBlankString(value: unknown): string | undefined;
/** A non-empty string, or a finite number rendered as text. */
export declare function nonEmptyStringOrNumberText(value: unknown): string | undefined;
/** Numbers only; strings are not parsed. */
export declare function finiteNumber(value: unknown): number | undefined;
/** Numbers or numeric strings; blank strings are rejected. */
export declare function numericValue(value: unknown): number | undefined;
/** Numbers or numeric strings; a blank string coerces to 0 (rack wire semantics). */
export declare function numericValueBlankAsZero(value: unknown): number | undefined;
export declare function positiveSafeInteger(value: unknown): number | undefined;
export declare function requirePositiveSafeInteger(value: number, name: string): number;
export declare function errorMessage(error: unknown): string;
