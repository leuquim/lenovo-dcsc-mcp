import type { DcscHttpClient, RequestCtx } from '../http/request.js';
import type { Obj } from '../util/coerce.js';
export type ReferenceView = 'categories' | 'category' | 'solutions' | 'popular' | 'validation' | 'promotions' | 'promotion-sids' | 'promotion-lfos';
export interface ReferenceQuery {
    view: ReferenceView;
    catalog?: 'deployment-ready' | 'truscale' | 'promotion' | undefined;
    categoryId?: string | undefined;
    crnId?: string | undefined;
}
export declare function referenceId(value: string | undefined, label: string): string;
export declare function referencePath(query: ReferenceQuery): string;
export declare function fetchReferenceSolutions(http: DcscHttpClient, ctx: RequestCtx, query: ReferenceQuery): Promise<unknown>;
/** The website only downloads SUCCESS; invalid templates go through Customize. */
export declare function downloadReferenceSolution(http: DcscHttpClient, ctx: RequestCtx, crnId: string, maxBytes: number): Promise<Buffer>;
/** Keep native fields while exposing category IDs without a deep tree crawl. */
export declare function referenceRows(raw: unknown, view: ReferenceView): Obj[];
