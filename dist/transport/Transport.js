/**
 * What the reverse-engineered transport can actually do today.
 *
 * `mutation` and `exportZip` are absent on purpose: the mutation endpoint
 * contract is only partly recovered, and export currently returns a valid but
 * empty archive. Claiming them here would let callers promise the user a
 * result the transport cannot deliver.
 */
export const REVERSE_ENGINEERED_CAPABILITIES = new Set([
    'anonymousPricing',
    'powerReport',
]);
//# sourceMappingURL=Transport.js.map