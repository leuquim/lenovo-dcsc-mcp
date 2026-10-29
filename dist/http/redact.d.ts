/**
 * Redacts an upstream error body for logging.
 *
 * Returns a stable hash alongside the redacted text so recurring identical
 * 500s stay recognisable without retaining their content.
 */
export declare function redactBody(raw: string): {
    text: string;
    hash: string;
};
/**
 * Redacts a value of unknown shape (string, Buffer, parsed JSON) for logging.
 */
export declare function redactUnknown(raw: unknown): {
    text: string;
    hash: string;
};
