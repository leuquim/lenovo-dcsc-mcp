export interface ParsedCfxmlItem {
    code: string;
    quantity: number;
    description?: string;
    character?: string;
}
export interface ParsedCfxmlConfiguration {
    productCode: string;
    solutionMode: string;
    quantity: number;
    description?: string;
    selections: ParsedCfxmlItem[];
}
export interface ParsedCfxmlSolution {
    solutionMode: string;
    configurations: ParsedCfxmlConfiguration[];
}
export declare function sanitiseProductCode(raw: string): string;
/**
 * Parses Lenovo CFXML string into structured configuration product lines and feature selections.
 */
export declare function parseCfxml(xmlContent: string): ParsedCfxmlSolution;
