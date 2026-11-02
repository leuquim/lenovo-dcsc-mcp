/** Configuration sessions embed the product code: `sess_<code>_<suffix>`. */
export declare function newId(kind: 'sess', productCode: string): string;
export declare function newId(kind: 'ws' | 'rack' | 'cable' | 'floor'): string;
