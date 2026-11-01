export type Obj = Record<string, unknown>;

/** A plain JSON object: non-null, not an array. */
export function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function objectOrEmpty(value: unknown): Obj {
  return isObject(value) ? value : {};
}

export function objectOrUndefined(value: unknown): Obj | undefined {
  return isObject(value) ? value : undefined;
}

/** The plain-object elements of an array; anything else yields []. */
export function objectItems(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A string other than ''; whitespace-only strings are kept. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A string with non-whitespace content, returned untrimmed. */
export function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A non-empty string, or a finite number rendered as text. */
export function nonEmptyStringOrNumberText(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/** Numbers only; strings are not parsed. */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Numbers or numeric strings; blank strings are rejected. */
export function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

/** Numbers or numeric strings; a blank string coerces to 0 (rack wire semantics). */
export function numericValueBlankAsZero(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

export function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
