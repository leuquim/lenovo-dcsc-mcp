import type { SolutionContext } from '../config/schema.js';
import type { Catalog } from '../domain/catalog.js';
import type { SolutionModeInfo } from '../domain/context.js';
import type { RequestCtx } from '../http/request.js';
import type { RawConfiguration } from '../model/types.js';
/**
 * The swap seam.
 *
 * Lenovo runs an internal, partner-gated DCSC API programme (release notes
 * reference "full and key-feature DCSC configuration API response modes" and a
 * "Public-to-APIH" integration). If credentials are ever granted, that becomes
 * a second implementation of this interface and nothing above it changes.
 *
 * The interface is deliberately expressed in DOMAIN operations, never HTTP —
 * an official API would replace the whole transport, not the plumbing. There is
 * intentionally no generic HttpClient interface, no endpoint DSL, no DI
 * container and no auth abstraction: those would be speculative today and would
 * rot before they were needed.
 */
/**
 * Capabilities callers branch on.
 *
 * Branching on `capabilities.has(...)` rather than on `transport.id` is what
 * actually buys forward-compatibility; the interface alone does not.
 */
export type Capability = 
/** Rack diagram PNG. Needs a browser to render, so never available here. */
'rackDiagramImage'
/** List pricing without a login. */
 | 'anonymousPricing'
/** Partner/bid pricing. Requires a Lenovo ID. */
 | 'netPricing'
/** Server-side saved configurations and config IDs. Requires a Lenovo ID. */
 | 'savedConfigs'
/** 13-week supply status. Requires a separate token. */
 | 'supplyStatus'
/** Change selections on an existing configuration. */
 | 'mutation'
/** Export the XML/XLS ZIP. */
 | 'exportZip'
/** Import a previously exported XML. */
 | 'importXml' | 'clusterMode' | 'powerReport';
export interface LaunchRequest {
    productCode: string;
    mode: 'cto' | 'lfo' | 'lfo-as-cto' | 'lfo-add-options';
    solution: SolutionContext;
}
export interface DcscTransport {
    readonly id: 'reverse-engineered' | 'official';
    readonly capabilities: ReadonlySet<Capability>;
    listSolutionModes(ctx: RequestCtx): Promise<SolutionModeInfo[]>;
    browseCatalog(ctx: RequestCtx, solution: SolutionContext): Promise<Catalog>;
    launchConfiguration(ctx: RequestCtx, req: LaunchRequest): Promise<RawConfiguration>;
}
/**
 * What the reverse-engineered transport can actually do today.
 *
 * `mutation` and `exportZip` are absent on purpose: the mutation endpoint
 * contract is only partly recovered, and export currently returns a valid but
 * empty archive. Claiming them here would let callers promise the user a
 * result the transport cannot deliver.
 */
export declare const REVERSE_ENGINEERED_CAPABILITIES: ReadonlySet<Capability>;
