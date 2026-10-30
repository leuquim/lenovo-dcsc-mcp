import type { DcscHttpClient, RequestCtx } from '../http/request.js';

type Obj = Record<string, unknown>;
export type ReferenceView = 'categories' | 'category' | 'solutions' | 'popular' | 'validation';
export interface ReferenceQuery {
  view: ReferenceView;
  catalog?: 'deployment-ready' | 'truscale' | undefined;
  categoryId?: string | undefined;
  crnId?: string | undefined;
}

export function referenceId(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error(`Use an exact ${label} returned by the reference-solution catalog.`);
  return value;
}

export function referencePath(query: ReferenceQuery): string {
  switch (query.view) {
    case 'categories': return query.catalog === 'truscale' ? '/reference_solution/category_vc' : '/reference_solution/category_drs';
    case 'category': return `/reference_solution/categories/${referenceId(query.categoryId, 'categoryId')}`;
    case 'solutions': return `/reference_solution/categories/${referenceId(query.categoryId, 'categoryId')}/CRNs`;
    case 'popular': return '/reference_solution/new_or_popular_CRNs';
    case 'validation': return `/reference_solution/CRNs/${referenceId(query.crnId, 'crnId')}/validate`;
  }
}

export async function fetchReferenceSolutions(http: DcscHttpClient, ctx: RequestCtx, query: ReferenceQuery): Promise<unknown> {
  const response = await http.send({ endpoint: `reference_${query.view}`, method: 'GET', path: referencePath(query),
    responseKind: 'json', timeoutClass: query.view === 'validation' ? 'heavy' : 'fast', ctx });
  return response.raw;
}

/** The website only downloads SUCCESS; invalid templates go through Customize. */
export async function downloadReferenceSolution(http: DcscHttpClient, ctx: RequestCtx, crnId: string, maxBytes: number): Promise<Buffer> {
  const id = referenceId(crnId, 'crnId');
  const validation = await fetchReferenceSolutions(http, ctx, { view: 'validation', crnId: id });
  const status = validation && typeof validation === 'object' ? (validation as Obj)['type'] : undefined;
  if (status !== 'SUCCESS') {
    throw new Error(`Lenovo did not approve original-template download (${String(status ?? 'unknown status')}). Use dcsc_launch_reference_solution to customize and inspect the design.`);
  }
  const response = await http.send({ endpoint: 'reference_download', method: 'GET',
    path: `/reference_solution/CRNs/${id}/download`, responseKind: 'stream', timeoutClass: 'export', ctx });
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new Error(`Reference download exceeded the configured limit of ${maxBytes} bytes.`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

/** Keep native fields while exposing category IDs without a deep tree crawl. */
export function referenceRows(raw: unknown, view: ReferenceView): Obj[] {
  const object = (value: unknown): Obj => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DCSC returned an invalid reference-solution catalog row.');
    return value as Obj;
  };
  if (view !== 'categories') return Array.isArray(raw) ? raw.map(object) : [object(raw)];
  const result: Obj[] = [];
  const visit = (value: unknown, ancestors: string[]): void => {
    const node = object(value);
    const breadcrumb = [...ancestors, String(node['name'] ?? node['id'] ?? '')];
    const { children, ...fields } = node;
    result.push({ ...fields, breadcrumb, childIds: Array.isArray(children) ? children.map(c => object(c)['id']) : [] });
    if (Array.isArray(children)) for (const child of children) visit(child, breadcrumb);
  };
  for (const root of Array.isArray(raw) ? raw : [raw]) visit(root, []);
  return result;
}
